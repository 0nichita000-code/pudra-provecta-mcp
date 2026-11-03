import {test} from 'node:test';import assert from 'node:assert/strict';import {createControlSync} from './control_sync.js';
test('read-only snapshot is authenticated, paged and explicit about failed depots',async()=>{
 const old=process.env.CONTROL_SYNC_TOKEN;process.env.CONTROL_SYNC_TOKEN='test-secret-not-a-real-credential';
 try{
  const h=createControlSync({getArticles:async()=>[{id:'p',name:'Товар',barcode:'001'}],getDepots:async()=>[{id:'a',name:'A'},{id:'b',name:'B'}],simpleArticle:a=>a,simpleDepot:a=>a,idOf:x=>typeof x==='string'?x:x?.id,articleBarcodes:()=>[],apiGet:async(p,q)=>{if(q.depotId[0]==='b')throw Error('Timeout');return [{Article:'p',BalanceQuantitySum:-1}]},asArray:x=>x,getIndexedBarcodes:()=>['002'],getAlternateIndexStatus:()=>({scanned:0,total:1}),startBulkBarcodeSync(){},getBulkBarcodeStatus:()=>({complete:false})});
  async function call(query='',token='test-secret-not-a-real-credential',method='GET'){let status,data;const res={writeHead(c){status=c},end(x){data=JSON.parse(x)}};await h({method,headers:{authorization:'Bearer '+token}},res,new URL('http://localhost/control/sync'+query));return {status,data}}
  assert.equal((await call('','wrong')).status,401);assert.equal((await call('','test-secret-not-a-real-credential','POST')).status,405);
  await call('?start=1');let state;for(let i=0;i<20;i++){state=(await call()).data;if(!state.running)break;await new Promise(r=>setImmediate(r))}
  assert.ok(state.latest);const page=(await call('?generation='+state.latest.id+'&offset=0')).data;assert.equal(page.total,1);assert.deepEqual(page.products[0].additionalBarcodes,['002']);assert.equal(page.balances[0].quantity,-1);assert.equal(page.stockStatus.find(d=>d.depot==='b').complete,false);assert.equal(page.alternate.bulk.complete,false);
  assert.equal((await call('?generation=expired')).status,409);
 }finally{if(old===undefined)delete process.env.CONTROL_SYNC_TOKEN;else process.env.CONTROL_SYNC_TOKEN=old}
});
