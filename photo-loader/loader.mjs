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
  const modelTokens=tokens.filter(t=>/[A-Z]+[0-9]{3,}|[0-9]{3,}[A-Z]+/.test(t));
  if(modelTokens.some(t=>!text.includes(t)))return false;
  const matches = tokens.filter(t => text.includes(t));
  return matches.length >= Math.min(3,tokens.length) && (matches.length / tokens.length >= 0.5);
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
  // One manually reviewed source for the pilot. The original retailer page
  // explicitly lists this exact EAN; the supplied photo shows the 144-star variant.
  const pilotEAN=String(process.env.PHOTO_PILOT_BARCODE||"").trim();
  const pilotURL=String(process.env.PHOTO_PILOT_IMAGE_URL||"").trim();
  const pilotPage=String(process.env.PHOTO_PILOT_SOURCE_PAGE||"").trim();
  if(pilotEAN && item.barcode===pilotEAN && pilotURL && pilotPage) {
    const uri=new URL(pilotURL);
    if(uri.protocol!=="https:")throw new Error("Pilot image must use HTTPS");
    const img=await context.request.get(uri.toString(),{timeout:15000,maxRedirects:3});
    const mime=img.headers()["content-type"]||"";
    const content=await img.body();
    if(!img.ok()||!mime.startsWith("image/")||/svg/i.test(mime)||content.length<5000||content.length>MAX_IMAGE_BYTES) {
      throw new Error("Pilot image URL not a valid raster product photo");
    }
    return {imageUrl:pilotURL,pageUrl:pilotPage,match:"manually verified exact EAN and 144-patch packaging"};
  }
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
  if(!res.ok)throw new Error("Provecta API HTTP "+res.status+" "+raw.slice(0,150));
  return JSON.parse(raw);
}
async function getCatalog() {
  // Use the same login variants as the existing working PUDRA Provecta service.
  // Do not print the credential-bearing URLs or login response.
  let auth=null;
  const failures=[];
  const usernames=[...new Set([USER,USER.toLowerCase()])];
  for(const username of usernames) {
    for(const variant of ["json-body","query-plain","query-json-header","form-body"]) {
      const url=new URL(BASE+"/proxy/api/v1/framework/common/login");
      const headers={"Accept":"application/json, */*"};
      const options={method:"POST",headers};
      if(variant==="json-body"){
        headers["Content-Type"]="application/json";
        options.body=JSON.stringify({username,password:PASS});
      } else if(variant==="form-body"){
        headers["Content-Type"]="application/x-www-form-urlencoded";
        options.body=new URLSearchParams({username,password:PASS}).toString();
      } else {
        url.searchParams.set("username",username);
        url.searchParams.set("password",PASS);
        if(variant==="query-json-header")headers["Content-Type"]="application/json";
      }
      try {
        auth=await apiJson(url.toString(),options);
        if(auth?.token||auth?.Token)break;
        failures.push(variant+": missing token");
      } catch(error) {
        const message=String(error?.message||error);
        const code=error?.cause?.code||error?.cause?.name||error?.cause?.message||error?.code||error?.message||error?.name||"network";
        const status=message.match(/HTTP\s+(\d+)/)?.[1] || String(code).replaceAll(PASS,"[redacted]").replaceAll(USER,"[redacted]").replace(/[?&](?:password|username)=[^&\\s]+/gi,"[redacted]").slice(0,120);
        failures.push(variant+": "+status);
      }
    }
    if(auth?.token||auth?.Token)break;
  }
  if(!auth?.token&&!auth?.Token){
    throw new Error("Provecta API login rejected all known variants; statuses: "+failures.join(", "));
  }
  const token=auth.token||auth.Token;
  const client=process.env.PROVECTA_CLIENT_ID||"6231fcee-c92c-f111-8cbf-9c6b0045fe69";
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
  // AngularJS needs additional time to render the company header after sign-in.
  await page.getByText(/FAMILYTURCOMPANY|PUDRA COMPANY/i).first()
    .waitFor({state:"visible",timeout:25000}).catch(()=>{});
  const pageText=await page.locator("body").innerText().catch(()=>"");
  console.log("[PHOTO LOGIN]",JSON.stringify({route:new URL(page.url()).hash.split("?")[0].slice(0,65),bodyChars:pageText.length,hasCompany:/FAMILYTURCOMPANY|PUDRA COMPANY/i.test(pageText)}));
  if(!/FAMILYTURCOMPANY|PUDRA COMPANY/i.test(pageText)){
    throw new Error("FAMILYTURCOMPANY account is not confirmed after waiting for dashboard");
  }
}
async function openImages(page,item) {
  await page.goto(BASE+"/app/#/product/0?productid="+encodeURIComponent(item.id),{waitUntil:"domcontentloaded",timeout:45000});
  // Tab titles are localized (English, Russian, Romanian).
  const imageTabPattern=/images|изображени|фото|imagini|poze/i;
  let tab=page.locator(".nav-tabs a, [role=tab]").filter({hasText:imageTabPattern}).first();
  await tab.waitFor({state:"visible",timeout:30000}).catch(()=>{});
  if(await page.locator('input[type="password"]').first().isVisible().catch(()=>false))throw new Error("Browser session expired");
  if(!(await tab.isVisible().catch(()=>false))){
    tab=page.getByText(/^(images|изображения|фотографии|фото|imagini|poze)$/i).first();
  }
  if(!(await tab.isVisible().catch(()=>false))){
    const hash=new URL(page.url()).hash.split("?")[0].slice(0,70);
    const labels=(await page.locator(".nav-tabs a, [role=tab]").allTextContents().catch(()=>[]))
      .map(t=>t.trim().replace(/\\s+/g," ").slice(0,55)).slice(0,16);
    const body=(await page.locator("body").innerText().catch(()=>"")).toLowerCase();
    throw new Error("Images tab unavailable; route="+hash+" tabLabels="+JSON.stringify(labels)+" bodyChars="+body.length+" productNameVisible="+body.includes(String(item.name).toLowerCase().slice(0,12)));
  }
  await tab.click();
  await page.waitForTimeout(2500);
  const text=(await page.locator("body").innerText()).slice(-8000);
  if(process.env.PHOTO_DEBUG_GALLERY==="true"){
    const widgets=await page.locator('[class*="swiper"],[class*="gallery"],[class*="carousel"]').evaluateAll(els=>els.slice(0,12).map(el=>({
      tag:el.tagName,class:String(el.className).slice(0,110),text:el.innerText?.slice(0,90),
      inner:el.innerHTML.slice(0,650)
    }))).catch(()=>[]);
    console.log("[PHOTO GALLERY DOM]",JSON.stringify({barcode:item.barcode,widgets}).slice(0,6500));
  }
  // Swiper's pagination displays "1 / 1" even for an empty wrapper.
  // Never use this counter to decide whether the product has photos.
  const wrapper=page.locator(".swiper-container.well .swiper-wrapper").first();
  await wrapper.waitFor({state:"attached",timeout:12000});
  const realSlides=await wrapper.locator(".swiper-slide").count();
  const inputValues=await page.locator("input:not([type=password])").evaluateAll(nodes=>
    nodes.map(n=>String(n.value||"").trim()).filter(Boolean));
  const productMatched=inputValues.some(x=>x===item.barcode || x===item.name || (item.code && x===item.code));
  if(process.env.PHOTO_DEBUG_GALLERY==="true"){
    console.log("[PHOTO PRODUCT MATCH]",JSON.stringify({
      barcode:item.barcode,code:item.code,name:item.name.slice(0,90),
      productMatched,slides:realSlides,
      inputValues:inputValues.filter(x=>x===item.barcode||x===item.code||x===item.name).slice(0,4)
    }));
  }
  // A direct productid URL must show the actual matching product before writing.
  if(!productMatched)throw new Error("Product form identity not confirmed from barcode/name/code");
  if(realSlides>0)return "exists";
  await page.waitForTimeout(1500);
  if(await wrapper.locator(".swiper-slide").count())return "exists";
  const possible=await page.locator("button,a,.btn").evaluateAll(els=>els.map(el=>({
    tag:el.tagName,text:(el.textContent||"").trim().replace(/\\s+/g," ").slice(0,75),
    class:String(el.className).slice(0,100)
  })).filter(x=>/upload|image|загруз|încărc/i.test(x.text)).slice(0,12)).catch(()=>[]);
  if(process.env.PHOTO_DEBUG_GALLERY==="true")console.log("[PHOTO UPLOAD CONTROLS]",JSON.stringify(possible));
  const uploadButton=page.locator("a.btn-primary:visible,button.btn-primary:visible").filter({hasText:/upload|загрузить|încărca|incarca/i}).first();
  if(!(await uploadButton.isVisible().catch(()=>false)))throw new Error("Gallery empty but upload control unavailable; candidateCount="+possible.length);
  return "empty";
}
async function upload(page,url) {
  const button=page.locator("a.btn-primary:visible,button.btn-primary:visible")
    .filter({hasText:/upload|загрузить|încărca|incarca/i}).first();
  await button.click({timeout:10000});
  const input=page.locator('input[name="imageurl"],input[placeholder="Paste link here"]').last();
  await input.waitFor({state:"visible",timeout:10000});
  await input.fill(url);
  const apply=page.locator('[ng-click="ok()"]:visible').first();
  if(!(await apply.count()))throw new Error("Image Apply control not present");
  await apply.click();
  await input.waitFor({state:"hidden",timeout:20000});
  const save=page.locator("button:visible,a.btn:visible").filter({hasText:/^(save|сохранить|salvează|salveaza)$/i}).first();
  if(!(await save.isVisible().catch(()=>false)))throw new Error("Product Save button unavailable");
  await save.click();
  await page.waitForTimeout(2500);
  const errors=page.getByText(/error|failed|ошибка/i);
  if(await errors.first().isVisible().catch(()=>false))throw new Error("Provecta reported an upload/save error");
  // Do not reopen this product after Save, per owner request.
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
  if(process.env.PHOTO_FORCE_RECHECK==="true")return false;
  if(!entry)return false;
  if(entry.status==="saved")return true;
  if(entry.status==="exists")return entry.checkVersion===2;
  if(entry.status==="dry_run")return false;
  if(entry.status==="error" && entry.checkVersion!==2)return false;
  if(entry.status==="error")return Date.now()-Date.parse(entry.at||"1970-01-01")<24*60*60*1000;
  return Date.now()-Date.parse(entry.at||"1970-01-01")<7*86400000;
}
export async function run(){
  const state=await loadState(), now=new Date().toISOString();
  const log={at:now,mode:LIVE?"LIVE":"DRY_RUN",checked:0,found:0,saved:0,exists:0,skipped:0,errors:[]};
  if(!USER||!PASS){
    console.error("[PHOTO LOADER] Missing GitHub secrets PROVECTA_USERNAME / PROVECTA_PASSWORD");
    console.log(JSON.stringify({status:"NEEDS_CONFIGURATION",...log}));
    return;
  }
  const allItems=await getCatalog();
  const onlyBarcodes=String(process.env.PHOTO_TEST_BARCODES||process.env.PHOTO_TEST_BARCODE||"").split(",").map(x=>x.trim()).filter(Boolean);
  const allowed=new Set(onlyBarcodes);
  const items=allowed.size?allItems.filter(x=>allowed.has(x.barcode)):allItems;
  if(!items.length)throw new Error("No matching Provecta products loaded");
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
      const e={at:new Date().toISOString(),barcode:item.barcode,name:item.name,checkVersion:2};
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
      if(log.errors.length>=2){console.log("[PHOTO LOADER] Pausing batch after two errors");break;}
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
