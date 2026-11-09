export async function handleStockSafely(handler,req,res,url){
 try{return await handler(req,res,url)}catch(error){
  if(!url.pathname.startsWith('/stock/api/'))throw error;
  console.error('[PUDRA STOCK] request_failed',url.pathname,String(error?.code||'UPSTREAM_ERROR'));
  if(res.headersSent){res.end();return true}
  const database=['ENOTFOUND','ECONNREFUSED','57P01','57P03'].includes(error?.code);
  res.writeHead(503,{
   'content-type':'application/json; charset=utf-8','cache-control':'no-store',
   'access-control-allow-origin':'*',
   'access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS',
   'access-control-allow-headers':'content-type,x-pudra-pin,x-pudra-user,x-pudra-role,x-pudra-depot'
  });
  res.end(JSON.stringify({error:database?'Хранилище PUDRA STOCK временно недоступно. Обратитесь к администратору.':'Сервер PUDRA STOCK временно не смог получить данные. Повторите запрос позже.'}));
  return true;
 }
}
