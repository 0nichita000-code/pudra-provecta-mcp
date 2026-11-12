import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./stock/app.js',import.meta.url),'utf8');
const fetchFn=source.slice(source.indexOf('async function fetchScannedProduct'),source.indexOf('async function refreshScanStocks'));
const handleFn=source.slice(source.indexOf('async function handleScannedCode'),source.indexOf('async function startScan'));
function fixture(api){const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',classList:{remove(){},add(){}},addEventListener(name,fn){this.listener=fn;}});return elements.get(id)};
 const c={S:{scanLocked:false,lastScanned:''},$:get,esc:String,msg:(el,s)=>{el.innerHTML=s},scanFeedback(){},flashScanFrame(){},setTimeout,clearTimeout,api};vm.createContext(c);vm.runInContext(fetchFn+handleFn,c);return {c,get};}
test('scanner tolerates response slower than former 3.5-second limit',async()=>{
 const {c}=fixture(async(url,opt)=>{assert.match(url,/scan=1/);assert.equal(opt.timeoutMs,45000);assert.equal(opt.retries,0);await new Promise(r=>setTimeout(r,3600));return {products:[{id:'found'}]}});
 const p=await c.fetchScannedProduct('8809982982777');assert.equal(p.id,'found');
});
test('failed scan clears pending message and offers retry for same barcode',async()=>{
 let calls=0;const {c,get}=fixture(async()=>{calls++;throw Error('Сервер не успел ответить.')});
 await c.handleScannedCode('8809982982777');assert.match(get('scanInfo').innerHTML,/Проверка не завершена/);assert.match(get('scanResult').innerHTML,/Повторить проверку/);assert.ok(!get('scanInfo').innerHTML.includes('Проверяю'));
 get('scanRetry').listener();await new Promise(r=>setTimeout(r,0));assert.equal(calls,2);
 get('scanNext').listener();assert.equal(c.S.scanLocked,false);assert.equal(c.S.lastScanned,'');
});
test('stopped scan ignores late lookup result',async()=>{let release;const gate=new Promise(r=>release=r);const {c,get}=fixture(async()=>{await gate;return {products:[]}});const job=c.handleScannedCode('8809982982777');c.S.scanLocked=false;c.S.lastScanned='';get('scanResult').innerHTML='unchanged';release();await job;assert.equal(get('scanResult').innerHTML,'unchanged');});
import {createStockApp} from './stock_app.js';
test('scanner route applies short gallery budget and retains authentication',async()=>{
 const old=process.env.STOCK_ADMIN_PIN;process.env.STOCK_ADMIN_PIN='scan-test-only';let budget;
 try{
 const handler=createStockApp({getArticles:async()=>[{Id:'p',Name:'Test',Barcode:'8809982982777'}],getDepots:async()=>[{id:'d',name:'DEPOZIT RISCANI'}],simpleDepot:x=>x,simpleArticle:a=>({id:a.Id,name:a.Name,barcode:a.Barcode}),idOf:a=>a.Id,articleBarcodes:()=>[],getCachedStocks:()=>[],getStockCacheState:()=>({ready:true}),enrichPhotos:async(p,opt)=>{budget=opt?.timeoutMs;return p;}});
 async function call(scan,pin){let status,body;await handler({method:'GET',headers:{'x-pudra-pin':pin,'x-pudra-role':'admin'}},{writeHead(s){status=s},end(b){body=JSON.parse(b)}},new URL('https://test/stock/api/search?q=8809982982777'+(scan?'&scan=1':'')));return {status,body};}
 assert.equal((await call(true,'wrong')).status,401);const fast=await call(true,'scan-test-only');assert.equal(fast.status,200);assert.equal(fast.body.products[0].id,'p');assert.equal(budget,250);await call(false,'scan-test-only');assert.equal(budget,undefined);
 }finally{if(old===undefined)delete process.env.STOCK_ADMIN_PIN;else process.env.STOCK_ADMIN_PIN=old;}
});
