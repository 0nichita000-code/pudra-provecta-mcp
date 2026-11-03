import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {test} from 'node:test';

const source=readFileSync(new URL('./count.js',import.meta.url),'utf8');
async function upload({text,rows,extension='xlsx'}){
 const elements=new Map(),posts=[];
 const get=id=>{
  if(!elements.has(id))elements.set(id,{value:'',files:[],addEventListener(){}});
  return elements.get(id);
 };
 get('countUploadDepot').value='orhei';
 get('countDocType').value='receipt';
 get('countReceiptDate').value='2026-11-03';
 get('countFile').files=[{name:`Духи оргеев.${rows?extension:'csv'}`,text:async()=>text,arrayBuffer:async()=>new ArrayBuffer(0)}];
 const context={document:{getElementById:get,querySelector:()=>({addEventListener(){}})},
  localStorage:{getItem:()=>null},setTimeout(){},
  window:{XLSX:{read:()=>({Sheets:{report:{}},SheetNames:['report']}),utils:{sheet_to_json:()=>rows}}},
  fetch:async(url,options)=>{posts.push(JSON.parse(options.body));return {ok:true,json:async()=>({id:123})}}};
 vm.runInNewContext(source,context);
 await get('countUpload').onclick();
 return {posts,message:get('countUploadInfo').textContent};
}
const report=[['Код','Штрих-код','Наименование','Цена продажи','Количество','Сумма'],
 ['1','0629401510001','ARMAF HUNTER',600,0,0],
 ['2','6295199800001','ARMAF SCENT',1000,1,1000]];
test('preserves both negative stock rows reported in the supplied workbook',async()=>{
 const result=await upload({rows:[report[0],
  ['7066','6290171072843','ZIMAYA BLACK SYMPHONY',650,-1,-650],
  ['3117','6290360375595','FRENCH AVENUE ROYAL BLEND NERO',1300,-1,-1300]]});
 assert.match(result.message,/Готово: загружено 2/);
 assert.deepEqual(result.posts[0].items.map(x=>x.expected),[-1,-1]);
});
test('server accepts signed document amounts and rejects negative physical counts',()=>{
 const backend=readFileSync(new URL('../stock_app.js',import.meta.url),'utf8');
 const validator=backend.match(/function goodCount\([^\n]+/)[0];
 const goodCount=vm.runInNewContext('('+validator+')');
 assert.equal(goodCount(-1,{signed:true}),-1);
 assert.equal(goodCount(-1),null);
 for(const value of [NaN,Infinity,-Infinity,1e8,-1e8])assert.equal(goodCount(value,{signed:true}),null);
 assert.match(backend,/expected:goodCount\(x.expected,\{signed:true\}\)/);
 assert.match(backend,/const n=goodCount\(b.actual\)/);
});
for(const extension of ['xlsx','xls'])test(`Excel ${extension}: headings from screenshot, extra columns, zero and leading zero`,async()=>{
 const result=await upload({rows:report,extension});
 assert.match(result.message,/Готово: загружено 2/);
 assert.deepEqual(result.posts[0].items,[{name:'ARMAF HUNTER',barcode:'0629401510001',expected:0},{name:'ARMAF SCENT',barcode:'6295199800001',expected:1}]);
});
for(const separator of [';',',','\t'])test(`CSV separator ${JSON.stringify(separator)}`,async()=>{
 const result=await upload({text:'\uFEFF'+report.map(row=>row.map(v=>'"'+v+'"').join(separator)).join('\r\n')});
 assert.equal(result.posts[0].items.length,2);
 assert.equal(result.posts[0].items[0].expected,0);
});
test('original headings remain supported',async()=>{
 const result=await upload({text:'НАЗВАНИЕ;ШТРИХКОД;КОЛИЧЕСТВО\nТовар;001;4'});
 assert.equal(result.posts[0].items[0].expected,4);
});
test('missing headings do not create document',async()=>{
 const result=await upload({text:'Название;Штрихкод;Цена\nТовар;001;4'});
 assert.equal(result.posts.length,0);
 assert.match(result.message,/Не загружено: Не распознаны колонки/);
});
test('invalid quantity does not create document',async()=>{
 const result=await upload({text:'Наименование;Штрихкод;Количество\nТовар;001;NaN'});
 assert.equal(result.posts.length,0);
 assert.match(result.message,/Некорректное количество/);
});
