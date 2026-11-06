import {gzipSync} from 'node:zlib';

export const SHOP_DEPOT='ab5bfb42-ab4a-f111-8cc5-9c6b0045fe69';
export const SHOP_INTERVAL=120000;
export const PUBLIC_STORES=[
 {id:'7c85d759-5c4f-f111-8cc5-9c6b0045fe69',nameRu:'Оргееве',nameRo:'Orhei'},
 {id:'4562d353-5c4f-f111-8cc5-9c6b0045fe69',nameRu:'Глодянах',nameRo:'Glodeni'},
 {id:'e8d7f75f-5c4f-f111-8cc5-9c6b0045fe69',nameRu:'Бельцах',nameRo:'Bălți'},
 {id:'10d8bec8-1379-f111-8cc9-9c6b0045fe69',nameRu:'Бельцах · PINK',nameRo:'Bălți · PINK'}
];
export function publicProducts(articles,balances,{simpleArticle,idOf,asArray}){
 const stock=new Map();
 for(const row of asArray(balances)){
  const id=idOf(row.Article??row.article??row.ArticleId??row.articleId),qty=Number(row.BalanceQuantitySum??row.balanceQuantitySum);
  if(!id||!Number.isFinite(qty))throw Error('Invalid source balance');
  stock.set(id,(stock.get(id)||0)+qty);
 }
 return articles.filter(a=>!(a.DeletedOn??a.deletedOn)).flatMap(a=>{
  const p=simpleArticle(a),quantity=stock.get(p.id)||0;
  if(quantity<=0||!p.name)return [];
  const price=p.price===null||p.price===undefined||String(p.price).trim()===''?null:Number(p.price);
  return [{id:String(p.id),name:String(p.name),barcode:String(p.barcode||''),code:String(p.code||''),price:Number.isFinite(price)&&price>=0?price:null,quantity,photo:typeof p.photo==='string'&&/^https:\/\//i.test(p.photo)?p.photo:''}];
 }).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
}
export function createShopCatalog({getArticles,simpleArticle,idOf,asArray,apiGet}){
 let snapshot=null,running=null,lastError=false,branchSnapshot=null,branchRunning=null;
 async function refreshBranches(){
  if(branchRunning)return branchRunning;
  branchRunning=(async()=>{try{const articles=await getArticles(false),map=new Map();for(const store of PUBLIC_STORES){const balances=await apiGet('/v1/resume/currentBalance',{depotId:[store.id]});if(balances==null||!Array.isArray(balances)&&!asArray(balances).length)throw Error('Incomplete source');for(const p of publicProducts(articles,balances,{simpleArticle,idOf,asArray})){const prior=map.get(p.id)||{...p,quantity:0,stores:[]};prior.stores.push({...store,available:true});map.set(p.id,prior)}}branchSnapshot={products:[...map.values()],updatedAt:new Date().toISOString()}}catch{}finally{branchRunning=null}})();return branchRunning;
 }
 async function refresh(){
  if(running)return running;
  running=(async()=>{try{
   const [articles,balances]=await Promise.all([getArticles(true),apiGet('/v1/resume/currentBalance',{depotId:[SHOP_DEPOT]})]);
   if(!Array.isArray(articles)||!articles.length||balances===null||balances===undefined)throw Error('Incomplete source');
   const rows=asArray(balances);if(!Array.isArray(balances)&&!rows.length)throw Error('Unrecognized source');
   const products=publicProducts(articles,balances,{simpleArticle,idOf,asArray});
   snapshot={products,updatedAt:new Date().toISOString()};lastError=false;
  }catch{lastError=true;}finally{running=null;}})();return running;
 }
 const timer=setInterval(()=>{void refresh();void refreshBranches()},SHOP_INTERVAL);timer.unref();void refresh();void refreshBranches();
 return async(req,res,url)=>{
  if(!['/shop/api/catalog','/shop/api/branches'].includes(url.pathname))return false;
  const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*','x-content-type-options':'nosniff'};
  if(req.method!=='GET'){res.writeHead(405,headers);res.end(JSON.stringify({error:'GET required'}));return true;}
  if(url.pathname==='/shop/api/branches'){if(!branchSnapshot){res.writeHead(503,headers);res.end(JSON.stringify({error:'Availability is loading'}));return true}const body=JSON.stringify({...branchSnapshot,viewOnly:true,intervalMs:SHOP_INTERVAL});const gzip=String(req.headers['accept-encoding']||'').includes('gzip');res.writeHead(200,{...headers,...(gzip?{'content-encoding':'gzip','vary':'accept-encoding'}:{})});res.end(gzip?gzipSync(body):body);return true;}
  if(!snapshot){res.writeHead(503,{...headers,'retry-after':'10'});res.end(JSON.stringify({error:'Каталог загружается. Повторите через несколько секунд.'}));return true;}
  const age=Date.now()-Date.parse(snapshot.updatedAt),stale=lastError||age>SHOP_INTERVAL*2;
  const body=JSON.stringify({...snapshot,depotId:SHOP_DEPOT,depotName:'DEPOZIT RISCANI',currency:'MDL',intervalMs:SHOP_INTERVAL,stale,canOrder:age<10*60*1000,message:stale?'Обновление задерживается. Наличие уточняйте у продавца.':null});
  const gzip=String(req.headers['accept-encoding']||'').includes('gzip');
  res.writeHead(200,{...headers,...(gzip?{'content-encoding':'gzip','vary':'accept-encoding'}:{})});res.end(gzip?gzipSync(body):body);return true;
 };
}
