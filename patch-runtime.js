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


const attemptsTarget = `  const attempts = [
    ["ArticleSearch", { article: { Barcode: barcode } }],
    ["ArticleSearch", { barcode }],
    ["ArticleSearch", { Barcode: barcode }],
    ["ArticleSearch", { text: barcode }],
    ["ArticleSearch", { search: barcode }],
    ["ArticleLoad", { article: { Barcode: barcode } }]
  ];`;

const attemptsReplacement = `  const attempts = [
    ["ArticleSearch", { articlePredicate: { Barcodes: { Value: [barcode] } } }],
    ["ArticleSearch", { articlePredicate: { Barcodes: { IsExcluded: false, IsNull: false, Value: [barcode] } } }],
    ["ArticleSearch", { article: { Barcode: barcode } }],
    ["ArticleSearch", { barcode }],
    ["ArticleSearch", { Barcode: barcode }],
    ["ArticleSearch", { text: barcode }],
    ["ArticleSearch", { search: barcode }],
    ["ArticleLoad", { article: { Barcode: barcode } }]
  ];`;

if (s.includes(attemptsTarget)) s = s.replace(attemptsTarget, attemptsReplacement);


fs.writeFileSync(path, s);


const commonTarget = `    return jsonReply({ ok: true, client: a.client, branches: branches.map(simpleBranch), depots: depots.map(simpleDepot), schema, legacyTest, legacyWsdl });`;
const commonReplacement = `    let legacyCommonWsdl = null;
    try {
      const origin = new URL(BASE).origin;
      const response = await fetch(origin + "/services/Framework/Common.svc?singleWsdl", { headers: { "Accept": "application/xml,text/xml,*/*" } });
      const text = await response.text();
      const picks = {};
      for (const term of ["Login", "Authentication", "complexType name=\\\"Token\\\"", "complexType name=\\\"Organisation\\\"", "TokenCode", "ReqToken"]) {
        const i = text.indexOf(term);
        picks[term] = i >= 0 ? text.slice(Math.max(0, i - 1200), Math.min(text.length, i + 3500)) : null;
      }
      legacyCommonWsdl = { status: response.status, contentType: response.headers.get("content-type"), picks };
    } catch (e) {
      legacyCommonWsdl = { error: String(e.message || e).slice(0, 500) };
    }

    return jsonReply({ ok: true, client: a.client, branches: branches.map(simpleBranch), depots: depots.map(simpleDepot), schema, legacyTest, legacyWsdl, legacyCommonWsdl });`;

if (s.includes(commonTarget)) s = s.replace(commonTarget, commonReplacement);



const legacyPostAnchor = `async function legacyPost(method, body) {`;

const legacyAuthHelpers = `
async function legacyCommonCall(method, body, extraHeaders = {}) {
  const origin = new URL(BASE).origin;
  const headers = {
    "Accept": "application/json, */*",
    "Content-Type": "application/json; charset=utf-8",
    "X-Requested-With": "XMLHttpRequest",
    "ApplicationCode": "ProvectaPOS.Central",
    "CultureCode": "ru-RU",
    ...extraHeaders
  };
  return fetchJson(origin + \`/services/Framework/Common.svc/Web/\${method}\`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  }, 0);
}

function safeTokenSummary(t) {
  if (!t || typeof t !== "object") return { type: t === null ? "null" : typeof t };
  const keys = Object.keys(t);
  const nested = {};
  for (const k of keys) {
    const v = t[k];
    if (v && typeof v === "object" && !Array.isArray(v)) nested[k] = Object.keys(v).slice(0, 20);
    else if (Array.isArray(v)) nested[k] = { type: "array", length: v.length, firstKeys: v[0] && typeof v[0] === "object" ? Object.keys(v[0]).slice(0, 20) : [] };
    else nested[k] = { type: typeof v, present: v !== null && v !== undefined && v !== "" };
  }
  return {
    type: "object",
    keys,
    hasCode: typeof t.Code === "string" && t.Code.length > 0,
    codeLength: typeof t.Code === "string" ? t.Code.length : 0,
    nested
  };
}

async function legacyAuthDiagnostic() {
  const attempts = [];
  const loginBodies = [
    { userCode: USERNAME, userPassword: PASSWORD },
    { userCode: String(USERNAME || "").toLowerCase(), userPassword: PASSWORD }
  ];
  const headerSets = [
    {},
    { "ClientApplication": "ProvectaPOS.Central" },
    { "ClientPlatform": "Web", "ClientApplication": "ProvectaPOS.Central" }
  ];

  for (let hi = 0; hi < headerSets.length; hi++) {
    for (const body of loginBodies) {
      try {
        const data = await legacyCommonCall("Login", body, headerSets[hi]);
        const summary = safeTokenSummary(data);
        attempts.push({ step: "Login", headerVariant: hi, ok: true, summary });
        if (data && typeof data === "object") {
          const token = data.LoginResult ?? data.loginResult ?? data;
          const tokenSummary = safeTokenSummary(token);
          attempts.push({ step: "LoginToken", headerVariant: hi, ok: true, summary: tokenSummary });

          const code = token?.Code ?? token?.code ?? "";
          if (code) {
            const modern = await login(false);
            const orgBodies = [
              { organisation: { Id: modern.client } },
              { organisation: { id: modern.client } }
            ];
            const authHeaders = [
              { "TokenCode": code },
              { "X-Mx-ReqToken": code },
              { "TokenCode": code, "X-Mx-ReqToken": code },
              { "Authorization": code },
              { "Authorization": \`Bearer \${code}\` }
            ];
            for (let ai = 0; ai < authHeaders.length; ai++) {
              for (const orgBody of orgBodies) {
                try {
                  const authData = await legacyCommonCall("Authentication", orgBody, authHeaders[ai]);
                  const authToken = authData?.AuthenticationResult ?? authData?.authenticationResult ?? authData;
                  attempts.push({
                    step: "Authentication",
                    headerVariant: ai,
                    orgShape: Object.keys(orgBody.organisation),
                    ok: true,
                    summary: safeTokenSummary(authToken)
                  });
                  if (authToken && typeof authToken === "object" && (authToken.Code || authToken.code)) {
                    return { ok: true, attempts, token: authToken };
                  }
                } catch (e) {
                  attempts.push({ step: "Authentication", headerVariant: ai, orgShape: Object.keys(orgBody.organisation), ok: false, status: e.status || null, error: String(e.message || e).slice(0, 180) });
                }
              }
            }
          }
        }
      } catch (e) {
        attempts.push({ step: "Login", headerVariant: hi, ok: false, status: e.status || null, error: String(e.message || e).slice(0, 180) });
      }
    }
  }
  return { ok: false, attempts, token: null };
}

`;

if (s.includes(legacyPostAnchor) && !s.includes("async function legacyAuthDiagnostic()")) {
  s = s.replace(legacyPostAnchor, legacyAuthHelpers + legacyPostAnchor);
}

const finalStatusTarget = `    return jsonReply({ ok: true, client: a.client, branches: branches.map(simpleBranch), depots: depots.map(simpleDepot), schema, legacyTest, legacyWsdl, legacyCommonWsdl });`;
const finalStatusReplacement = `    let legacyAuth = null;
    try {
      const x = await legacyAuthDiagnostic();
      legacyAuth = { ok: x.ok, attempts: x.attempts };
    } catch (e) {
      legacyAuth = { ok: false, error: String(e.message || e).slice(0, 300) };
    }
    return jsonReply({ ok: true, client: a.client, branches: branches.map(simpleBranch), depots: depots.map(simpleDepot), schema, legacyTest, legacyWsdl, legacyCommonWsdl, legacyAuth });`;

if (s.includes(finalStatusTarget)) s = s.replace(finalStatusTarget, finalStatusReplacement);

fs.writeFileSync(path, s);
