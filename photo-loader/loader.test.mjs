import test from "node:test";
import assert from "node:assert/strict";
import {nameTokens,isMatchingProductPage,ogImage} from "./loader.mjs";

test("rejects wrong barcode even for the same brand",()=>{
 const html='<html><title>SADOER MERRY CHRISTMAS HYALURONIC MASK</title><p>6942349733155</p></html>';
 assert.equal(isMatchingProductPage(html,{barcode:"6942349733154",name:"SADOER MERRY CHRISTMAS HYALURONIC MASK"}),false);
});
test("accepts exact barcode and distinctive model",()=>{
 const html='<h1>SADOER MERRY CHRISTMAS HYALURONIC MASK</h1> EAN:6942349733154';
 assert.equal(isMatchingProductPage(html,{barcode:"6942349733154",name:"SADOER MERRY CHRISTMAS HYALURONIC MASK"}),true);
});
test("rejects generic product name",()=>{
 assert.equal(isMatchingProductPage('PUNGA 60 2100000009999',{barcode:"2100000009999",name:"PUNGA 60"}),false);
});
test("extracts image URL from og:image",()=>{
 const html='<meta property="og:image" content="https://example.com/images/mask.jpg">';
 assert.equal(ogImage(html,"https://example.com/p/1"),"https://example.com/images/mask.jpg");
});
test("rejects placeholder photo",()=>{
 const html='<meta property="og:image" content="https://example.com/logo.png">';
 assert.equal(ogImage(html,"https://example.com/p/1"),null);
});
test("tokenizer keeps product identifiers",()=>{
 assert.ok(nameTokens("KEVIN&COCO KC1054 42 COLORS FACE PALETTE").includes("KC1054"));
});
