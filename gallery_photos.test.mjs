import test from 'node:test';
import assert from 'node:assert/strict';
import {createGalleryPhotos,galleryUrl} from './gallery_photos.js';
const id='0d58700c-76de-f111-8cd4-9c6b0045fe69',other='6ad90a37-76de-f111-8cd4-9c6b0045fe69';
test('gallery matches exact entity, chooses default, preserves existing photos and caches',async()=>{
 let calls=0;
 const enrich=createGalleryPhotos(async(method,body)=>{
  calls++;assert.equal(method,'FilestreamSearch');assert.deepEqual(body.filestreamPredicate.EntityIds.Value,[id]);
  return {Entities:[{EntityId:other,Url:'https://example.com/wrong.jpg'},{EntityId:id,Url:'https://example.com/first.jpg'},{EntityId:id,ReferenceId:id,Extension:'.jpg',IsDefault:true}]};
 });
 const input=[{id,photo:''},{id:other,photo:'https://example.com/existing.jpg'}];
 const result=await enrich(input);assert.equal(result[0].photo,`https://provectapos.com/filestreams/${id}.jpg`);assert.equal(result[1].photo,input[1].photo);assert.equal(input[0].photo,'');await enrich(input);assert.equal(calls,1);
});
test('gallery failure preserves catalogue and retries; unsafe URLs are rejected',async()=>{
 let calls=0;const enrich=createGalleryPhotos(async()=>{if(++calls===1)throw Error('offline');return {Entities:[{EntityId:id,Url:'https://example.com/photo.jpg'}]}});
 assert.equal((await enrich([{id,photo:''}]))[0].photo,'');assert.equal((await enrich([{id,photo:''}]))[0].photo,'https://example.com/photo.jpg');
 for(const Url of ['javascript:alert(1)','data:image/png;base64,xx','https://secret:pass@example.com/a'])assert.equal(galleryUrl({Url}),'');
});
