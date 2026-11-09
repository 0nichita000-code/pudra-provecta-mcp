import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {handleStockSafely} from './stock_transport.js';
import {workflowStorage} from './workflow_storage.js';
test('failed database request returns readable cross-origin error and next catalogue request still works',async()=>{
 let status,headers,body;
 const res={writeHead(s,h){status=s;headers=h},end(b){body=b}};
 assert.equal(await handleStockSafely(async()=>{throw Object.assign(Error('secret connection details'),{code:'ENOTFOUND'})},{},res,new URL('https://stock/stock/api/count-documents')),true);
 assert.equal(status,503);assert.equal(headers['access-control-allow-origin'],'*');assert.match(JSON.parse(body).error,/Хранилище/);assert.ok(!body.includes('secret'));
 assert.equal(await handleStockSafely(async()=>true,{},res,new URL('https://stock/stock/api/search')),true);
});
test('idle PostgreSQL error is handled and unavailable database never falls back to an empty file',async()=>{
 const saved=process.env.STOCK_DATABASE_URL;process.env.STOCK_DATABASE_URL='postgresql://invalid/test';let pool;
 class Pool extends EventEmitter{constructor(options){super();pool=this;assert.equal(options.connectionTimeoutMillis,10000)}async query(){throw Object.assign(Error('offline'),{code:'ENOTFOUND'})}}
 try{const storage=workflowStorage('unused',Pool);assert.equal(storage.persistent,true);assert.doesNotThrow(()=>pool.emit('error',{code:'ENOTFOUND'}));await assert.rejects(()=>storage.read(),/offline/)}finally{if(saved===undefined)delete process.env.STOCK_DATABASE_URL;else process.env.STOCK_DATABASE_URL=saved}
});
