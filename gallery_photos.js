// The Provecta web gallery is separate from the article REST response.
export function galleryUrl(file) {
  const direct=file?.Url;
  if(typeof direct==='string') {
    try {const url=new URL(direct);if(url.protocol==='https:'&&!url.username&&!url.password)return url.href;}catch{}
  }
  if(/^[a-f0-9-]{36}$/i.test(file?.ReferenceId||'')&&/^\.(jpe?g|png|webp|gif)$/i.test(file?.Extension||''))
    return 'https://provectapos.com/filestreams/'+file.ReferenceId+file.Extension;
  return '';
}
export function createGalleryPhotos(read,{now=Date.now}={}) {
  const cache=new Map();
  let active=null;
  async function populate(ids) {
    for(let offset=0;offset<ids.length;offset+=100){
      const batch=ids.slice(offset,offset+100);
      const response=await read('FilestreamSearch',{filestreamPredicate:{EntityIds:{Value:batch},Pager:{Index:0,Size:1000}}});
      const data=response?.FilestreamSearchResult??response?.d??response;
      if(!Array.isArray(data?.Entities))throw Error('Unrecognized gallery response');
      const selected=new Map();
      for(const file of data.Entities){
        const id=String(file.EntityId??file.Entity?.Id??'').toLowerCase();
        if(!batch.includes(id))continue;
        const url=galleryUrl(file);if(!url)continue;
        if(!selected.has(id)||file.IsDefault)selected.set(id,url);
      }
      // Do not cache missing entries from a potentially truncated response.
      for(const id of batch)if(selected.has(id)||data.Entities.length<1000)
        cache.set(id,{photo:selected.get(id)||'',expires:now()+(selected.has(id)?600000:60000)});
    }
  }
  return async (products,{timeoutMs=8000}={})=>{
    const ids=[...new Set(products.filter(p=>!p.photo&&/^[a-f0-9-]{36}$/i.test(p.id)).map(p=>p.id.toLowerCase()))];
    const work=(async()=>{try {
      if(active)await active;
      const missing=ids.filter(id=>!cache.has(id)||cache.get(id).expires<=now());
      if(missing.length){active=populate(missing);try{await active;}finally{active=null;}}
    }catch{console.warn('PROVECTA_GALLERY_UNAVAILABLE');}})();
    let timer;try{await Promise.race([work,new Promise(resolve=>{timer=setTimeout(resolve,Math.max(0,Math.min(8000,timeoutMs)))})]);}finally{clearTimeout(timer);}
    return products.map(p=>p.photo?p:{...p,photo:cache.get(String(p.id).toLowerCase())?.photo||''});
  };
}
