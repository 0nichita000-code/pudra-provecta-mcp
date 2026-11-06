import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('./app.js',import.meta.url),'utf8');
function context(){const c={};vm.createContext(c);vm.runInContext(source.slice(source.indexOf('// Linear formats'),source.indexOf('const S={')),c);return c;}
test('QR, Data Matrix and unknown formats are rejected even when their content is a valid product EAN',()=>{
 const c=context();for(const format of [0,5,9,10,11,17,undefined])assert.equal(c.stockLinearResult({getBarcodeFormat:()=>format,getText:()=>'4810151020163'}),false);
 for(const format of [2,3,4,6,7,8,14,15])assert.equal(c.stockLinearResult({getBarcodeFormat:()=>format}),true);
 assert.equal(c.stockLinearResult({text:'4810151020163'}),false);
});
test('QR-only native support cannot fall back to an unrestricted detector',()=>{
 const c=context();assert.equal(c.stockNativeFormats(['qr_code','data_matrix']).length,0);
 assert.deepEqual(Array.from(c.stockNativeFormats(['qr_code','ean_13','code_128'])),['code_128','ean_13']);
 assert.ok(!c.stockNativeFormats(null).includes('qr_code'));
 assert.ok(source.includes('if(!use.length)throw'));
 assert.ok(source.includes('new BarcodeDetector({formats:use})'));
});
