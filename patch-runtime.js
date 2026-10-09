import fs from "node:fs";

const path = new URL("./server.js", import.meta.url);
let s = fs.readFileSync(path, "utf8");

s = s.replaceAll('"X-Ws-ReqToken"', '"X-Mx-ReqToken"');


const wsdlTarget = `    let legacyTest = null;
    try { legacyTest = await legacyArticleLoad("10237072-ca4a-f111-8cc5-9c6b0045fe69"); } catch (e) { legacyTest = { error: e.message, status: e.status || null }; }
    return jsonReply({ ok: true, client: a.client, branches: branches.map(simpleBranch), depots: depots.map(simpleDepot), schema, legacyTest });`;

const wsdlReplacement = `    let legacyTest = null;
    try { legacyTest = await legacyArticleLoad("10237072-ca4a-f111-8cc5-9c6b0045fe69"); } catch (e) { legacyTest = { error: e.message, status: e.status || null }; }

    let legacyWsdl = null;
    try {
      const origin = new URL(BASE).origin;
      const response = await fetch(origin + "/services/Stock.svc?singleWsdl", { headers: { "Accept": "application/xml,text/xml,*/*" } });
      const text = await response.text();
      const picks = {};
      for (const term of ["ArticleSearch", "ArticleLoad", "complexType name=\\\"ArticlePredicate\\\"", "complexType name=\\\"CriteriaOfArrayOfstringuHEDJ7Dj\\\"", "complexType name=\\\"GenericPredicate\\\"", "complexType name=\\\"GenericOutputOfArticle1Nrns640\\\"", "ArticleBarcodes"]) {
        const i = text.indexOf(term);
        picks[term] = i >= 0 ? text.slice(Math.max(0, i - 1200), Math.min(text.length, i + 3200)) : null;
      }
      legacyWsdl = { status: response.status, contentType: response.headers.get("content-type"), picks };
    } catch (e) {
      legacyWsdl = { error: String(e.message || e).slice(0, 500) };
    }

    return jsonReply({ ok: true, client: a.client, branches: branches.map(simpleBranch), depots: depots.map(simpleDepot), schema, legacyTest, legacyWsdl });`;

if (s.includes(wsdlTarget)) s = s.replace(wsdlTarget, wsdlReplacement);

fs.writeFileSync(path, s);
