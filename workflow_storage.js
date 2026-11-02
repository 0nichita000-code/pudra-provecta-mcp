import fs from "node:fs/promises";
export function workflowStorage(path,Pool){
 const url=process.env.STOCK_DATABASE_URL||process.env.DATABASE_URL;
 const pool=url?new Pool({connectionString:url,ssl:process.env.STOCK_DB_SSL==="false"?false:{rejectUnauthorized:false},max:3}):null;
 let local=null,lock=Promise.resolve(),initPromise;
 async function init(){
  if(!pool)return;
  if(!initPromise)initPromise=(async()=>{
   await pool.query("CREATE TABLE IF NOT EXISTS pudra_workflows (id TEXT PRIMARY KEY, data JSONB NOT NULL)");
   const result=await pool.query("SELECT id FROM pudra_workflows WHERE id='main'");
   if(!result.rowCount){
    let old={documents:[]};try{old=JSON.parse(await fs.readFile(path,"utf8"))}catch{}
    await pool.query("INSERT INTO pudra_workflows(id,data) VALUES('main',$1::jsonb) ON CONFLICT DO NOTHING",[JSON.stringify(old)]);
   }
  })().catch(e=>{initPromise=null;throw e});
  await initPromise;
 }
 async function read(){
  if(pool){await init();const r=await pool.query("SELECT data FROM pudra_workflows WHERE id='main'");return r.rows[0]?.data||{documents:[]}}
  if(local)return local;try{local=JSON.parse(await fs.readFile(path,"utf8"))}catch{local={documents:[]}}return local;
 }
 function write(fn){
  const job=lock.then(async()=>{
   if(pool){
    await init();const c=await pool.connect();
    try{
     await c.query("BEGIN");
     const r=await c.query("SELECT data FROM pudra_workflows WHERE id='main' FOR UPDATE");
     const data=r.rows[0]?.data||{documents:[]},out=await fn(data);
     await c.query("UPDATE pudra_workflows SET data=$1::jsonb WHERE id='main'",[JSON.stringify(data)]);
     await c.query("COMMIT");return out;
    }catch(e){await c.query("ROLLBACK");throw e}finally{c.release()}
   }
   const data=await read(),out=await fn(data);
   await fs.writeFile(path+".tmp",JSON.stringify(data));await fs.rename(path+".tmp",path);return out;
  });lock=job.catch(()=>{});return job;
 }
 return {read,write,persistent:!!pool};
}