import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./stock/app.js',import.meta.url),'utf8');
function fixture(api){
 const els=new Map(), timers=new Map();let n=0,renders=0;
 const $=id=>{if(!els.has(id))els.set(id,{classList:{remove(){},add(){}},addEventListener(k,f){this.click=f;}});return els.get(id);};
 const c={S:{inventory:[]},$,api,esc:String,renderGroupList(){renders++;},setTimeout(f){timers.set(++n,f);return n;},clearTimeout(id){timers.delete(id);}};
 vm.createContext(c);vm.runInContext(source.slice(source.indexOf('let inventoryLoadVersion'),source.indexOf('function availableGroups')),c);
 return {c,timers,$,renders:()=>renders};
}
test('incomplete stock is polled automatically and only complete stock is rendered',async()=>{
 let calls=0;const f=fixture(async(u,opt)=>{assert.equal(opt.timeoutMs,45000);return ++calls===1?{products:[{id:'partial'}],cache:{ready:false,readyDepots:2}}:{products:[{id:'complete'}],cache:{ready:true}};});
 await f.c.loadInventory();assert.equal(f.c.S.inventory.length,0);assert.equal(f.renders(),0);assert.equal(f.timers.size,1);
 await [...f.timers.values()][0]();assert.equal(f.c.S.inventory[0].id,'complete');assert.equal(f.renders(),1);assert.equal(f.timers.size,0);
});
test('late response cannot overwrite newer inventory load',async()=>{
 let release,calls=0;const gate=new Promise(r=>release=r);
 const f=fixture(async()=>{if(++calls===1){await gate;return {products:[{id:'old'}]};}return {products:[{id:'new'}]};});
 const pending=f.c.loadInventory();await f.c.loadInventory();release();await pending;assert.equal(f.c.S.inventory[0].id,'new');
});
test('authentication errors do not trigger automatic retries',async()=>{
 const f=fixture(async()=>{throw Error('401');});await f.c.loadInventory();assert.equal(f.timers.size,0);
});
