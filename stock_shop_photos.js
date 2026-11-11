import {readFileSync} from 'node:fs';
const snapshot=JSON.parse(readFileSync(new URL('./stock_shop_photos.json',import.meta.url),'utf8'));
const allowedOrigin='https://pudra-magazin-md.calmring.chatgpt.site';
const photos=new Map(Object.entries(snapshot.photos).filter(([id,value])=>{try{const u=new URL(value);return /^[a-f0-9-]{36}$/i.test(id)&&u.origin===allowedOrigin&&/^\/(control-photos|retouched-bags)\/[a-z0-9_.-]+$/i.test(u.pathname)}catch{return false}}));
export const stockShopPhotoStatus=Object.freeze({source:allowedOrigin,updatedAt:snapshot.updatedAt,count:photos.size});
export function stockShopPhoto(productId){return photos.get(String(productId||'').toLowerCase())||''}
