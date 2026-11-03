import {randomUUID,timingSafeEqual} from 'node:crypto';
import {gzipSync} from 'node:zlib';

// Read-only bridge. This credential cannot create or alter Provecta/STOCK documents.
export function createControlSync({getArticles,getDepots,simpleArticle,simpleDepot,idOf,articleBarcodes,apiGet,asArray,getIndexedBarcodes,getAlternateIndexStatus,startBulkBarcodeSync,getBulkBarcodeStatus,getBulkBarcodeRecords=()=>[]}){
 const generations=new Map();let latest=null,running=false,lastStarted=0,lastError=null;
 const status=()=>({schema:1,running,lastStarted:lastStarted?new Date(lastStarted).toISOString():null,lastError,latest:latest?{id:latest.id,at:latest.at,total:latest.products.length,depots:latest.depots,stockStatus:latest.stockStatus,alternate:latest.alternate}:null});
 async function build(){
  running=true;lastStarted=Date.now();lastError=null;
  try{
   const [raw,rawDepots]=await Promise.all([getArticles(true),getDepots(true)]);
   if(!Array.isArray(raw)||!raw.length)throw Error('Provecta returned no catalog records');
   const depots=rawDepots.map(simpleDepot).filter(d=>d.id),seen=new Set();
   if(!depots.length)throw Error('Provecta returned no depots');
   const products=raw.map(a=>{const p=simpleArticle(a),id=idOf(a);if(!id||seen.has(id))throw Error('Missing/duplicate article identity');seen.add(id);return {...p,id,additionalBarcodes:[...new Set([...articleBarcodes(a),...getIndexedBarcodes(id)])],sourceUpdatedAt:a.UpdatedOn??a.updatedOn??null,deletedAt:a.DeletedOn??a.deletedOn??null,description:a.Description??'',raw:a}});
   const stockStatus=[];const balances=[];
   const publish=()=>{
    const versionProducts=products.map(p=>({...p,additionalBarcodes:[...new Set([...p.additionalBarcodes,...getIndexedBarcodes(p.id)])].filter(code=>code!==String(p.barcode??'').trim())}));
    const known=new Map(stockStatus.map(x=>[x.depot,x]));
    const barcodeRecords=getBulkBarcodeRecords();
    const snapshot={id:randomUUID(),at:new Date().toISOString(),products:versionProducts,depots,balances:[...balances],barcodeRecords,unresolvedBarcodeProducts:[...new Set(barcodeRecords.filter(x=>!seen.has(x.product)).map(x=>x.product))],stockStatus:depots.map(d=>known.get(d.id)||{depot:d.id,complete:false,error:'Ожидается ответ Provecta',at:null}),alternate:{...getAlternateIndexStatus(),bulk:getBulkBarcodeStatus()},catalogComplete:true,unknownBalanceProducts:[...new Set(balances.filter(x=>!seen.has(x.product)).map(x=>x.product))]};
    latest=snapshot;generations.set(snapshot.id,snapshot);for(const id of generations.keys())if(generations.size>8)generations.delete(id);
   };
   startBulkBarcodeSync();publish();
   for(let offset=0;offset<depots.length;offset+=2){await Promise.all(depots.slice(offset,offset+2).map(async d=>{
    try{
     const value=await apiGet('/v1/resume/currentBalance',{depotId:[d.id]});
     if(value===null||value===undefined)throw Error('Empty balance response');const rows=asArray(value);
     if(!Array.isArray(value)&&!rows.length)throw Error('Unrecognized balance response');
     const aggregate=new Map();for(const row of rows){const product=idOf(row.Article??row.article??row.ArticleId??row.articleId),quantity=Number(row.BalanceQuantitySum??row.balanceQuantitySum);if(!product||!Number.isFinite(quantity))throw Error('Invalid balance row');aggregate.set(product,(aggregate.get(product)||0)+quantity)}
     const at=new Date().toISOString();for(const [product,quantity]of aggregate)balances.push({product,depot:d.id,quantity});stockStatus.push({depot:d.id,complete:true,rows:aggregate.size,at});
    }catch(e){stockStatus.push({depot:d.id,complete:false,error:String(e.message||e).slice(0,200),at:null})}
   }));publish()}
  }catch(e){lastError=String(e.message||e).slice(0,250)}finally{running=false}
 }
 return async(req,res,url)=>{
  if(url.pathname!=='/control/sync')return false;
  const expected=process.env.CONTROL_SYNC_TOKEN||'',received=String(req.headers.authorization||'').replace(/^Bearer /i,'');
  const a=Buffer.from(expected),b=Buffer.from(received);
  const send=(code,data)=>{const compressed=String(req.headers['accept-encoding']||'').includes('gzip');res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...(compressed?{'content-encoding':'gzip','vary':'accept-encoding'}:{})});const body=JSON.stringify(data);res.end(compressed?gzipSync(body):body)};
  if(!expected||a.length!==b.length||!timingSafeEqual(a,b)){send(401,{error:'Invalid read-only synchronization credential'});return true}
  if(req.method!=='GET'){send(405,{error:'Read-only endpoint'});return true}
  if(url.searchParams.get('start')==='1'&&!running&&Date.now()-lastStarted>=110000)void build();
  const generation=url.searchParams.get('generation');
  if(generation){const s=generations.get(generation);if(!s){send(409,{error:'Snapshot expired; restart download'});return true}
   const offset=Number(url.searchParams.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0){send(400,{error:'Invalid offset'});return true}
   const products=s.products.slice(offset,offset+500);const ids=new Set(products.map(p=>p.id));
   const unknown=new Set(s.unknownBalanceProducts);
   const unresolved=new Set(s.unresolvedBarcodeProducts);
   send(200,{schema:1,id:s.id,at:s.at,offset,nextOffset:offset+products.length,total:s.products.length,catalogComplete:s.catalogComplete,products,balances:s.balances.filter(x=>ids.has(x.product)||(offset===0&&unknown.has(x.product))),barcodeRecords:s.barcodeRecords.filter(x=>ids.has(x.product)||(offset===0&&unresolved.has(x.product))),unresolvedBarcodeProducts:s.unresolvedBarcodeProducts,depots:s.depots,stockStatus:s.stockStatus,alternate:s.alternate,unknownBalanceProducts:s.unknownBalanceProducts});
  }else send(200,status());return true;
 };
}
