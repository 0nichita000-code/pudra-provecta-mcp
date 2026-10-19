(()=>{
const S={user:"",role:"staff",pin:"",depots:[],product:null,stream:null,scanTimer:null,watchTimer:null,lastTransferId:0,lastDiffId:0};
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
  if(last?.name==="AbortError")throw new Error("Сервер отвечает слишком долго. Повторите вход.");
  if(String(last?.message||"").includes("Failed to fetch"))throw new Error("Не удалось связаться с сервером. Обновите страницу и попробуйте ещё раз.");
  throw last;
}
function msg(el,text,type=""){el.innerHTML=text?'<div class="notice '+type+'">'+esc(text)+'</div>':"";}

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

function tab(id){document.querySelectorAll(".tabPanel").forEach(x=>x.classList.add("hidden"));$(id).classList.remove("hidden");document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.tab===id));if(id==="adminTab")loadRequests();if(id==="diffTab")loadDiffs();}
async function login(){
  S.user=$("userName").value.trim();S.role=$("role").value;S.pin=$("pin").value;
  if(!S.user||!S.pin)return msg($("loginMsg"),"Введите имя и PIN","bad");
  try{const m=await api("/stock/api/meta");S.depots=m.depots;$("login").classList.add("hidden");$("app").classList.remove("hidden");$("who").textContent=S.user+(S.role==="admin"?" · админ":"");document.querySelectorAll(".adminOnly").forEach(x=>x.classList.toggle("hidden",S.role!=="admin"));msg($("loginMsg"),"");if(S.role==="admin")startAdminWatch();}
  catch(e){msg($("loginMsg"),e.message,"bad");}
}
function stockRows(p){return p.stocks.map(x=>'<div class="stock"><span>'+esc(x.depotName)+'</span><span class="qty '+(Number(x.quantity)<=0?"zero":"")+'">'+esc(x.quantity)+'</span></div>').join("");}
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
async function loadRequests(){
  try{
    const d=await api("/stock/api/transfers");const groups={};
    d.items.forEach(x=>{const k=x.from_depot_name+" → "+x.to_depot_name;(groups[k]||(groups[k]=[])).push(x);});
    $("requests").innerHTML=Object.keys(groups).length?Object.entries(groups).map(([route,items])=>'<div class="route">'+esc(route)+' <span class="pill">'+items.length+'</span></div>'+items.map(x=>'<div class="req"><div class="name">'+esc(x.product_name)+' — '+esc(x.quantity)+' шт.</div><div class="muted">'+esc(x.employee)+' · '+new Date(x.created_at).toLocaleString()+' · '+statusRu(x.status)+'</div><div class="row" style="margin-top:6px">'+["APPROVED","PICKING","SENT","RECEIVED","CLOSED","REJECTED"].map(st=>'<button class="ghost st" data-id="'+x.id+'" data-st="'+st+'" style="padding:7px 9px">'+statusRu(st)+'</button>').join("")+'</div></div>').join("")).join(""):'<div class="muted">Заявок нет</div>';
    document.querySelectorAll(".st").forEach(b=>b.addEventListener("click",async()=>{await api("/stock/api/transfers/"+b.dataset.id,{method:"PATCH",body:JSON.stringify({status:b.dataset.st})});loadRequests();}));
  }catch(e){$("requests").innerHTML='<div class="notice bad">'+esc(e.message)+'</div>';}
}
async function loadDiffs(){
  try{
    const d=await api("/stock/api/discrepancies");$("diffs").innerHTML=d.items.length?d.items.map(x=>'<div class="req"><div class="name">'+esc(x.product_name)+'</div><div>'+esc(x.depot_name)+': Provecta <b>'+esc(x.system_qty)+'</b> → факт <b>'+esc(x.actual_qty)+'</b> · разница <b>'+(Number(x.difference)>0?"+":"")+esc(x.difference)+'</b></div><div class="muted">'+esc(x.employee)+' · '+new Date(x.created_at).toLocaleString()+(x.comment?' · '+esc(x.comment):'')+'</div></div>').join(""):'<div class="muted">Расхождений нет</div>';
  }catch(e){$("diffs").innerHTML='<div class="notice bad">'+esc(e.message)+'</div>';}
}
async function stopScan(){if(S.scanTimer)clearInterval(S.scanTimer);S.scanTimer=null;try{if(S.zxingControls)S.zxingControls.stop();}catch{}S.zxingControls=null;if(S.stream){S.stream.getTracks().forEach(t=>t.stop());S.stream=null;}$("video").classList.add("hidden");}
async function startScan(){
  await stopScan();msg($("scanInfo"),"Запускаю камеру…");
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}}});S.stream=stream;$("video").srcObject=stream;await $("video").play();$("video").classList.remove("hidden");
    if("BarcodeDetector" in window){
      const det=new BarcodeDetector({formats:["ean_13","ean_8","code_128","upc_a","upc_e"]});
      S.scanTimer=setInterval(async()=>{try{const codes=await det.detect($("video"));if(codes[0]?.rawValue){const v=codes[0].rawValue;await stopScan();tab("searchTab");$("search").value=v;search(v);}}catch{}},500);
      msg($("scanInfo"),"Наведите камеру на штрихкод.","ok");
    }else{
      msg($("scanInfo"),"Подключаю сканер для iPhone…");
      try{
        const zxing=await import("https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm");
        const reader=new zxing.BrowserMultiFormatReader();
        if(S.stream){S.stream.getTracks().forEach(t=>t.stop());S.stream=null;}
        $("video").srcObject=null;
        S.zxingControls=await reader.decodeFromVideoDevice(undefined,$("video"),async(result,error,controls)=>{
          if(result){
            const v=result.getText();
            try{controls.stop();}catch{}
            S.zxingControls=null;
            tab("searchTab");$("search").value=v;search(v);
          }
        });
        $("video").classList.remove("hidden");
        msg($("scanInfo"),"Наведите камеру на штрихкод.","ok");
      }catch(e){
        msg($("scanInfo"),"Не удалось запустить сканер. Разрешите камеру и попробуйте ещё раз.","bad");
      }
    }
  }catch(e){msg($("scanInfo"),"Нет доступа к камере: "+e.message,"bad");}
}
$("loginBtn").addEventListener("click",login);$("searchBtn").addEventListener("click",()=>search());$("search").addEventListener("keydown",e=>{if(e.key==="Enter")search();});$("refreshBtn").addEventListener("click",refresh);
$("startScan").addEventListener("click",startScan);$("stopScan").addEventListener("click",stopScan);$("reloadReq").addEventListener("click",loadRequests);$("reloadDiff").addEventListener("click",loadDiffs);
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>tab(b.dataset.tab)));
})();