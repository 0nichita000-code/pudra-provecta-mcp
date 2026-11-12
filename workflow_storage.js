import fs from "node:fs/promises";
export function workflowStorage(path,Pool){
 const url=process.env.STOCK_DATABASE_URL||process.env.DATABASE_URL;
 const pool=url?new Pool({connectionString:url,ssl:process.env.STOCK_DB_SSL==="false"?false:{rejectUnauthorized:false},max:3,connectionTimeoutMillis:10000}):null;
 if(pool)pool.on('error',error=>console.error('[PUDRA STORAGE] idle_connection_error',String(error?.code||'DATABASE_ERROR')));
 let local=null,lock=Promise.resolve(),initPromise,dbAvailable=!!pool;
 const isDbError=e=>['ENOTFOUND','ECONNREFUSED','57P01','57P03','ETIMEDOUT'].includes(String(e?.code||''))||/getaddrinfo|connect|database.*unavailable/i.test(String(e?.message||''));
 async function localRead(){
  if(local)return local;
  try{local=JSON.parse(await fs.readFile(path,"utf8"))}catch{local={documents:[]}}
  return local;
 }
 async function localWrite(fn){
  const data=await localRead(),out=await fn(data);
  await fs.writeFile(path+".tmp",JSON.stringify(data));
  await fs.rename(path+".tmp",path);
  return out;
 }
 async function init(){
  if(!pool||!dbAvailable)return;
  if(!initPromise)initPromise=(async()=>{
   await pool.query("CREATE TABLE IF NOT EXISTS pudra_workflows (id TEXT PRIMARY KEY, data JSONB NOT NULL)");
   const result=await pool.query("SELECT id FROM pudra_workflows WHERE id='main'");
   if(!result.rowCount){
    let old={documents:[]};try{old=JSON.parse(await fs.readFile(path,"utf8"))}catch{}
    await pool.query("INSERT INTO pudra_workflows(id,data) VALUES('main',$1::jsonb) ON CONFLICT DO NOTHING",[JSON.stringify(old)]);
   }
  })().catch(e=>{initPromise=null;if(isDbError(e))dbAvailable=false;throw e});
  await initPromise;
 }
 async function read(){
  if(pool&&dbAvailable){
   try{
    await init();
    const r=await pool.query("SELECT data FROM pudra_workflows WHERE id='main'");
    return r.rows[0]?.data||{documents:[]};
   }catch(e){
    if(!isDbError(e))throw e;
    dbAvailable=false;
    console.error('[PUDRA STORAGE] fallback_to_local',String(e?.code||e?.message||'DATABASE_ERROR'));
   }
  }
  return localRead();
 }
 function write(fn){
  const job=lock.then(async()=>{
   if(pool&&dbAvailable){
    try{
     await init();const c=await pool.connect();
     try{
      await c.query("BEGIN");
      const r=await c.query("SELECT data FROM pudra_workflows WHERE id='main' FOR UPDATE");
      const data=r.rows[0]?.data||{documents:[]},out=await fn(data);
      await c.query("UPDATE pudra_workflows SET data=$1::jsonb WHERE id='main'",[JSON.stringify(data)]);
      await c.query("COMMIT");return out;
     }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
    }catch(e){
     if(!isDbError(e))throw e;
     dbAvailable=false;
     console.error('[PUDRA STORAGE] fallback_to_local',String(e?.code||e?.message||'DATABASE_ERROR'));
    }
   }
   return localWrite(fn);
  });
  lock=job.catch(()=>{});
  return job;
 }
 return {read,write,persistent:!!pool,isDatabaseAvailable:()=>dbAvailable};
}
