import test from 'node:test';
import assert from 'node:assert/strict';
import {createShopCatalog,PUBLIC_STORES} from './shop_catalog.js';
const helpers={simpleArticle:a=>a,idOf:x=>typeof x==='string'?x:x?.Id,asArray:x=>Array.isArray(x)?x:x?.items||[]};
test('public branch view uses verified cache, excludes technical warehouses and hides stock counts',async()=>{
 let balanceCalls=0;
 const handle=createShopCatalog({...helpers,getArticles:async()=>[{id:'a',name:'Product',price:10,cost:2},{id:'b',name:'Only technical warehouse',price:2}],apiGet:async()=>{balanceCalls++;return []},getStockCacheState:()=>({ready:true,lastSuccessAt:Date.now()}),getCachedStocks:id=>id==='a'?[{id:PUBLIC_STORES[0].id,quantity:8,loading:false},{id:PUBLIC_STORES[1].id,quantity:0,loading:false},{id:'private-warehouse',quantity:100}]:[{id:'private-warehouse',quantity:9}]});
 let status,body;await handle({method:'GET',headers:{}},{writeHead:s=>status=s,end:s=>body=JSON.parse(s)},new URL('https://test/shop/api/branches'));
 assert.equal(status,200);assert.equal(body.products.length,1);assert.equal(body.products[0].quantity,0);assert.equal(body.products[0].stores.length,1);assert.equal(body.products[0].stores[0].nameRu,'Оргееве');assert.equal(body.products[0].cost,undefined);assert.equal(balanceCalls,1);
});
test('stale cache does not become fresh public availability',async()=>{
 const handle=createShopCatalog({...helpers,getArticles:async()=>[],apiGet:async()=>[],getStockCacheState:()=>({ready:true,lastSuccessAt:Date.now()-700000}),getCachedStocks:()=>[]});let status;await handle({method:'GET',headers:{}},{writeHead:s=>status=s,end:()=>{}},new URL('https://test/shop/api/branches'));assert.equal(status,503);
});
test('an initially cold cache can recover without restarting the server',async()=>{
 let ready=false;
 const handle=createShopCatalog({...helpers,getArticles:async()=>[{id:'a',name:'Product',price:10}],apiGet:async()=>[],getStockCacheState:()=>({ready,lastSuccessAt:ready?Date.now():0}),getCachedStocks:()=>[{id:PUBLIC_STORES[0].id,quantity:2}]});
 const request=async()=>{let status;await handle({method:'GET',headers:{}},{writeHead:s=>status=s,end:()=>{}},new URL('https://test/shop/api/branches'));return status};
 assert.equal(await request(),503);ready=true;assert.equal(await request(),200);
});
