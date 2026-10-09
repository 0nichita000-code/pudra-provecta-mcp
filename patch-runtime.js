import fs from "node:fs";

const path = new URL("./server.js", import.meta.url);
let s = fs.readFileSync(path, "utf8");

s = s.replaceAll('"X-Ws-ReqToken"', '"X-Mx-ReqToken"');

fs.writeFileSync(path, s);
