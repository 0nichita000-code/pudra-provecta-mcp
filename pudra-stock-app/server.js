import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const BASE = (process.env.PROVECTA_BASE_URL || "https://provectapos.com/proxy/api").replace(/\/$/, "");
const USERNAME = process.env.PROVECTA_USERNAME || "";
const PASSWORD = process.env.PROVECTA_PASSWORD || "";
const FIXED_CLIENT = process.env.PROVECTA_CLIENT_ID || "";
const ADMIN_PIN = process.env.ADMIN_PIN || "";
const STAFF_PIN = process.env.STAFF_PIN || "";
const DB_URL = process.env.DATABASE_URL || "";
const pool = DB_URL ? new Pool({ connectionString: DB_URL, ssl: DB_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined }) : null;

let auth = { token:"", client:"", expiresAt:0 };
let articles = { at:0, items:[], byId:new Map() };
let depots = { at:0, items:[] };
let stock = { at:0, ready:false, byArticle:new Map(), refreshing:false };
const mem = { transfers:[], discrepancies:[] };

const json = (res, status, body) => {
  res.writeHead(status, {"content-type":"application/json; charset=utf-8","cache-control":"no-store","access-control-allow-origin":"*","access-control-allow-headers":"content-type,x-pudra-pin,x-pudra-user,x-pudra-role"});
  res.end(JSON.stringify(body));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const idOf = x => x == null ? "" : typeof x === "string" || typeof x === "number" ? String(x) : String(x.Id ?? x.id ?? x.ArticleId ?? x.articleId ?? "");
const arr = x => Array.isArray(x) ? x : Array.isArray(x?.content) ? x.content : Array.isArray(x?.items) ? x.items : Array.isArray(x?.data) ? x.data : [];
const barcodes = a => {
  const xs = a?.ArticleBarcodes ?? a?.articleBarcodes ?? [];
  return Array.isArray(xs) ? xs.map(x=>String(x??"").trim()).filter(Boolean) : [];
};

async function fetchJson(url, options={}, retries=1) {
  let last;
  for (let i=0;i<=retries;i++) {
    try {
      const ctl=new AbortController();
      const t=setTimeout(()=>ctl.abort(),30000);
      const r=await fetch(url,{...options,signal:ctl.signal});
      clearTimeout(t);
      const text=await r.text();
      let data=text; try { data=text?JSON.parse(text):null; } catch {}
      if(!r.ok){ const e=new Error(`HTTP ${r.status}`); e.status=r.status; throw e; }
      return data;
    } catch(e){ last=e; if(i<retries) await sleep(250); else throw e; }
  }
  throw last;
}

function extractClient(clients){
  if(FIXED_CLIENT) return FIXED_CLIENT;
  const c=Array.isArray(clients)&&clients[0];
  return typeof c==="string"?c:(c?.Id||c?.id||c?.ClientId||c?.clientId||"");
}
async function login(force=false){
  if(!USERNAME||!PASSWORD) throw new Error("Provecta credentials missing");
  if(!force&&auth.token&&auth.client&&auth.expiresAt>Date.now()+120000) return auth;
  for(const username of [...new Set([USERNAME,USERNAME.toLowerCase()])]){
    for(const mode of ["json","query","form"]){
      try{
        const u=new URL(`${BASE}/v1/framework/common/login`);
        const headers={Accept:"application/json"};
        const o={method:"POST",headers};
        if(mode==="query"){u.searchParams.set("username",username);u.searchParams.set("password",PASSWORD);}
        if(mode==="json"){headers["content-type"]="application/json";o.body=JSON.stringify({username,password:PASSWORD});}
        if(mode==="form"){headers["content-type"]="application/x-www-form-urlencoded";o.body=new URLSearchParams({username,password:PASSWORD}).toString();}
        const d=await fetchJson(u.toString(),o,0);
        const token=d?.token||d?.Token, client=extractClient(d?.clients||d?.Clients);
        if(token&&client){auth={token,client,expiresAt:Date.now()+3600000}; return auth;}
      }catch{}
    }
  }
  throw new Error("Provecta login failed");
}
async function apiGet(route,params={}){
  let a=await login();
  const u=new URL(BASE+route);
  for(const [k,v] of Object.entries(params)){
    if(v==null||v==="") continue;
    if(Array.isArray(v)) v.forEach(x=>u.searchParams.append(k,String(x))); else u.searchParams.set(k,String(v));
  }
  try{
    return await fetchJson(u.toString(),{headers:{Accept:"application/json",Authorization:`Bearer ${a.token}`,Client:a.client}});
  }catch(e){
    if(e.status===401||e.status===403){auth={token:"",client:"",expiresAt:0};a=await login(true);return apiGet(route,params);}
    throw e;
  }
}
async function loadArticles(force=false){
  if(!force&&Date.now()-articles.at<30*60*1000&&articles.items.length) return articles.items;
  const items=arr(await apiGet("/v1/stock/article/select"));
  articles={at:Date.now(),items,byId:new Map(items.map(a=>[idOf(a),a]))};
  return items;
}
async function loadDepots(force=false){
  if(!force&&Date.now()-depots.at<30*60*1000&&depots.items.length) return depots.items;
  const items=arr(await apiGet("/v1/stock/depot/select")).map(d=>({id:idOf(d),name:d.Name??d.name??"",code:d.Code??d.code??""})).filter(x=>x.id);
  depots={at:Date.now(),items}; return items;
}
async function refreshStock(force=false){
  if(stock.refreshing) return;
  if(!force&&stock.ready&&Date.now()-stock.at<2*60*1000) return;
  stock.refreshing=true;
  try{
    const ds=await loadDepots();
    const byArticle=new Map();
    for(let i=0;i<ds.length;i+=2){
      const group=ds.slice(i,i+2);
      const rr=await Promise.all(group.map(async d=>({d,rows:arr(await apiGet("/v1/resume/currentBalance",{depotId:[d.id]}))})));
      for(const {d,rows} of rr){
        for(const row of rows){
          const aid=idOf(row.Article??row.article??row.ArticleId??row.articleId);
          if(!aid) continue;
          const q=Number(row.BalanceQuantitySum??row.balanceQuantitySum??0)||0;
          if(!byArticle.has(aid)) byArticle.set(aid,[]);
          byArticle.get(aid).push({depotId:d.id,depotName:d.name,quantity:q});
        }
      }
    }
    stock={at:Date.now(),ready:true,byArticle,refreshing:false};
  }catch(e){stock.refreshing=false;throw e;}
}
async function ensureData(){
  await Promise.all([loadArticles(),loadDepots()]);
  if(!stock.ready||Date.now()-stock.at>2*60*1000) await refreshStock();
}
function productShape(a){
  const aid=idOf(a);
  const stocks=depots.items.map(d=>{
    const hit=(stock.byArticle.get(aid)||[]).find(x=>x.depotId===d.id);
    return {depotId:d.id,depotName:d.name,quantity:hit?.quantity??0};
  });
  return {id:aid,name:a.Name??a.name??"",barcode:a.Barcode??a.barcode??"",additionalBarcodes:barcodes(a),code:a.Code??a.code??"",price:Number(a.Price??a.price??0)||0,stocks};
}
function matchProduct(q){
  const s=String(q||"").trim().toLowerCase();
  if(!s) return [];
  const exactNumeric=/^\d{8,14}$/.test(s);
  let out=articles.items.filter(a=>{
    const fields=[a.Name,a.name,a.Barcode,a.barcode,a.Code,a.code,...barcodes(a)].map(v=>String(v||"").toLowerCase());
    return exactNumeric?fields.includes(s):fields.some(v=>v.includes(s));
  });
  return out.slice(0,exactNumeric?1:50).map(productShape);
}
function authInfo(req){
  const pin=String(req.headers["x-pudra-pin"]||"");
  const user=String(req.headers["x-pudra-user"]||"").trim();
  const role=String(req.headers["x-pudra-role"]||"staff");
  const admin=ADMIN_PIN&&pin===ADMIN_PIN&&role==="admin";
  const staff=(STAFF_PIN&&pin===STAFF_PIN)||(ADMIN_PIN&&pin===ADMIN_PIN);
  return {ok:Boolean(staff),admin,user:user||"Сотрудник",role:admin?"admin":"staff"};
}
async function body(req){
  const chunks=[];let n=0;
  for await(const c of req){n+=c.length;if(n>256000) throw new Error("too large");chunks.push(c);}
  const raw=Buffer.concat(chunks).toString("utf8"); return raw?JSON.parse(raw):{};
}
function isTopFace(name){return /TOP\s*FACE|TOPFACE/i.test(name||"");}
function isHairElastic(name){return /ELASTIC|РЕЗИН|REZIN/i.test(name||"");}
function depotName(id){return depots.items.find(d=>d.id===id)?.name||id;}
function transferBlocked(product,fromId,toId,qty){
  const fromName=depotName(fromId), toName=depotName(toId);
  const row=product.stocks.find(x=>x.depotId===fromId);
  const available=Number(row?.quantity||0);
  if(!fromId||!toId||fromId===toId) return "Выберите разные точки ОТКУДА и КУДА.";
  if(!Number.isFinite(qty)||qty<=0) return "Количество должно быть больше 0.";
  if(available<=0) return `На ${fromName} остаток 0 или минус. Заявка запрещена.`;
  if(qty>available) return `На ${fromName} доступно только ${available} шт.`;
  if(isTopFace(product.name)&&/ORHEI|ОРГЕЕВ/i.test(toName)) return "TOP FACE нельзя направлять в Orhei.";
  if(isHairElastic(product.name)&&(/MAFIA/i.test(toName)||/^PUDRA BALTI$/i.test(toName))) return "Резинки нельзя направлять в Mafia.";
  return "";
}

async function initDb(){
  if(!pool) return;
  await pool.query(`
    create table if not exists transfer_requests(
      id bigserial primary key, created_at timestamptz default now(),
      employee text not null, product_id text not null, barcode text, product_name text not null,
      from_depot_id text not null, from_depot_name text not null, to_depot_id text not null, to_depot_name text not null,
      quantity integer not null, status text not null default 'NEW'
    );
    create index if not exists ix_transfer_route on transfer_requests(from_depot_id,to_depot_id,status);
    create table if not exists stock_discrepancies(
      id bigserial primary key, created_at timestamptz default now(),
      employee text not null, product_id text not null, barcode text, product_name text not null,
      depot_id text not null, depot_name text not null,
      system_qty numeric not null, actual_qty numeric not null, difference numeric not null,
      comment text, status text not null default 'NEW'
    );
  `);
}
async function addTransfer(x){
  if(pool){
    const r=await pool.query(`insert into transfer_requests(employee,product_id,barcode,product_name,from_depot_id,from_depot_name,to_depot_id,to_depot_name,quantity)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [x.employee,x.product.id,x.product.barcode,x.product.name,x.fromId,depotName(x.fromId),x.toId,depotName(x.toId),x.qty]);
    return r.rows[0];
  }
  const row={id:Date.now(),created_at:new Date().toISOString(),employee:x.employee,product_id:x.product.id,barcode:x.product.barcode,product_name:x.product.name,from_depot_id:x.fromId,from_depot_name:depotName(x.fromId),to_depot_id:x.toId,to_depot_name:depotName(x.toId),quantity:x.qty,status:"NEW"};
  mem.transfers.unshift(row); return row;
}
async function duplicateTransfer(productId,fromId,toId){
  if(pool){const r=await pool.query(`select * from transfer_requests where product_id=$1 and from_depot_id=$2 and to_depot_id=$3 and status in('NEW','APPROVED','PICKING','SENT') limit 1`,[productId,fromId,toId]);return r.rows[0]||null;}
  return mem.transfers.find(x=>x.product_id===productId&&x.from_depot_id===fromId&&x.to_depot_id===toId&&["NEW","APPROVED","PICKING","SENT"].includes(x.status))||null;
}
async function listTransfers(){
  if(pool){const r=await pool.query("select * from transfer_requests order by created_at desc limit 1000");return r.rows;}
  return mem.transfers;
}
async function updateTransfer(id,status){
  const allowed=["NEW","APPROVED","PICKING","SENT","RECEIVED","CLOSED","REJECTED"]; if(!allowed.includes(status)) throw new Error("Bad status");
  if(pool){const r=await pool.query("update transfer_requests set status=$1 where id=$2 returning *",[status,id]);return r.rows[0];}
  const x=mem.transfers.find(x=>String(x.id)===String(id));if(x)x.status=status;return x;
}
async function addDiscrepancy(x){
  if(pool){
    const r=await pool.query(`insert into stock_discrepancies(employee,product_id,barcode,product_name,depot_id,depot_name,system_qty,actual_qty,difference,comment)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [x.employee,x.product.id,x.product.barcode,x.product.name,x.depotId,depotName(x.depotId),x.systemQty,x.actualQty,x.actualQty-x.systemQty,x.comment||""]);
    return r.rows[0];
  }
  const row={id:Date.now(),created_at:new Date().toISOString(),employee:x.employee,product_id:x.product.id,barcode:x.product.barcode,product_name:x.product.name,depot_id:x.depotId,depot_name:depotName(x.depotId),system_qty:x.systemQty,actual_qty:x.actualQty,difference:x.actualQty-x.systemQty,comment:x.comment||"",status:"NEW"};
  mem.discrepancies.unshift(row); return row;
}
async function listDiscrepancies(){
  if(pool){const r=await pool.query("select * from stock_discrepancies order by created_at desc limit 1000");return r.rows;}
  return mem.discrepancies;
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||"/","http://localhost");
    if(req.method==="OPTIONS"){res.writeHead(204,{"access-control-allow-origin":"*","access-control-allow-headers":"content-type,x-pudra-pin,x-pudra-user,x-pudra-role","access-control-allow-methods":"GET,POST,PATCH,OPTIONS"});return res.end();}
    if(req.method==="GET"&&url.pathname==="/health") return json(res,200,{ok:true,stockAgeMs:stock.ready?Date.now()-stock.at:null,db:Boolean(pool)});
    if(req.method==="GET"&&(url.pathname==="/"||url.pathname==="/app")){
      const html=await fs.readFile(path.join(__dirname,"public","index.html"));res.writeHead(200,{"content-type":"text/html; charset=utf-8"});return res.end(html);
    }
    if(req.method==="GET"&&url.pathname.startsWith("/static/")){
      const name=path.basename(url.pathname); const p=path.join(__dirname,"public",name);
      const data=await fs.readFile(p); const type=name.endsWith(".js")?"application/javascript":"text/css";
      res.writeHead(200,{"content-type":type+"; charset=utf-8","cache-control":"public,max-age=300"});return res.end(data);
    }
    const a=authInfo(req);
    if(url.pathname.startsWith("/api/")&&!a.ok) return json(res,401,{error:"Неверный PIN"});
    await ensureData();
    if(req.method==="GET"&&url.pathname==="/api/meta") return json(res,200,{depots:depots.items,user:a.user,role:a.role});
    if(req.method==="GET"&&url.pathname==="/api/search"){
      const q=url.searchParams.get("q")||""; return json(res,200,{products:matchProduct(q),stockUpdatedAt:new Date(stock.at).toISOString()});
    }
    if(req.method==="POST"&&url.pathname==="/api/refresh"){await refreshStock(true);return json(res,200,{ok:true,updatedAt:new Date(stock.at).toISOString()});}
    if(req.method==="POST"&&url.pathname==="/api/transfers"){
      const b=await body(req); const p=matchProduct(b.productId||b.barcode||"").find(x=>x.id===b.productId)||matchProduct(b.barcode||"")[0];
      if(!p) return json(res,404,{error:"Товар не найден"});
      const qty=Math.trunc(Number(b.quantity)); const err=transferBlocked(p,b.fromDepotId,b.toDepotId,qty); if(err) return json(res,400,{error:err});
      const dupe=await duplicateTransfer(p.id,b.fromDepotId,b.toDepotId); if(dupe) return json(res,409,{error:`Уже есть активная заявка №${dupe.id} по этому товару и направлению.`,duplicate:dupe});
      const row=await addTransfer({employee:a.user,product:p,fromId:b.fromDepotId,toId:b.toDepotId,qty});
      return json(res,201,{ok:true,request:row,notification:"Новая заявка на перемещение"});
    }
    if(req.method==="GET"&&url.pathname==="/api/transfers"){
      if(!a.admin) return json(res,403,{error:"Только администратор"});
      return json(res,200,{items:await listTransfers()});
    }
    if(req.method==="PATCH"&&/^\/api\/transfers\/\d+$/.test(url.pathname)){
      if(!a.admin) return json(res,403,{error:"Только администратор"});
      const b=await body(req); const id=url.pathname.split("/").pop(); return json(res,200,{item:await updateTransfer(id,b.status)});
    }
    if(req.method==="POST"&&url.pathname==="/api/discrepancies"){
      const b=await body(req); const p=matchProduct(b.productId||b.barcode||"").find(x=>x.id===b.productId)||matchProduct(b.barcode||"")[0];
      if(!p) return json(res,404,{error:"Товар не найден"});
      const s=p.stocks.find(x=>x.depotId===b.depotId); const systemQty=Number(s?.quantity||0), actualQty=Number(b.actualQty);
      if(!Number.isFinite(actualQty)||actualQty<0) return json(res,400,{error:"Укажите фактическое количество 0 или больше"});
      if(actualQty===systemQty) return json(res,400,{error:"Расхождения нет: фактическое количество совпадает с Provecta"});
      const row=await addDiscrepancy({employee:a.user,product:p,depotId:b.depotId,systemQty,actualQty,comment:b.comment});
      return json(res,201,{ok:true,discrepancy:row,notification:"Новое расхождение остатка"});
    }
    if(req.method==="GET"&&url.pathname==="/api/discrepancies"){
      if(!a.admin) return json(res,403,{error:"Только администратор"}); return json(res,200,{items:await listDiscrepancies()});
    }
    return json(res,404,{error:"Not found"});
  }catch(e){console.error(e);return json(res,500,{error:e.message||"Server error"});}
});

await initDb();
server.listen(PORT,"0.0.0.0",()=>console.log(`PUDRA STOCK listening on ${PORT}`));
refreshStock(true).catch(console.error);
setInterval(()=>refreshStock(false).catch(()=>{}),2*60*1000).unref();
