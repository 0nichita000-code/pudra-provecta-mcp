import test from 'node:test';
import assert from 'node:assert/strict';
import {publicProducts,SHOP_DEPOT} from './shop_catalog.js';
const helpers={simpleArticle:a=>a,idOf:x=>typeof x==='string'?x:x?.Id,asArray:x=>Array.isArray(x)?x:x?.items||[]};
test('only positive balances appear; duplicate balances aggregate and private fields never escape',()=>{
 const articles=[{id:'a',name:'A',price:42,cost:12,reserve:7,photo:'https://example.com/a.jpg'},{id:'b',name:'B',price:2},{id:'c',name:'C',price:3},{id:'d',name:'D',price:3,DeletedOn:'2026-01-01'}];
 const balances=[['a',5],['a',-2],['b',0],['c',-4],['d',8]].map(([Article,BalanceQuantitySum])=>({Article,BalanceQuantitySum}));
 const result=publicProducts(articles,balances,helpers);assert.equal(result.length,1);assert.equal(result[0].quantity,3);assert.equal(result[0].price,42);assert.equal(result[0].cost,undefined);assert.equal(result[0].reserve,undefined);
});
test('unknown prices remain unknown and unsafe image URLs are removed',()=>{
 const [p]=publicProducts([{id:'a',name:'A',price:null,photo:'javascript:alert(1)'}],[{Article:'a',BalanceQuantitySum:2}],helpers);assert.equal(p.price,null);assert.equal(p.photo,'');assert.equal(SHOP_DEPOT,'ab5bfb42-ab4a-f111-8cc5-9c6b0045fe69');
});
test('invalid balance aborts the refresh rather than silently losing inventory',()=>{assert.throws(()=>publicProducts([],[{Article:'a',BalanceQuantitySum:'bad'}],helpers));});
