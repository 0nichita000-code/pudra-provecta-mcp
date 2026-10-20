(()=>{
const S={user:"",role:"staff",pin:"",depots:[],product:null,stream:null,scanTimer:null,watchTimer:null,lastTransferId:0,lastDiffId:0,zxingControls:null,scanLocked:false,lastScanned:"",cameraIds:[],cameraIndex:0,inventory:[],invShown:0,invGroupName:"",audioCtx:null};
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
function headers(){return {"content-type":"application/json","x-pudra-pin":S.pin,"x-pudra-user":encodeURIComponent(S.user),"x-pudra-role":S.role};}
async function api(url,opt={}){
  let last;
  for(let i=0;i<2;i++){
    try{
      const ctl=new AbortController();
      const t=setTimeout(()=>ctl.abort(),20000);
      const r=await fetch(url,{...opt,signal:ctl.signal,headers:{...headers(),...(opt.headers||{})}});
      clearTimeout(t);
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.error||("Ошибка "+r.status));
      return d;
    }catch(e){
      last=e;
      if(i===0)await new Promise(r=>setTimeout(r,800));
    }
  }
  if(last?.name==="AbortError")throw new Error("Сервер не успел ответить. Повторите действие через несколько секунд.");
  if(String(last?.message||"").includes("Failed to fetch"))throw new Error("Не удалось связаться с сервером. Обновите страницу и попробуйте ещё раз.");
  throw last;
}
function msg(el,text,type=""){el.innerHTML=text?'<div class="notice '+type+'">'+esc(text)+'</div>':"";}
function initScanAudio(){
  try{
    if(!S.audioCtx){
      const AC=window.AudioContext||window.webkitAudioContext;
      if(AC)S.audioCtx=new AC();
    }
    if(S.audioCtx?.state==="suspended")S.audioCtx.resume().catch(()=>{});
  }catch{}
}
function scanFeedback(){
  try{if(navigator.vibrate)navigator.vibrate(80);}catch{}
  try{
    initScanAudio();
    if(!S.audioCtx)return;
    const o=S.audioCtx.createOscillator();
    const g=S.audioCtx.createGain();
    o.type="sine";
    o.frequency.value=1150;
    g.gain.setValueAtTime(0.0001,S.audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12,S.audioCtx.currentTime+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001,S.audioCtx.currentTime+0.11);
    o.connect(g);g.connect(S.audioCtx.destination);
    o.start();o.stop(S.audioCtx.currentTime+0.12);
  }catch{}
}
function flashScanFrame(){
  const f=$("scanFrame");
  if(!f)return;
  f.classList.add("ok");
  setTimeout(()=>f.classList.remove("ok"),700);
}
async function tuneCamera(track){
  try{
    if(!track?.getCapabilities)return;
    const caps=track.getCapabilities();
    const advanced={};
    if(caps?.focusMode?.includes?.("continuous"))advanced.focusMode="continuous";
    if(caps?.zoom){
      const min=Number(caps.zoom.min ?? 1);
      const max=Number(caps.zoom.max ?? 1);
      const target=Math.min(max,Math.max(min,1.5));
      if(Number.isFinite(target))advanced.zoom=target;
    }
    if(Object.keys(advanced).length)await track.applyConstraints({advanced:[advanced]});
  }catch{}
}

function pushNotice(title,body){try{if("Notification" in window&&Notification.permission==="granted")new Notification(title,{body});}catch{}}
async function adminWatch(first=false){
  if(S.role!=="admin")return;
  try{
    const [tr,df]=await Promise.all([api("/stock/api/transfers"),api("/stock/api/discrepancies")]);
    const tmax=Math.max(0,...tr.items.map(x=>Number(x.id)||0));
    const dmax=Math.max(0,...df.items.map(x=>Number(x.id)||0));
    if(!first&&S.lastTransferId&&tmax>S.lastTransferId){
      const x=tr.items.find(x=>Number(x.id)===tmax);
      pushNotice("Новая заявка PUDRA",x?x.from_depot_name+" → "+x.to_depot_name+" · "+x.product_name:"Новая заявка на перемещение");
    }
    if(!first&&S.lastDiffId&&dmax>S.lastDiffId){
      const x=df.items.find(x=>Number(x.id)===dmax);
      pushNotice("Расхождение PUDRA",x?x.depot_name+" · "+x.product_name+" · "+x.difference+" шт.":"Новое расхождение остатка");
    }
    S.lastTransferId=tmax; S.lastDiffId=dmax;
    if(!$("adminTab").classList.contains("hidden")) loadRequests();
    if(!$("diffTab").classList.contains("hidden")) loadDiffs();
  }catch{}
}
function startAdminWatch(){
  if(S.role!=="admin")return;
  try{if("Notification" in window&&Notification.permission==="default")Notification.requestPermission();}catch{}
  adminWatch(true);
  if(S.watchTimer)clearInterval(S.watchTimer);
  S.watchTimer=setInterval(()=>adminWatch(false),15000);
}

function tab(id){
  document.querySelectorAll(".tabPanel").forEach(x=>x.classList.add("hidden"));
  $(id).classList.remove("hidden");
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.tab===id));
  if(id==="adminTab")loadRequests();
  if(id==="diffTab")loadDiffs();
  if(id==="monitorTab")loadMonitoring();
  if(id==="inventoryTab"&&!S.inventory.length)loadInventory();
  if(id==="scanTab"){
    try{if(localStorage.getItem("pudraCameraReady")==="1"&&!S.stream&&!S.zxingControls)startScan();}catch{}
  }
}
function saveLogin(){
  try{
    localStorage.setItem("pudraStockLogin",JSON.stringify({user:S.user,role:S.role,pin:S.role==="admin"?S.pin:""}));
  }catch{}
}
function updatePinVisibility(){
  const admin=$("role").value==="admin";
  $("pinWrap").classList.toggle("hidden",!admin);
  if(!admin)$("pin").value="";
}
async function login(auto=false){
  S.user=$("userName").value.trim();S.role=$("role").value;S.pin=S.role==="admin"?$("pin").value:"";
  if(!S.user)return msg($("loginMsg"),"Введите имя","bad");
  if(S.role==="admin"&&!S.pin)return msg($("loginMsg"),"Введите PIN администратора","bad");
  try{
    const m=await api("/stock/api/meta");
    S.depots=m.depots;
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("who").textContent=S.user+(S.role==="admin"?" · админ":"");
    document.querySelectorAll(".adminOnly").forEach(x=>x.classList.toggle("hidden",S.role!=="admin"));
    msg($("loginMsg"),"");
    saveLogin();
    if(S.role==="admin")startAdminWatch();
  }catch(e){
    if(auto){try{localStorage.removeItem("pudraStockLogin");}catch{}}
    msg($("loginMsg"),e.message,"bad");
  }
}
async function restoreLogin(){
  try{
    const saved=JSON.parse(localStorage.getItem("pudraStockLogin")||"null");
    if(!saved?.user)return;
    $("userName").value=saved.user;
    $("role").value=saved.role||"staff";
    $("pin").value=saved.pin||"";
    updatePinVisibility();
    await login(true);
  }catch{}
}
function stockRows(p){return p.stocks.map(x=>{const q=x.quantity==null?"обновляется…":x.quantity;return '<div class="stock"><span>'+esc(x.depotName)+'</span><span class="qty '+(x.quantity!=null&&Number(x.quantity)<=0?"zero":"")+'">'+esc(q)+'</span></div>';}).join("");}
function optionList(selected=""){return '<option value="">Выберите точку</option>'+S.depots.map(d=>'<option value="'+esc(d.id)+'" '+(d.id===selected?"selected":"")+'>'+esc(d.name)+'</option>').join("");}
function showProduct(p){
  S.product=p;
  const card=$("productCard");card.classList.remove("hidden");
  card.innerHTML='<div class="row"><div class="grow"><div class="name" style="font-size:20px">'+esc(p.name)+'</div><div class="muted">Штрихкод: '+esc(p.barcode||"—")+' · Код: '+esc(p.code||"—")+'</div></div><span class="pill">'+esc(p.price)+' MDL</span></div>'+
    '<h4>Остатки</h4>'+stockRows(p)+
    '<div style="height:12px"></div><div class="grid"><button id="moveBtn" class="primary">Запросить перемещение</button><button id="diffBtn" class="ghost">Есть расхождение</button></div>'+
    '<div id="actionBox" style="margin-top:12px"></div>';
  $("moveBtn").addEventListener("click",showMoveForm);$("diffBtn").addEventListener("click",showDiffForm);
  card.scrollIntoView({behavior:"smooth",block:"start"});
}
function showMoveForm(){
  $("actionBox").innerHTML='<div class="card" style="margin:0"><h3 style="margin-top:0">Заявка на перемещение</h3><div class="grid"><label>ОТКУДА<select id="from">'+optionList()+'</select></label><label>КУДА<select id="to">'+optionList()+'</select></label></div><label>Количество<input id="qty" type="number" min="1" step="1" value="1"></label><button id="sendMove" class="primary" style="width:100%;margin-top:10px">Отправить заявку</button><div id="moveMsg" style="margin-top:10px"></div></div>';
  $("sendMove").addEventListener("click",sendMove);
}
async function sendMove(){
  try{
    const d=await api("/stock/api/transfers",{method:"POST",body:JSON.stringify({productId:S.product.id,barcode:S.product.barcode,fromDepotId:$("from").value,toDepotId:$("to").value,quantity:Number($("qty").value)})});
    msg($("moveMsg"),"Заявка №"+d.request.id+" отправлена администратору.","ok");
  }catch(e){msg($("moveMsg"),e.message,"bad");}
}
function showDiffForm(){
  $("actionBox").innerHTML='<div class="card" style="margin:0"><h3 style="margin-top:0">Несоответствие остатка</h3><label>Магазин<select id="diffDepot">'+optionList()+'</select></label><label>Фактически посчитано<input id="actual" type="number" min="0" step="1"></label><label>Комментарий<textarea id="comment" rows="2" placeholder="Необязательно"></textarea></label><button id="sendDiff" class="primary" style="width:100%;margin-top:10px">Сообщить администратору</button><div id="diffMsg" style="margin-top:10px"></div></div>';
  $("sendDiff").addEventListener("click",sendDiff);
}
async function sendDiff(){
  try{
    const d=await api("/stock/api/discrepancies",{method:"POST",body:JSON.stringify({productId:S.product.id,barcode:S.product.barcode,depotId:$("diffDepot").value,actualQty:Number($("actual").value),comment:$("comment").value})});
    const x=d.discrepancy;msg($("diffMsg"),"Отправлено. Разница: "+x.difference+" шт.","ok");
  }catch(e){msg($("diffMsg"),e.message,"bad");}
}
async function search(q){
  q=(q??$("search").value).trim();if(!q)return;
  msg($("searchMsg"),"Ищу…");$("results").innerHTML="";
  try{
    const d=await api("/stock/api/search?q="+encodeURIComponent(q));msg($("searchMsg"),d.products.length?"Найдено: "+d.products.length:"Ничего не найдено");
    if(d.products.length===1){showProduct(d.products[0]);return;}
    $("results").innerHTML=d.products.map((p,i)=>'<div class="product" data-i="'+i+'"><div class="name">'+esc(p.name)+'</div><div class="muted">'+esc(p.barcode||"—")+' · '+esc(p.price)+' MDL</div></div>').join("");
    document.querySelectorAll(".product[data-i]").forEach(el=>el.addEventListener("click",()=>showProduct(d.products[Number(el.dataset.i)])));
  }catch(e){msg($("searchMsg"),e.message,"bad");}
}
async function refresh(){try{msg($("searchMsg"),"Обновляю остатки…");await api("/stock/api/refresh",{method:"POST",body:"{}"});msg($("searchMsg"),"Остатки обновлены","ok");if(S.product)await search(S.product.barcode||S.product.name);}catch(e){msg($("searchMsg"),e.message,"bad");}}
function statusRu(s){return ({NEW:"Новая",APPROVED:"Подтверждена",PICKING:"Собирается",SENT:"Отправлена",RECEIVED:"Получена",CLOSED:"Закрыта",REJECTED:"Отклонена"})[s]||s;}
async function loadInventory(){
  $("invInfo").textContent="Загружаю актуальные остатки…";
  $("groupList").innerHTML="";
  $("inventoryHome").classList.remove("hidden");
  $("inventoryGroupView").classList.add("hidden");
  try{
    const d=await api("/stock/api/search?q=");
    S.inventory=d.products||[];

    // Если кэш остатков ещё не успел загрузиться после перезапуска сервера,
    // не показываем ложные нули — ждём и пробуем ещё раз.
    const positiveCount=S.inventory.reduce((n,p)=>n+p.stocks.filter(x=>Number(x.quantity)>0).length,0);
    if(!positiveCount){
      $("invInfo").textContent="Остатки обновляются с Provecta…";
      await new Promise(r=>setTimeout(r,5000));
      const d2=await api("/stock/api/search?q=");
      S.inventory=d2.products||[];
    }

    renderGroupList();
  }catch(e){
    $("invInfo").innerHTML='<div class="notice bad">'+esc(e.message)+'</div>';
  }
}
function availableGroups(){
  const map=new Map();
  for(const p of S.inventory){
    const hasStock=p.stocks.some(x=>Number(x.quantity)>0);
    if(!hasStock)continue;
    const g=p.group||"ДРУГИЕ";
    map.set(g,(map.get(g)||0)+1);
  }
  return [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0],"ru"));
}
function renderGroupList(){
  const q=$("groupSearch").value.trim().toLowerCase();
  const groups=availableGroups().filter(([g])=>!q||g.toLowerCase().includes(q));
  $("groupList").innerHTML=groups.length?groups.map(([g,count])=>
    '<button class="ghost invGroupBtn" data-group="'+esc(g)+'" style="width:100%;text-align:left;margin-bottom:8px;padding:14px 16px"><b>'+esc(g)+'</b><span class="pill" style="float:right">'+count+'</span></button>'
  ).join(""):'<div class="notice">Группы с положительным остатком не найдены.</div>';
  $("invInfo").textContent="Групп с товаром в наличии: "+groups.length;
  document.querySelectorAll(".invGroupBtn").forEach(b=>b.addEventListener("click",()=>openInventoryGroup(b.dataset.group)));
}
function openInventoryGroup(group){
  S.invGroupName=group;
  S.invShown=0;
  $("inventoryHome").classList.add("hidden");
  $("inventoryGroupView").classList.remove("hidden");
  $("invGroupTitle").textContent=group;
  $("invDepot").innerHTML='<option value="">Выберите магазин</option>'+S.depots.map(d=>'<option value="'+esc(d.id)+'">'+esc(d.name)+'</option>').join("");
  $("invSearch").value="";
  $("inventoryList").innerHTML='<div class="muted">Выберите магазин, чтобы увидеть только товары с остатком больше 0.</div>';
  $("invMore").classList.add("hidden");
}
function inventoryFiltered(){
  const depotId=$("invDepot").value;
  if(!depotId)return [];
  const q=$("invSearch").value.trim().toLowerCase();
  return S.inventory.filter(p=>{
    if((p.group||"ДРУГИЕ")!==S.invGroupName)return false;
    const st=Number(p.stocks.find(x=>x.depotId===depotId)?.quantity||0);
    if(st<=0)return false;
    if(!q)return true;
    return [p.name,p.barcode,p.code].some(v=>String(v||"").toLowerCase().includes(q));
  }).sort((a,b)=>String(a.name||"").localeCompare(String(b.name||""),"ru"));
}
function renderInventory(reset=false){
  const depotId=$("invDepot").value;
  if(!depotId){
    $("inventoryList").innerHTML='<div class="muted">Выберите магазин.</div>';
    $("invMore").classList.add("hidden");
    return;
  }
  const depotName=S.depots.find(d=>d.id===depotId)?.name||"";
  const rows=inventoryFiltered();
  if(reset)S.invShown=0;
  S.invShown=Math.min(rows.length,S.invShown+150);
  const shown=rows.slice(0,S.invShown);
  $("inventoryList").innerHTML=shown.length?shown.map((p,i)=>{
    const qty=Number(p.stocks.find(x=>x.depotId===depotId)?.quantity||0);
    return '<div class="product invProduct" data-inv="'+i+'"><div class="name">'+esc(p.name)+'</div><div class="muted">'+esc(p.barcode||"—")+' · '+esc(p.price)+' MDL</div><div class="stock"><span>'+esc(depotName)+'</span><span class="qty">'+esc(qty)+'</span></div></div>';
  }).join(""):'<div class="notice">В этой группе нет товара с положительным остатком в выбранном магазине.</div>';
  $("invMore").classList.toggle("hidden",S.invShown>=rows.length);
  document.querySelectorAll(".invProduct").forEach(el=>el.addEventListener("click",()=>{
    const p=shown[Number(el.dataset.inv)];
    S.product=p;
    tab("searchTab");
    showProduct(p);
  }));
}
async function loadMonitoring(){
  $("monitorSummary").innerHTML='<div class="muted">Загружаю…</div>';
  $("monitorDepots").innerHTML="";
  try{
    const d=await api("/stock/api/monitoring");
    const age=d.cache?.at?Math.max(0,Math.round((Date.now()-Number(d.cache.at))/60000)):null;
    $("monitorSummary").innerHTML=
      '<div class="grid">'+
      '<div class="card" style="margin:0"><div class="muted">Товаров</div><div class="name" style="font-size:26px">'+esc(d.products)+'</div></div>'+
      '<div class="card" style="margin:0"><div class="muted">Активные перемещения</div><div class="name" style="font-size:26px">'+esc(d.activeTransfers)+'</div></div>'+
      '<div class="card" style="margin:0"><div class="muted">Новые расхождения</div><div class="name" style="font-size:26px">'+esc(d.openDiscrepancies)+'</div></div>'+
      '<div class="card" style="margin:0"><div class="muted">Остатки Provecta</div><div class="name">'+(d.cache?.ready?"Готовы":"Обновляются")+'</div><div class="muted">'+(age==null?"":("обновлены "+age+" мин. назад"))+'</div></div>'+
      '</div>';
    $("monitorDepots").innerHTML='<h3>По точкам</h3>'+d.perDepot.map(x=>
      '<div class="card"><div class="name">'+esc(x.depotName)+'</div>'+
      '<div class="stock"><span>Позиций в наличии</span><span class="qty">'+esc(x.positive)+'</span></div>'+
      '<div class="stock"><span>Нулевых позиций</span><span class="qty">'+esc(x.zero)+'</span></div>'+
      '<div class="stock"><span>Всего единиц товара</span><span class="qty">'+esc(Math.round(x.totalQty))+'</span></div></div>'
    ).join("");
  }catch(e){
    $("monitorSummary").innerHTML='<div class="notice bad">'+esc(e.message)+'</div>';
  }
}
async function loadRequests(){
  try{
    const d=await api("/stock/api/transfers");const groups={};
    d.items.forEach(x=>{const k=x.from_depot_name+" → "+x.to_depot_name;(groups[k]||(groups[k]=[])).push(x);});
    $("requests").innerHTML=Object.keys(groups).length?Object.entries(groups).map(([route,items])=>'<div class="route">'+esc(route)+' <span class="pill">'+items.length+'</span></div>'+items.map(x=>'<div class="req"><div class="name">'+esc(x.product_name)+' — '+esc(x.quantity)+' шт.</div><div class="muted">'+esc(x.employee)+' · '+new Date(x.created_at).toLocaleString()+' · '+statusRu(x.status)+'</div><div class="row" style="margin-top:6px">'+["APPROVED","PICKING","SENT","RECEIVED","CLOSED","REJECTED"].map(st=>'<button class="ghost st" data-id="'+x.id+'" data-st="'+st+'" style="padding:7px 9px">'+statusRu(st)+'</button>').join("")+'<button class="ghost delReq" data-id="'+x.id+'" style="padding:7px 9px">Удалить</button></div></div>').join("")).join(""):'<div class="muted">Заявок нет</div>';
    document.querySelectorAll(".st").forEach(b=>b.addEventListener("click",async()=>{await api("/stock/api/transfers/"+b.dataset.id,{method:"PATCH",body:JSON.stringify({status:b.dataset.st})});loadRequests();}));
    document.querySelectorAll(".delReq").forEach(b=>b.addEventListener("click",async()=>{if(!confirm("Удалить эту заявку?"))return;await api("/stock/api/transfers/"+b.dataset.id,{method:"DELETE"});loadRequests();}));
  }catch(e){$("requests").innerHTML='<div class="notice bad">'+esc(e.message)+'</div>';}
}
async function loadDiffs(){
  try{
    const d=await api("/stock/api/discrepancies");$("diffs").innerHTML=d.items.length?d.items.map(x=>'<div class="req"><div class="name">'+esc(x.product_name)+'</div><div>'+esc(x.depot_name)+': Provecta <b>'+esc(x.system_qty)+'</b> → факт <b>'+esc(x.actual_qty)+'</b> · разница <b>'+(Number(x.difference)>0?"+":"")+esc(x.difference)+'</b></div><div class="muted">'+esc(x.employee)+' · '+new Date(x.created_at).toLocaleString()+(x.comment?' · '+esc(x.comment):'')+'</div><button class="ghost delDiff" data-id="'+x.id+'" style="margin-top:8px">Удалить</button></div>').join(""):'<div class="muted">Расхождений нет</div>';
    document.querySelectorAll(".delDiff").forEach(b=>b.addEventListener("click",async()=>{if(!confirm("Удалить это расхождение?"))return;await api("/stock/api/discrepancies/"+b.dataset.id,{method:"DELETE"});loadDiffs();}));
  }catch(e){$("diffs").innerHTML='<div class="notice bad">'+esc(e.message)+'</div>';}
}
function showScanDiffForm(){
  $("scanDiffBox").innerHTML='<div class="card" style="margin:0"><label>Магазин<select id="scanDiffDepot">'+optionList()+'</select></label><label>Фактически посчитано<input id="scanActual" type="number" min="0" step="1"></label><label>Комментарий<textarea id="scanComment" rows="2" placeholder="Необязательно"></textarea></label><button id="scanSendDiff" class="primary" style="width:100%;margin-top:10px">Сообщить администратору</button><div id="scanDiffMsg" style="margin-top:8px"></div></div>';
  $("scanSendDiff").addEventListener("click",async()=>{
    try{
      const d=await api("/stock/api/discrepancies",{method:"POST",body:JSON.stringify({productId:S.product.id,barcode:S.product.barcode,depotId:$("scanDiffDepot").value,actualQty:Number($("scanActual").value),comment:$("scanComment").value})});
      msg($("scanDiffMsg"),"Отправлено. Разница: "+d.discrepancy.difference+" шт.","ok");
    }catch(e){msg($("scanDiffMsg"),e.message,"bad");}
  });
}
function showScanMoveForm(){
  $("scanMoveBox").innerHTML='<div class="card" style="margin:0"><div class="grid"><label>ОТКУДА<select id="scanFrom">'+optionList()+'</select></label><label>КУДА<select id="scanTo">'+optionList()+'</select></label></div><label>Количество<input id="scanQty" type="number" min="1" step="1" value="1"></label><button id="scanSendMove" class="primary" style="width:100%;margin-top:10px">Отправить заявку</button><div id="scanMoveMsg" style="margin-top:8px"></div></div>';
  $("scanSendMove").addEventListener("click",async()=>{
    try{
      const d=await api("/stock/api/transfers",{method:"POST",body:JSON.stringify({productId:S.product.id,barcode:S.product.barcode,fromDepotId:$("scanFrom").value,toDepotId:$("scanTo").value,quantity:Number($("scanQty").value)})});
      msg($("scanMoveMsg"),"Заявка №"+d.request.id+" отправлена.","ok");
    }catch(e){msg($("scanMoveMsg"),e.message,"bad");}
  });
}
async function stopScan(){
  if(S.scanTimer)clearInterval(S.scanTimer);
  S.scanTimer=null;
  try{if(S.zxingControls)S.zxingControls.stop();}catch{}
  S.zxingControls=null;
  if(S.stream){S.stream.getTracks().forEach(t=>t.stop());S.stream=null;}
  S.scanLocked=false;
  $("scanVideoWrap").classList.add("hidden");
  $("scanResult").classList.add("hidden");
}
function scanStockRows(p){
  return p.stocks.map(x=>{const q=x.quantity==null?"обновляется…":x.quantity;return '<div class="stock"><span>'+esc(x.depotName)+'</span><span class="qty '+(x.quantity!=null&&Number(x.quantity)<=0?"zero":"")+'">'+esc(q)+'</span></div>';}).join("");
}
async function fetchScannedProduct(v){
  const d=await api("/stock/api/search?q="+encodeURIComponent(v));
  return d.products?.[0]||null;
}
async function refreshScanStocks(v){
  for(let i=0;i<45;i++){
    if(!S.scanLocked||S.lastScanned!==v)return;
    try{
      const d=await api("/stock/api/search?q="+encodeURIComponent(v));
      const p=d.products?.[0];
      if(p && !p.stocks?.some(x=>x.quantity==null)){
        S.product=p;
        const box=$("scanStocks");
        if(box)box.innerHTML=scanStockRows(p);
        msg($("scanInfo"),"Товар найден. Остатки загружены.","ok");
        return;
      }
    }catch{}
    await new Promise(r=>setTimeout(r,2000));
  }
  const box=$("scanStocks");
  if(box)box.innerHTML='<div class="notice bad">Не удалось получить остатки. Нажмите «Обновить остатки».</div><button id="scanRetryStock" class="ghost" style="width:100%;margin-top:8px">Обновить остатки</button>';
  if($("scanRetryStock"))$("scanRetryStock").addEventListener("click",()=>refreshScanStocks(v));
}
async function handleScannedCode(v){
  if(S.scanLocked)return;
  S.scanLocked=true;
  S.lastScanned=v;
  scanFeedback();
  flashScanFrame();
  msg($("scanInfo"),"Штрихкод найден: "+v+". Загружаю остатки…","ok");
  try{
    const p=await fetchScannedProduct(v);
    if(!p){
      $("scanResult").classList.remove("hidden");
      $("scanResult").innerHTML='<div class="name">Товар не найден</div><div class="muted">Штрихкод: '+esc(v)+'</div><button id="scanNext" class="primary" style="width:100%;margin-top:12px">Дальше</button>';
    }else{
      S.product=p;
      $("scanResult").classList.remove("hidden");
      $("scanResult").innerHTML=
        '<div class="row"><div class="grow"><div class="name" style="font-size:20px">'+esc(p.name)+'</div><div class="muted">Штрихкод: '+esc(p.barcode||v)+' · Цена: '+esc(p.price)+' MDL</div></div></div>'+
        '<h4>Остатки</h4><div id="scanStocks">'+scanStockRows(p)+'</div>'+
        '<div class="grid" style="margin-top:14px"><button id="scanMove" class="ghost">Запросить перемещение</button><button id="scanDiff" class="ghost">Есть расхождение</button></div><button id="scanNext" class="primary" style="width:100%;margin-top:10px">Дальше</button><div id="scanMoveBox" style="margin-top:10px"></div><div id="scanDiffBox" style="margin-top:10px"></div>';
      if(p.stocks?.some(x=>x.quantity==null)){
        msg($("scanInfo"),"Товар найден. Получаю остатки…");
        refreshScanStocks(v);
      }else{
        msg($("scanInfo"),"Товар найден. Остатки загружены.","ok");
      }
    }
    if($("scanMove"))$("scanMove").addEventListener("click",showScanMoveForm);
    if($("scanDiff"))$("scanDiff").addEventListener("click",showScanDiffForm);
    $("scanNext").addEventListener("click",()=>{
      $("scanResult").classList.add("hidden");
      $("scanResult").innerHTML="";
      S.scanLocked=false;
      S.lastScanned="";
      msg($("scanInfo"),"Камера включена. Наведите на следующий штрихкод.","ok");
    });
  }catch(e){
    $("scanResult").classList.remove("hidden");
    $("scanResult").innerHTML='<div class="notice bad">'+esc(e.message)+'</div><button id="scanNext" class="primary" style="width:100%;margin-top:12px">Дальше</button>';
    $("scanNext").addEventListener("click",()=>{
      $("scanResult").classList.add("hidden");
      S.scanLocked=false;
      msg($("scanInfo"),"Камера включена. Наведите на следующий штрихкод.","ok");
    });
  }
}
async function startScan(){
  initScanAudio();
  if(S.stream||S.zxingControls){
    S.scanLocked=false;
    $("scanResult").classList.add("hidden");
    msg($("scanInfo"),"Камера уже включена. Наведите на штрихкод.","ok");
    return;
  }
  msg($("scanInfo"),"Запускаю сканер…");
  try{
    $("scanVideoWrap").classList.remove("hidden");

    // Открываем заднюю камеру сами: 720p быстрее и стабильнее для распознавания,
    // чем 4K. facingMode ideal позволяет браузеру выбрать реальную заднюю камеру
    // даже на телефонах, где exact работает нестабильно.
    const stream=await navigator.mediaDevices.getUserMedia({
      audio:false,
      video:{
        facingMode:{ideal:"environment"},
        width:{ideal:1280},
        height:{ideal:720},
        frameRate:{ideal:30}
      }
    });
    S.stream=stream;
    $("video").srcObject=stream;
    await $("video").play();
    await tuneCamera(stream.getVideoTracks?.()[0]);

    let scannerStarted=false;

    // Основной сканер ZXing — работает и там, где BarcodeDetector отсутствует.
    if(window.ZXingBrowser){
      const reader=new ZXingBrowser.BrowserMultiFormatReader();
      S.zxingControls=await reader.decodeFromStream(stream,$("video"),(result,error,controls)=>{
        if(result&&!S.scanLocked){
          const v=String(result.getText ? result.getText() : result.text || "").trim();
          if(v)handleScannedCode(v);
        }
      });
      scannerStarted=true;
    }

    // Дополнительный параллельный распознаватель, если браузер его поддерживает.
    // Он использует тот же видеопоток и повышает шанс быстрого чтения.
    if("BarcodeDetector" in window){
      try{
        const formats=await BarcodeDetector.getSupportedFormats?.().catch?.(()=>[]) || [];
        const wanted=["ean_13","ean_8","code_128","code_39","upc_a","upc_e","itf"];
        const use=formats.length?wanted.filter(x=>formats.includes(x)):wanted;
        const det=new BarcodeDetector(use.length?{formats:use}:{});
        S.scanTimer=setInterval(async()=>{
          if(S.scanLocked)return;
          try{
            const codes=await det.detect($("video"));
            const v=String(codes?.[0]?.rawValue||"").trim();
            if(v)handleScannedCode(v);
          }catch{}
        },250);
        scannerStarted=true;
      }catch{}
    }

    if(!scannerStarted)throw new Error("Модуль сканера не загружен");

    try{localStorage.setItem("pudraCameraReady","1");}catch{}
    msg($("scanInfo"),"Камера включена. Наведите штрихкод в рамку.","ok");
  }catch(e){
    await stopScan();
    const m=String(e?.message||"не удалось запустить");
    msg($("scanInfo"),/Overconstrained|constraint|environment/i.test(m)?"Не удалось открыть заднюю камеру. Проверьте разрешение камеры в браузере.":"Ошибка сканера: "+m,"bad");
  }
}

async function switchCamera(){
  try{
    if(!S.cameraIds.length){
      const all=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput");
      const rear=all.filter(d=>!/front|user|selfie|facing front/i.test(d.label||""));
      S.cameraIds=(rear.length?rear:all).map(d=>d.deviceId);
    }
    if(S.cameraIds.length<2){
      msg($("scanInfo"),"На телефоне доступна только одна камера для браузера.","bad");
      return;
    }
    S.cameraIndex=(S.cameraIndex+1)%S.cameraIds.length;
    await stopScan();
    await startScan();
  }catch(e){
    msg($("scanInfo"),"Не удалось сменить камеру: "+(e?.message||"ошибка"),"bad");
  }
}

$("loginBtn").addEventListener("click",()=>login(false));$("role").addEventListener("change",updatePinVisibility);$("searchBtn").addEventListener("click",()=>search());$("search").addEventListener("keydown",e=>{if(e.key==="Enter")search();});$("refreshBtn").addEventListener("click",refresh);
$("startScan").addEventListener("click",startScan);$("stopScan").addEventListener("click",stopScan);$("invReload").addEventListener("click",()=>{S.inventory=[];loadInventory();});$("groupSearch").addEventListener("input",renderGroupList);$("invBack").addEventListener("click",()=>{$("inventoryHome").classList.remove("hidden");$("inventoryGroupView").classList.add("hidden");renderGroupList();});$("invDepot").addEventListener("change",()=>renderInventory(true));$("invSearch").addEventListener("input",()=>renderInventory(true));$("invMore").addEventListener("click",()=>renderInventory(false));$("reloadReq").addEventListener("click",loadRequests);$("reloadDiff").addEventListener("click",loadDiffs);$("reloadMonitor").addEventListener("click",loadMonitoring);
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>tab(b.dataset.tab)));
updatePinVisibility();
restoreLogin();
})();