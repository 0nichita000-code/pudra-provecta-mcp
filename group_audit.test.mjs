import test from 'node:test';
import assert from 'node:assert/strict';
import {createControlExtras} from './control_extras.js';
test('group audit only exposes a complete fresh snapshot, with real memberships and pagination',async()=>{
 let release;const gate=new Promise(r=>release=r);let calls=0;
 const handler=createControlExtras({webRead:async(method,body)=>{
  calls++;
  if(method==='ArticleGroupSearch'){await gate;return {Entities:[{Id:'g',Name:'ROUND LAB'}],Pager:{Number:1}}}
  assert.equal(method,'ArticleSearch');const q=body.articlePredicate;
  if(q.ArticleGroupPredicate)return {Entities:[{Id:'p0'}],Pager:{Number:1}};
  const index=q.Pager.Index;return {Entities:Array.from({length:index===0?500:1},(_,i)=>({Id:'p'+(index*500+i),Name:'Product',Code:String(index*500+i),Barcode:'123'})),Pager:{Number:501}};
 }});
 assert.equal(handler.groupAudit().complete,false);
 await new Promise(setImmediate);assert.equal(handler.groupAudit().products,undefined);
 release();for(let i=0;i<20&&handler.groupAudit().running;i++)await new Promise(setImmediate);
 const first=handler.groupAudit();assert.equal(first.complete,true);assert.equal(first.total,501);assert.equal(first.nextOffset,500);assert.deepEqual(first.products[0].groups,[{id:'g',name:'ROUND LAB'}]);assert.deepEqual(first.products[1].groups,[]);
 const second=handler.groupAudit(500);assert.equal(second.products.length,1);assert.equal(second.nextOffset,501);const doneCalls=calls;handler.groupAudit();assert.equal(calls,doneCalls);
 assert.throws(()=>handler.groupAudit(-1));
});
test('failed group reads cannot be reported as a completed empty catalogue',async()=>{
 const handler=createControlExtras({webRead:async()=>{throw Error('Upstream unavailable')}});
 handler.groupAudit();for(let i=0;i<20&&handler.groupAudit().running;i++)await new Promise(setImmediate);
 const result=handler.groupAudit();assert.equal(result.complete,false);assert.equal(result.products,undefined);assert.match(result.datasets.groups.error,/Upstream/);
});
