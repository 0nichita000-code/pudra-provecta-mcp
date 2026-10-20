import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createStockApp(deps) {
  const { getArticles, getDepots, getCachedStocks, refreshStockCache, getStockCacheState, simpleDepot, simpleArticle, articleBarcodes, idOf, asArray, apiGet, modernSearchAdditionalBarcode, legacySearchAdditionalBarcode } = deps;
  const ADMIN_PIN = process.env.STOCK_ADMIN_PIN || "2468";
  const STAFF_PIN = process.env.STOCK_STAFF_PIN || "1357";
  const transfers = [];
  const discrepancies = [];

  const sendJson=(res,status,data)=>{res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});res.end(JSON.stringify(data));};
  const esc=s=>String(s??"");
  const authInfo=req=>{
    const pin=String(req.headers["x-pudra-pin"]||"");
    let user=String(req.headers["x-pudra-user"]||"").trim(); try{user=decodeURIComponent(user);}catch{} user=user||"Сотрудник";
    const role=String(req.headers["x-pudra-role"]||"staff");
    const admin=role==="admin"&&pin===ADMIN_PIN;
    const ok=admin || role!=="admin";
    return {ok,admin,user,role:admin?"admin":"staff"};
  };
  const readBody=async req=>{const xs=[];let n=0;for await(const c of req){n+=c.length;if(n>256000)throw new Error("Body too large");xs.push(c);}const raw=Buffer.concat(xs).toString("utf8");return raw?JSON.parse(raw):{};};
  const depotName=(ds,id)=>ds.find(d=>d.id===id)?.name||id;
  const isTopFace=n=>/TOP\s*FACE|TOPFACE/i.test(n||"");
  const isHairElastic=n=>/ELASTIC|РЕЗИН|REZIN/i.test(n||"");
  function allowedDepotName(name){
    const n=String(name||"").toUpperCase().trim();
    return n==="PUDRA ORHEI" ||
      n==="PUDRA GLODENI" ||
      n==="PUDRA BALTI" ||
      n==="PUDRA BALTI PINK" ||
      n==="DEPOZIT RISCANI";
  }

  async function catalogs(){
    const [rawArticles,rawDepots]=await Promise.all([getArticles(false),getDepots(false)]);
    return {rawArticles,ds:rawDepots.map(simpleDepot).filter(d=>d.id && allowedDepotName(d.name))};
  }
  function stocksFor(a,ds){
    const aid=idOf(a);
    const cached=getCachedStocks(aid);
    if(!cached)return ds.map(d=>({depotId:d.id,depotName:d.name,quantity:null,loading:true}));
    const m=new Map(cached.map(x=>[x.id,x]));
    return ds.map(d=>({depotId:d.id,depotName:d.name,quantity:Number(m.get(d.id)?.quantity||0),loading:false}));
  }
  function deriveGroup(a){
    const direct =
      a.Group?.Name ?? a.group?.name ??
      a.ArticleGroup?.Name ?? a.articleGroup?.name ??
      a.GroupName ?? a.groupName ??
      a.ArticleGroupName ?? a.articleGroupName ??
      "";
    if (typeof direct === "string" && direct.trim()) return direct.trim();

    const name=String(a.Name ?? a.name ?? "").trim().toUpperCase();
    const known=[
      ["KEVIN&COCO","KEVIN&COCO"],["KEVIN & COCO","KEVIN&COCO"],
      ["FARM STAY","FARM STAY"],["DR.ALTHEA","DR.ALTHEA"],["DR. ALTHEA","DR.ALTHEA"],
      ["MEDI-PEEL","MEDIPEEL"],["MEDIPEEL","MEDIPEEL"],["BIO WORLD","BIO WORLD"],
      ["TOP FACE","TOPFACE"],["TOPFACE","TOPFACE"],["LUXVISAGE","LUXVISAGE"],
      ["OLLIN","OLLIN"],["SADOER","SADOER"],["RUBYFACE","RUBYFACE"],["FRUDIA","FRUDIA"],
      ["LATTAFA","LATTAFA"],["ARMAF","ARMAF"],["ZIMAYA","ZIMAYA"],["VT ","VT"],
      ["BILION BEAUTY","BILION BEAUTY"],["MILAI","MILAI"]
    ];
    for(const [prefix,label] of known){ if(name.startsWith(prefix)) return label; }
    const first=name.split(/\s+/)[0]?.replace(/[^A-ZА-ЯЁ0-9&+.-]/g,"")||"";
    return first || "ДРУГИЕ";
  }
  function shape(a,ds){
    const x=simpleArticle(a);
    return {...x,group:deriveGroup(a),stocks:stocksFor(a,ds)};
  }
  async function search(q){
    const s=String(q||"").trim().toLowerCase();
    const {rawArticles,ds}=await catalogs();

    if(!s){
      const started=Date.now();
      while(getStockCacheState && !getStockCacheState().ready && Date.now()-started<90000){
        await new Promise(r=>setTimeout(r,1500));
      }
    }

    const exact=/^\d{8,14}$/.test(s);
    let matched=rawArticles.filter(a=>{
      const vals=[a.Name,a.name,a.Barcode,a.barcode,a.Code,a.code,...articleBarcodes(a)].map(v=>String(v||"").toLowerCase());
      return !s ? true : (exact?vals.includes(s):vals.some(v=>v.includes(s)));
    }).slice(0,!s?6000:(exact?1:50));

    if(exact && matched.length===0){
      try{
        const modern=await modernSearchAdditionalBarcode(s);
        if(modern?.article) matched=[modern.article];
      }catch{}
      if(matched.length===0){
        try{
          const legacy=await legacySearchAdditionalBarcode(s);
          if(legacy?.article) matched=[legacy.article];
        }catch{}
      }
    }

    return matched.map(a=>shape(a,ds));
  }
  async function findProduct(productId,barcode){
    const {rawArticles,ds}=await catalogs();
    let a=rawArticles.find(x=>idOf(x)===String(productId||""));
    if(!a&&barcode){
      const bc=String(barcode);
      a=rawArticles.find(x=>String(x.Barcode??x.barcode??"")===bc||articleBarcodes(x).includes(bc));
      if(!a){
        try{const modern=await modernSearchAdditionalBarcode(bc);if(modern?.article)a=modern.article;}catch{}
      }
      if(!a){
        try{const legacy=await legacySearchAdditionalBarcode(bc);if(legacy?.article)a=legacy.article;}catch{}
      }
    }
    if(!a)return null;
    return shape(a,ds);
  }
  function transferError(p,ds,fromId,toId,qty){
    if(!fromId||!toId||fromId===toId)return "Выберите разные точки ОТКУДА и КУДА.";
    if(!Number.isFinite(qty)||qty<=0)return "Количество должно быть больше 0.";
    const from=depotName(ds,fromId), to=depotName(ds,toId);
    const available=Number(p.stocks.find(x=>x.depotId===fromId)?.quantity||0);
    if(available<=0)return `На ${from} остаток 0 или минус. Заявка запрещена.`;
    if(qty>available)return `На ${from} доступно только ${available} шт.`;
    if(isTopFace(p.name)&&/ORHEI|ОРГЕЕВ/i.test(to))return "TOP FACE нельзя направлять в Orhei.";
    if(isHairElastic(p.name)&&(/MAFIA/i.test(to)||/^PUDRA BALTI$/i.test(to)))return "Резинки нельзя направлять в Mafia.";
    return "";
  }

  return async function handleStock(req,res,url){
    if(req.method==="GET"&&(url.pathname==="/stock"||url.pathname==="/stock/")){
      const data=await fs.readFile(path.join(__dirname,"stock","index.html"));res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store"});res.end(data);return true;
    }
    if(req.method==="GET"&&url.pathname==="/stock/zxing.js"){
      const data=await fs.readFile(path.join(__dirname,"node_modules","@zxing","browser","umd","zxing-browser.min.js"));
      res.writeHead(200,{"content-type":"application/javascript; charset=utf-8","cache-control":"public,max-age=86400"});res.end(data);return true;
    }
    if(req.method==="GET"&&url.pathname==="/stock/app.js"){
      const data=await fs.readFile(path.join(__dirname,"stock","app.js"));res.writeHead(200,{"content-type":"application/javascript; charset=utf-8","cache-control":"no-store"});res.end(data);return true;
    }
    if(!url.pathname.startsWith("/stock/api/"))return false;
    const a=authInfo(req); if(!a.ok){sendJson(res,401,{error:"Неверный PIN"});return true;}
    if(req.method==="GET"&&url.pathname==="/stock/api/meta"){
      const rawDepots=await getDepots(false);const ds=rawDepots.map(simpleDepot).filter(d=>d.id && allowedDepotName(d.name));sendJson(res,200,{depots:ds,user:a.user,role:a.role});return true;
    }
    if(req.method==="GET"&&url.pathname==="/stock/api/search"){
      const products=await search(url.searchParams.get("q")||"");sendJson(res,200,{products});return true;
    }
    if(req.method==="POST"&&url.pathname==="/stock/api/refresh"){
      await refreshStockCache(true);sendJson(res,200,{ok:true});return true;
    }
    if(req.method==="POST"&&url.pathname==="/stock/api/transfers"){
      const b=await readBody(req);const p=await findProduct(b.productId,b.barcode);if(!p){sendJson(res,404,{error:"Товар не найден"});return true;}
      const {ds}=await catalogs();const qty=Math.trunc(Number(b.quantity));const err=transferError(p,ds,b.fromDepotId,b.toDepotId,qty);if(err){sendJson(res,400,{error:err});return true;}
      const dupe=transfers.find(x=>x.product_id===p.id&&x.from_depot_id===b.fromDepotId&&x.to_depot_id===b.toDepotId&&["NEW","APPROVED","PICKING","SENT"].includes(x.status));
      if(dupe){sendJson(res,409,{error:`Уже есть активная заявка №${dupe.id} по этому товару и направлению.`});return true;}
      const row={id:Date.now(),created_at:new Date().toISOString(),employee:a.user,product_id:p.id,barcode:p.barcode,product_name:p.name,from_depot_id:b.fromDepotId,from_depot_name:depotName(ds,b.fromDepotId),to_depot_id:b.toDepotId,to_depot_name:depotName(ds,b.toDepotId),quantity:qty,status:"NEW"};
      transfers.unshift(row);sendJson(res,201,{ok:true,request:row});return true;
    }
    if(req.method==="GET"&&url.pathname==="/stock/api/transfers"){
      if(!a.admin){sendJson(res,403,{error:"Только администратор"});return true;}sendJson(res,200,{items:transfers});return true;
    }
    if(req.method==="DELETE"&&/^\/stock\/api\/transfers\/\d+$/.test(url.pathname)){
      if(!a.admin){sendJson(res,403,{error:"Только администратор"});return true;}
      const id=url.pathname.split("/").pop();
      const i=transfers.findIndex(x=>String(x.id)===id);
      if(i<0){sendJson(res,404,{error:"Заявка не найдена"});return true;}
      const [deleted]=transfers.splice(i,1);
      sendJson(res,200,{ok:true,deleted});return true;
    }
    if(req.method==="PATCH"&&/^\/stock\/api\/transfers\/\d+$/.test(url.pathname)){
      if(!a.admin){sendJson(res,403,{error:"Только администратор"});return true;}const b=await readBody(req);const allowed=["NEW","APPROVED","PICKING","SENT","RECEIVED","CLOSED","REJECTED"];if(!allowed.includes(b.status)){sendJson(res,400,{error:"Неверный статус"});return true;}
      const id=url.pathname.split("/").pop(),row=transfers.find(x=>String(x.id)===id);if(row)row.status=b.status;sendJson(res,200,{item:row});return true;
    }
    if(req.method==="POST"&&url.pathname==="/stock/api/discrepancies"){
      const b=await readBody(req),p=await findProduct(b.productId,b.barcode);if(!p){sendJson(res,404,{error:"Товар не найден"});return true;}
      const {ds}=await catalogs();const systemQty=Number(p.stocks.find(x=>x.depotId===b.depotId)?.quantity||0),actualQty=Number(b.actualQty);
      if(!Number.isFinite(actualQty)||actualQty<0){sendJson(res,400,{error:"Укажите фактическое количество 0 или больше"});return true;}
      if(actualQty===systemQty){sendJson(res,400,{error:"Расхождения нет: количество совпадает с Provecta"});return true;}
      const row={id:Date.now(),created_at:new Date().toISOString(),employee:a.user,product_id:p.id,barcode:p.barcode,product_name:p.name,depot_id:b.depotId,depot_name:depotName(ds,b.depotId),system_qty:systemQty,actual_qty:actualQty,difference:actualQty-systemQty,comment:esc(b.comment),status:"NEW"};
      discrepancies.unshift(row);sendJson(res,201,{ok:true,discrepancy:row});return true;
    }
    if(req.method==="GET"&&url.pathname==="/stock/api/monitoring"){
      if(!a.admin){sendJson(res,403,{error:"Только администратор"});return true;}
      const {rawArticles,ds}=await catalogs();
      const state=getStockCacheState?getStockCacheState():{ready:false,refreshing:false,at:0};
      const perDepot=ds.map(d=>({depotId:d.id,depotName:d.name,positive:0,zero:0,totalQty:0}));
      for(const ar of rawArticles){
        const st=stocksFor(ar,ds);
        st.forEach((x,i)=>{if(x.quantity==null)return;const q=Number(x.quantity)||0;perDepot[i].totalQty+=q;if(q>0)perDepot[i].positive++;else perDepot[i].zero++;});
      }
      sendJson(res,200,{
        cache:state,
        products:rawArticles.length,
        activeTransfers:transfers.filter(x=>["NEW","APPROVED","PICKING","SENT"].includes(x.status)).length,
        openDiscrepancies:discrepancies.filter(x=>x.status==="NEW").length,
        perDepot
      });return true;
    }
    if(req.method==="GET"&&url.pathname==="/stock/api/discrepancies"){
      if(!a.admin){sendJson(res,403,{error:"Только администратор"});return true;}sendJson(res,200,{items:discrepancies});return true;
    }
    if(req.method==="DELETE"&&/^\/stock\/api\/discrepancies\/\d+$/.test(url.pathname)){
      if(!a.admin){sendJson(res,403,{error:"Только администратор"});return true;}
      const id=url.pathname.split("/").pop();
      const i=discrepancies.findIndex(x=>String(x.id)===id);
      if(i<0){sendJson(res,404,{error:"Расхождение не найдено"});return true;}
      const [deleted]=discrepancies.splice(i,1);
      sendJson(res,200,{ok:true,deleted});return true;
    }
    sendJson(res,404,{error:"Not found"});return true;
  };
}
