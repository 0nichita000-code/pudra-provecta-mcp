import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";


const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(ROOT, "state.json");
const BASE = "https://provectapos.com";
const USER = process.env.PROVECTA_USERNAME || "";
const PASS = process.env.PROVECTA_PASSWORD || "";
const LIVE = process.env.PHOTO_LIVE === "true";
const LIMIT = Math.min(10, Math.max(1, Number(process.env.PHOTO_BATCH_SIZE || 3)));
const MAX_LOOKUPS = LIMIT * 20;
const RETRY_AFTER_MS = 30 * 86400000;
const MAX_IMAGE_BYTES = 6_000_000;
const STOP = new Set(["and","the","face","for","with","item","no","new","color","set","ml","ton","women","men","asortiment","mix","pcs","buc","sau","long","lasting","makeup","lip","eye","50","100","20","40","60"]);
const BAD_HOSTS = /(^|\.)((google|bing|yandex|facebook|instagram|pinterest|aliexpress|alibaba|tiktok|youtube)\.)/i;

export function nameTokens(name) {
  return [...new Set(String(name || "").toUpperCase().match(/[A-Z0-9]{3,}/g) || [])]
    .filter(x => !STOP.has(x.toLowerCase()) && !/^\d{1,3}$/.test(x));
}
export function isMatchingProductPage(html, item) {
  const text = String(html || "").replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]*>/g," ")
    .replace(/&(?:nbsp|amp|quot);/gi," ").toUpperCase();
  if (!item.barcode || !text.includes(item.barcode)) return false;
  const tokens = nameTokens(item.name);
  if (tokens.length < 2) return false;
  const matches = tokens.filter(t => text.includes(t));
  return matches.length >= 2 && (matches.length / tokens.length >= 0.34);
}
function decodeEntities(x) {
  return String(x || "").replace(/&amp;/g,"&").replace(/&quot;/g,'"')
    .replace(/&#x([0-9a-f]+);/gi,(_,a)=>String.fromCodePoint(parseInt(a,16)))
    .replace(/&#([0-9]+);/g,(_,a)=>String.fromCodePoint(Number(a)));
}
export function ogImage(html, pageUrl) {
  const tags = String(html || "").match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/(?:og:image|twitter:image)/i.test(tag)) continue;
    const m = tag.match(/\bcontent\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    if (!m) continue;
    try {
      const url = new URL(decodeEntities(m[1] || m[2] || m[3]),pageUrl);
      if (url.protocol === "https:" && !/logo|favicon|placeholder|default|sprite|icon/i.test(url.pathname)) return url.toString();
    } catch {}
  }
  return null;
}
function sanitizeLinks(urls) {
  const result=[];
  for(const value of urls) {
    try {
      const url=new URL(value);
      if(url.protocol!=="https:")continue;
      if(BAD_HOSTS.test(url.hostname)||url.pathname.includes("/search"))continue;
      if(/\.(pdf|zip|docx?|xml)$/i.test(url.pathname))continue;
      if(!result.includes(url.toString()))result.push(url.toString());
    } catch {}
  }
  return result.slice(0,12);
}
async function searchUrls(context, barcode, name) {
  const p=await context.newPage();
  const found=[];
  const queries=[
    "https://www.google.com/search?num=8&q="+encodeURIComponent('"'+barcode+'" '+nameTokens(name).slice(0,3).join(" ")),
    "https://www.bing.com/search?q="+encodeURIComponent('"'+barcode+'" '+nameTokens(name).slice(0,3).join(" "))
  ];
  try {
    for(const url of queries){
      try {
        await p.goto(url,{waitUntil:"domcontentloaded",timeout:20000});
        await p.waitForTimeout(1000);
        const links=await p.locator("a[href]").evaluateAll(nodes=>nodes.map(a=>a.href));
        for(let u of links){
          try{
            const parsed=new URL(u);
            if(parsed.hostname.includes("google")&&parsed.pathname==="/url"){
              u=parsed.searchParams.get("q")||u;
            }
            found.push(u);
          }catch{}
        }
        if(sanitizeLinks(found).length>=5)break;
      }catch{}
    }
  }finally{await p.close().catch(()=>{});}
  return sanitizeLinks(found);
}
async function fetchCandidate(context,url,item) {
  try{
    const response=await context.request.get(url,{timeout:12000,maxRedirects:3});
    if(!response.ok())return null;
    const mime=response.headers()["content-type"]||"";
    if(!mime.includes("text/html"))return null;
    const html=(await response.text()).slice(0,2_000_000);
    if(!isMatchingProductPage(html,item))return null;
    const imageUrl=ogImage(html,url);
    if(!imageUrl)return null;
    const u=new URL(imageUrl);
    if(BAD_HOSTS.test(u.hostname))return null;
    const img=await context.request.get(imageUrl,{timeout:12000,maxRedirects:3});
    if(!img.ok())return null;
    const imageType=img.headers()["content-type"]||"";
    if(!imageType.startsWith("image/")||/svg/i.test(imageType))return null;
    const length=Number(img.headers()["content-length"]||0);
    if(length>MAX_IMAGE_BYTES)return null;
    const body=await img.body();
    if(body.length<5000||body.length>MAX_IMAGE_BYTES)return null;
    return {imageUrl,pageUrl:url,match:"exact barcode on source page + product name"};
  }catch{return null;}
}
async function discover(context,item) {
  const links=await searchUrls(context,item.barcode,item.name);
  for(const link of links.slice(0,7)){
    const c=await fetchCandidate(context,link,item);
    if(c)return c;
  }
  return null;
}
async function apiJson(url,init={}) {
  const res=await fetch(url,{...init,signal:AbortSignal.timeout(40000)});
  const raw=await res.text();
  if(!res.ok())throw new Error("Provecta API HTTP "+res.status+" "+raw.slice(0,150));
  return JSON.parse(raw);
}
async function getCatalog() {
  let auth;
  const url=BASE+"/proxy/api/v1/framework/common/login";
  const variants=[
    {headers:{"Content-Type":"application/json"},body:JSON.stringify({username:USER,password:PASS})},
    {headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({username:USER,password:PASS}).toString()}
  ];
  for(const v of variants) {
    try {
      auth=await apiJson(url,{method:"POST",headers:v.headers,body:v.body});
      if(auth.token||auth.Token)break;
    }catch{}
  }
  if(!auth?.token&&!auth?.Token)throw new Error("No working Provecta API login; check credentials");
  const token=auth.token||auth.Token;
  const clients=auth.clients||auth.Clients||[];
  const client=process.env.PROVECTA_CLIENT_ID||clients[0]?.Id||clients[0]?.id||clients[0];
  if(!client)throw new Error("No Provecta client; select correct FAMILYTURCOMPANY client");
  const result=await apiJson(BASE+"/proxy/api/v1/stock/article/select",{
    headers:{"Authorization":"Bearer "+token,"Client":String(client),"Accept":"application/json"}
  });
  const rows=Array.isArray(result)?result:result.content||result.items||[];
  return rows.filter(x=>!x.DeletedOn&&!x.deletedOn).map(x=>({
    id:String(x.Id||x.id||""),barcode:String(x.Barcode||x.barcode||"").trim(),
    name:String(x.Name||x.name||""),code:String(x.Code||x.code||"")
  })).filter(x=>x.id&&/^\d{8,14}$/.test(x.barcode)&&nameTokens(x.name).length>=2);
}
async function loginUI(page){
  await page.goto(BASE+"/app/",{waitUntil:"domcontentloaded",timeout:45000});
  await page.waitForTimeout(2500);
  const pass=page.locator('input[type="password"]').first();
  if(await pass.isVisible().catch(()=>false)){
    const user=page.locator('input[type="text"]:visible,input[type="email"]:visible').first();
    if(!(await user.count()))throw new Error("UI login username field not found");
    await user.fill(USER);
    await pass.fill(PASS);
    const submit=page.locator('button[type="submit"],button:has-text("Login"),button:has-text("Log in"),button:has-text("Войти")').first();
    if(await submit.count())await submit.click();
    else await pass.press("Enter");
    await page.waitForTimeout(3500);
  }
  if(await page.locator('input[type="password"]').first().isVisible().catch(()=>false)){
    throw new Error("Provecta browser login failed or requires additional step");
  }
  if(await page.getByText("FAMILYTURCOMPANY",{exact:true}).first().isVisible().catch(()=>false)){
    const company=page.getByText("FAMILYTURCOMPANY",{exact:true}).first();
    const choose=page.getByText("Select",{exact:true}).first();
    if(await choose.isVisible().catch(()=>false))await company.click().catch(()=>{});
  }
  const pageText=await page.locator("body").innerText().catch(()=>"");
  if(!/FAMILYTURCOMPANY|PUDRA COMPANY/i.test(pageText)){
    // The company header can be hidden before a company is selected. Fail safely.
    throw new Error("FAMILYTURCOMPANY account is not confirmed in browser");
  }
}
async function openImages(page,item) {
  await page.goto(BASE+"/app/#/product/0?productid="+encodeURIComponent(item.id),{waitUntil:"domcontentloaded",timeout:45000});
  await page.waitForTimeout(1300);
  if(await page.locator('input[type="password"]').first().isVisible().catch(()=>false))throw new Error("Browser session expired");
  let tab=page.getByRole("tab",{name:/images/i}).first();
  if(!(await tab.count()))tab=page.getByText("Images",{exact:true}).first();
  if(!(await tab.count()))throw new Error("Images tab not found");
  await tab.click();
  await page.waitForTimeout(600);
  const text=(await page.locator("body").innerText()).slice(-8000);
  const images=await page.locator(".swiper-container.well img[src],.swiper-container .swiper-slide img[src]").count();
  if(images>0)return "exists";
  if(!/\b0\s*\/\s*0\b/.test(text)&&!/\b0\s+of\s+0\b/i.test(text)){
    throw new Error("Image gallery not clearly empty; skipped for safety");
  }
  return "empty";
}
async function upload(page,url) {
  const button=page.getByRole("button",{name:/^upload$/i}).first();
  if(await button.count())await button.click();
  else await page.getByText("Upload",{exact:true}).first().click();
  const input=page.locator('input[name="imageurl"],input[placeholder="Paste link here"]').last();
  await input.waitFor({state:"visible",timeout:10000});
  await input.fill(url);
  const apply=page.getByRole("button",{name:/^apply$/i}).last();
  await apply.click();
  await page.waitForTimeout(1800);
  const save=page.getByRole("button",{name:/^save$/i}).first();
  if(!(await save.count()))throw new Error("Could not locate product Save button");
  await save.click();
  await page.waitForTimeout(1800);
  const errors=page.getByText(/error|failed|ошибка/i);
  if(await errors.first().isVisible().catch(()=>false))throw new Error("Provecta reported an upload/save error");
  // Do not reopen the card: on next batch, its gallery will be checked again.
}
async function loadState(){
  try{
    const x=JSON.parse(await fs.readFile(STATE_FILE,"utf8"));
    return {cursor:Number(x.cursor)||0,entries:x.entries||{},runs:x.runs||[]};
  }catch{return {cursor:0,entries:{},runs:[]};}
}
async function saveState(state) {
  await fs.writeFile(STATE_FILE,JSON.stringify(state,null,2)+"\n");
}
function checkedRecently(entry) {
  if(!entry)return false;
  if(entry.status==="exists"||entry.status==="saved")return true;
  return Date.now()-Date.parse(entry.at||"1970-01-01")<RETRY_AFTER_MS;
}
export async function run(){
  const state=await loadState(), now=new Date().toISOString();
  const log={at:now,mode:LIVE?"LIVE":"DRY_RUN",checked:0,found:0,saved:0,exists:0,skipped:0,errors:[]};
  if(!USER||!PASS){
    console.error("[PHOTO LOADER] Missing GitHub secrets PROVECTA_USERNAME / PROVECTA_PASSWORD");
    console.log(JSON.stringify({status:"NEEDS_CONFIGURATION",...log}));
    return;
  }
  const items=await getCatalog();
  if(!items.length)throw new Error("No Provecta products loaded");
  let browser;
  try{
    const {chromium}=await import("playwright");
    browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]});
    const context=await browser.newContext({locale:"ru-RU",viewport:{width:1440,height:900}});
    const page=await context.newPage();
    await loginUI(page);
    let visited=0;
    while(log.checked<LIMIT*10&&log.found<LIMIT&&visited<Math.min(items.length,MAX_LOOKUPS)){
      const index=state.cursor%items.length;
      const item=items[index];
      state.cursor=(index+1)%items.length;
      visited++;
      if(checkedRecently(state.entries[item.id]))continue;
      log.checked++;
      const e={at:new Date().toISOString(),barcode:item.barcode,name:item.name};
      try{
        const status=await openImages(page,item);
        if(status==="exists"){
          e.status="exists";log.exists++;
        }else{
          const candidate=await discover(context,item);
          if(!candidate){e.status="no_match";log.skipped++;}
          else{
            e.candidate=candidate;log.found++;
            if(LIVE){
              await upload(page,candidate.imageUrl);
              e.status="saved";log.saved++;
            }else{e.status="dry_run";log.skipped++;}
          }
        }
      }catch(err){
        e.status="error";e.error=String(err.message||err).slice(0,300);
        log.errors.push({barcode:item.barcode,error:e.error});
      }
      state.entries[item.id]=e;
      await saveState(state);
      console.log("[PHOTO LOADER]",JSON.stringify({barcode:item.barcode,status:e.status,source:e.candidate?.pageUrl||null}));
    }
    await context.close();
  }finally{
    if(browser)await browser.close();
    state.runs.unshift(log);state.runs=state.runs.slice(0,50);
    await saveState(state);
  }
  console.log("[PHOTO LOADER RESULT]",JSON.stringify(log));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  run().catch(e=>{console.error("[PHOTO LOADER FATAL]",String(e.stack||e));process.exitCode=1;});
}
