(()=>{
"use strict";
const $=id=>document.getElementById(id), BASE="https://pudra-provecta-mcp.onrender.com";
let current=null, stream=null, scanLoop=null, busy=false, zxingReader=null, zxingControls=null;
const escape=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function profile(){try{const x=JSON.parse(localStorage.getItem("pudraStockLogin")||"{}");if(x.role==="staff")x.pin=sessionStorage.getItem("pudraStoreSession")||"";return x}catch{return {}}}
function depot(){return $("myDepot").value}
async function request(path,method="GET",data=null){
 const u=profile(),r=await fetch(BASE+path,{method,headers:{"content-type":"application/json","x-pudra-user":encodeURIComponent(u.user||""),"x-pudra-role":u.role||"staff","x-pudra-pin":u.pin||"","x-pudra-depot":u.depotId||""},body:data===null?undefined:JSON.stringify(data)});
 const v=await r.json().catch(()=>({}));if(!r.ok)throw Error(v.error||"Ошибка "+r.status);return v;
}
function msg(s){$("countInfo").textContent=s}
function tableCSV(text){
 const t=text.replace(/^\uFEFF/,"");const first=t.split(/\r?\n/)[0]||"";
 const sep=first.includes("\t")?"\t":((first.match(/;/g)||[]).length >= (first.match(/,/g)||[]).length?";":",");
 let rows=[],row=[],field="",quoted=false;
 for(let i=0;i<t.length;i++){const c=t[i];
  if(c==='"'){if(quoted&&t[i+1]==='"'){field+='"';i++}else quoted=!quoted}
  else if(c===sep&&!quoted){row.push(field);field=""}
  else if((c==="\r"||c==="\n")&&!quoted){if(c==="\r"&&t[i+1]==="\n")i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field=""}
  else field+=c;
 }
 row.push(field);if(row.some(x=>x.trim()))rows.push(row);return rows;
}
function saveCSV(filename,rows){
 const q=x=>'"'+String(x??"").replace(/"/g,'""')+'"';
 const b=new Blob(["\uFEFF"+rows.map(r=>r.map(q).join(";")).join("\r\n")],{type:"text/csv;charset=utf-8"});
 const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=filename.replace(/[\\/:*?"<>|]/g,"_")+".csv";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
}
async function initialize(){
 const p=profile();if(!p.user)return;
 try{
 const m=await request("/stock/api/meta");
 const options=m.depots.map(d=>'<option value="'+escape(d.id)+'">'+escape(d.name)+'</option>').join("");
 const previous=localStorage.getItem("pudraMyDepot")||"";
 $("myDepot").innerHTML=options;$("countUploadDepot").innerHTML=options;
 $("myDepot").disabled=p.role!=="admin";
 if(p.role==="staff"&&m.depots.some(d=>d.id===p.depotId))$("myDepot").value=p.depotId;
 else if(m.depots.some(d=>d.id===previous))$("myDepot").value=previous;
 localStorage.setItem("pudraMyDepot",depot());
 $("countAdmin").classList.toggle("hidden",p.role!=="admin");
 await refresh();
 }catch(e){msg("Не удалось подключиться: "+e.message)}
}
async function refresh(){
 if(!depot())return;
 current=null;$("countEditor").classList.add("hidden");$("countDocs").classList.remove("hidden");msg("Загружаю документы…");
 try{const data=await request("/stock/api/count-documents?depotId="+encodeURIComponent(depot()));
 const items=data.items.filter(x=>x.depotId===depot());
 msg(items.length?"Документов магазина: "+items.length:"Документов для этого магазина пока нет.");
 $("countDocs").innerHTML=items.map(x=>'<button class="ghost countOpen" data-id="'+escape(x.id)+'" style="width:100%;text-align:left;margin-top:8px"><strong>'+escape(x.title)+'</strong><div class="muted">'+(x.type==="receipt"?"Приёмка":"Инвентаризация")+' · проверено '+x.checked+' из '+x.items+'</div></button>').join("");
 $("countDocs").querySelectorAll(".countOpen").forEach(el=>el.onclick=()=>open(el.dataset.id))
 }catch(e){msg("Ошибка загрузки: "+e.message)}
}
async function open(id){
 try{const v=await request("/stock/api/count-documents/"+id+"?depotId="+encodeURIComponent(depot()));current=v.document;
 $("countTitle").textContent=current.title;$("countFind").value="";
 $("countDocs").classList.add("hidden");$("countEditor").classList.remove("hidden");render();
 }catch(e){alert(e.message)}
}
function render(){
 if(!current)return;
 const q=$("countFind").value.trim().toLowerCase();
 const matched=current.items.map((x,i)=>({x,i})).filter(({x})=>!q||x.barcode.toLowerCase().includes(q)||x.name.toLowerCase().includes(q)).slice(0,100);
 const completed=current.items.filter(x=>x.actual!==null).length;
 $("countLines").innerHTML='<p class="muted">Проверено '+completed+' из '+current.items.length+'. Не проверено ≠ ноль.</p>'+matched.map(({x,i})=>'<div class="card" style="padding:12px;margin:8px 0"><strong>'+escape(x.name)+'</strong><div class="muted">'+escape(x.barcode)+'</div><div>Должно быть: <strong>'+x.expected+'</strong> · Факт: <strong>'+(x.actual===null?"не проверено":x.actual)+'</strong></div><div class="row"><input class="countQty" data-i="'+i+'" type="number" min="0" step="1" value="'+(x.actual===null?"":x.actual)+'" placeholder="Фактически" style="max-width:150px"><button class="primary countSave" data-i="'+i+'">Сохранить</button></div></div>').join("");
 $("countLines").querySelectorAll(".countSave").forEach(el=>el.onclick=async()=>{const i=Number(el.dataset.i),input=$("countLines").querySelector('.countQty[data-i="'+i+'"]'),n=input.value.trim();if(n===""||!Number.isSafeInteger(Number(n))||Number(n)<0)return alert("Введите целое количество от нуля");
 try{await request("/stock/api/count-documents/"+current.id+"?depotId="+encodeURIComponent(depot()),"PATCH",{index:i,actual:Number(n)});current.items[i].actual=Number(n);render()}catch(e){alert(e.message)}});
}
async function upload(){
 const file=$("countFile").files[0];const pasted=$("countPaste").value.trim();if(!file&&!pasted){alert("Выберите Excel/CSV или вставьте таблицу");return}
 try{
 let arr;
 if(pasted){arr=tableCSV(pasted);}
 else if(/\.(xlsx|xls)$/i.test(file.name)){
   if(!window.XLSX)throw Error("Модуль Excel не загрузился. Откройте приложение в Safari и повторите.");
   const wb=window.XLSX.read(await file.arrayBuffer(),{type:"array",raw:true});
   const sheet=wb.Sheets[wb.SheetNames[0]];
   arr=window.XLSX.utils.sheet_to_json(sheet,{header:1,defval:"",raw:true}).map(row=>row.map(v=>String(v??"")));
 }else{arr=tableCSV(await file.text());}
 if(!arr.length)throw Error("Файл пуст.");
 const hdr=arr.shift().map(s=>s.trim().toLowerCase());
 const find=terms=>hdr.findIndex(s=>terms.some(t=>s.includes(t)));
 const n=find(["назван","name","denum"]),b=find(["штрих","barcode","cod de bare"]),q=find(["колич","quantity","cantitat"]);
 if(n<0||b<0||q<0)throw Error("Нужны столбцы НАЗВАНИЕ, ШТРИХКОД, КОЛИЧЕСТВО");
 const map=new Map();for(const row of arr){const code=String(row[b]||"").trim();if(!code)continue;const amount=Number(String(row[q]||"").trim().replace(",","."));if(!Number.isFinite(amount)||amount<0)throw Error("Некорректное количество: "+code);const prev=map.get(code);if(prev)prev.expected+=amount;else map.set(code,{name:row[n]||"",barcode:code,expected:amount})}
 const items=[...map.values()];if(!items.length)throw Error("Нет товаров с штрихкодами");
 const d=await request("/stock/api/count-documents","POST",{title:$("countDocName").value.trim()||(file?file.name:"Документ из таблицы"),depotId:$("countUploadDepot").value,type:$("countDocType").value,items});
 $("countUploadInfo").textContent="Готово: загружено "+items.length+" позиций. Документ №"+d.id;
 if($("countUploadDepot").value===depot())refresh();
 }catch(e){$("countUploadInfo").textContent="Не загружено: "+e.message}
}
async function ensureScannerLibrary(){
 if(window.ZXingBrowser?.BrowserMultiFormatReader)return;
 const sources=["https://pudra-provecta-mcp.onrender.com/stock/zxing.js","https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/zxing-browser.min.js"];
 for(const src of sources){
  try{await new Promise((resolve,reject)=>{const el=document.createElement("script");el.src=src+"?refresh="+Date.now();el.onload=resolve;el.onerror=()=>reject(Error("Скрипт не загрузился"));document.head.appendChild(el);setTimeout(()=>reject(Error("Превышено время загрузки")),10000)});if(window.ZXingBrowser?.BrowserMultiFormatReader)return}catch(e){console.warn("PUDRA scanner source",src,e)}
 }
 throw Error("Библиотека сканирования не загрузилась. Проверьте интернет и повторите.");
}
let sharedCameraActive=false;
async function camera(){
 const scanner=window.PUDRA_SHARED_SCANNER;
 if(!current)return;
 if(!scanner){alert("Основной сканер ещё не загрузился. Откройте приложение заново.");return}
 if(sharedCameraActive){await stopCamera();return}
 try{
  await scanner.stop();
  const wrap=$("scanVideoWrap"), editor=$("countEditor");
  if(!wrap||!editor)throw Error("Окно основного сканера не найдено");
  $("countScan").after(wrap);
  scanner.setHandler(code=>{
   const scanned=String(code||"").trim();
   if(!scanned||!current)return;
   $("countFind").value=scanned;
   render();
   if(!current.items.some(x=>x.barcode===scanned))alert("Товара нет в документе: "+scanned);
  });
  sharedCameraActive=true;
  $("countScan").textContent="Остановить сканирование";
  await scanner.start();
  if(wrap.classList.contains("hidden"))throw Error("Камера не запустилась");
 }catch(e){await stopCamera();alert("Ошибка сканера приёмки: "+String(e?.message||e))}
}
async function stopCamera(){
 const scanner=window.PUDRA_SHARED_SCANNER;
 if(scanner){scanner.setHandler(null);await scanner.stop()}
 const wrap=$("scanVideoWrap"),target=$("scanResult");
 if(wrap&&target)target.after(wrap);
 sharedCameraActive=false;
 $("countScan").textContent="Сканировать штрихкод";
}
$("myDepot").onchange=()=>{localStorage.setItem("pudraMyDepot",depot());stopCamera();refresh()};
$("countBack").onclick=()=>{stopCamera();refresh()};
$("countFind").oninput=render;
$("countScan").onclick=camera;
$("countUpload").onclick=upload;
$("countFile").addEventListener("change",()=>{$("countSelectedFile").textContent=$("countFile").files[0]?.name||"Файл не выбран"});
$("countExport").onclick=()=>{if(!current)return;saveCSV(current.title+" - результат",[["НАЗВАНИЕ","ШТРИХКОД","КОЛИЧЕСТВО","ПО ДОКУМЕНТУ","РАЗНИЦА","СТАТУС"],...current.items.map(x=>[x.name,x.barcode,x.actual===null?"":x.actual,x.expected,x.actual===null?"":x.actual-x.expected,x.actual===null?"НЕ ПРОВЕРЕНО":"ПРОВЕРЕНО"])])};
document.querySelector('[data-tab="countTab"]').addEventListener("click",initialize);
$("loginBtn").addEventListener("click",()=>setTimeout(initialize,1800));
setTimeout(initialize,3200);
})();