import { createServer } from "node:http";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const MCP_PATH = "/mcp";
const PORT = Number(process.env.PORT || 8080);
const BASE = (process.env.PROVECTA_BASE_URL || "https://provectapos.com/proxy/api").replace(/\/$/, "");
const USERNAME = process.env.PROVECTA_USERNAME || "";
const PASSWORD = process.env.PROVECTA_PASSWORD || "";
const FIXED_CLIENT = process.env.PROVECTA_CLIENT_ID || "";
const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN || "";
const SALE_OPERATION = process.env.PROVECTA_SALE_OPERATION || "OutcomeRegular";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const OAUTH_SIGNING_SECRET = process.env.OAUTH_SIGNING_SECRET || MCP_ACCESS_TOKEN;
const OAUTH_CONNECT_CODE = process.env.OAUTH_CONNECT_CODE || (MCP_ACCESS_TOKEN ? crypto.createHash("sha256").update(`pudra-connect:${MCP_ACCESS_TOKEN}`).digest("hex").slice(0, 12).toUpperCase() : "");
const OAUTH_SCOPE = "pudra.read";
const usedAuthorizationCodes = new Set();

let authCache = { token: "", client: "", expiresAt: 0 };
let articleCache = { at: 0, items: [], byId: new Map(), byBarcode: new Map() };
let branchCache = { at: 0, items: [] };
let depotCache = { at: 0, items: [] };
let stockCache = { at: 0, byArticle: new Map(), ready: false, refreshing: false };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, options = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      const r = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      const text = await r.text();
      let data = text;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!r.ok) {
        const detail = typeof data === "string" ? data.slice(0, 1000) : JSON.stringify(data)?.slice(0, 1000);
        const err = new Error(`Provecta HTTP ${r.status} ${r.statusText}${detail ? ` | ${detail}` : ""}`);
        err.status = r.status;
        err.body = typeof data === "string" ? data.slice(0, 1000) : data;
        throw err;
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (i < retries && (e.name === "AbortError" || !e.status || e.status >= 500)) {
        await sleep(250 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function extractClient(clients) {
  if (FIXED_CLIENT) return FIXED_CLIENT;
  if (!Array.isArray(clients) || clients.length === 0) return "";
  const c = clients[0];
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    return c.Id || c.id || c.ClientId || c.clientId || c.Uuid || c.uuid || c.Code || c.code || "";
  }
  return "";
}

async function login(force = false) {
  if (!USERNAME || !PASSWORD) throw new Error("PROVECTA_USERNAME/PROVECTA_PASSWORD are not configured on the server");
  const now = Date.now();
  if (!force && authCache.token && authCache.client && authCache.expiresAt > now + 120000) return authCache;

  const usernames = [...new Set([USERNAME, USERNAME.toLowerCase()])];
  const variants = ["json-body", "query-plain", "query-json-header", "form-body"];
  let lastError;

  for (const username of usernames) {
    for (const variant of variants) {
      try {
        const u = new URL(`${BASE}/v1/framework/common/login`);
        const headers = { "Accept": "application/json, */*" };
        const options = { method: "POST", headers };

        if (variant === "query-plain" || variant === "query-json-header") {
          u.searchParams.set("username", username);
          u.searchParams.set("password", PASSWORD);
          if (variant === "query-json-header") headers["Content-Type"] = "application/json";
        } else if (variant === "form-body") {
          headers["Content-Type"] = "application/x-www-form-urlencoded";
          options.body = new URLSearchParams({ username, password: PASSWORD }).toString();
        } else if (variant === "json-body") {
          headers["Content-Type"] = "application/json";
          options.body = JSON.stringify({ username, password: PASSWORD });
        }

        const data = await fetchJson(u.toString(), options, 0);
        const token = data?.token || data?.Token;
        const client = extractClient(data?.clients || data?.Clients);
        if (!token) throw new Error("Provecta login response has no token");
        if (!client) throw new Error("Provecta login response has no client identifier");

        let ttlMs = Number(data?.expiresIn || data?.ExpiresIn || 3600000);
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) ttlMs = 3600000;
        authCache = { token, client, expiresAt: Date.now() + Math.min(ttlMs, 7 * 24 * 3600000) };
        return authCache;
      } catch (e) {
        lastError = e;
        console.error("Provecta login attempt failed", { variant, usernameVariant: username === USERNAME ? "exact" : "lower", status: e.status || null, body: e.body || null });
        if (e.status && e.status !== 400 && e.status !== 401 && e.status !== 403 && e.status < 500) throw e;
      }
    }
  }
  throw lastError;
}

async function apiGet(path, params = {}, retryAuth = true) {
  let a = await login(false);
  const u = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach(v => u.searchParams.append(key, String(v)));
    else u.searchParams.set(key, String(value));
  }
  try {
    return await fetchJson(u.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${a.token}`,
        "Client": a.client
      }
    }, 1);
  } catch (e) {
    if (retryAuth && (e.status === 401 || e.status === 403)) {
      authCache = { token: "", client: "", expiresAt: 0 };
      a = await login(true);
      return apiGet(path, params, false);
    }
    throw e;
  }
}

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function idOf(x) {
  if (x == null) return "";
  if (typeof x === "string" || typeof x === "number") return String(x);
  return String(x.Id ?? x.id ?? x.ArticleId ?? x.articleId ?? x.DocumentId ?? x.documentId ?? "");
}
function nameOf(x) {
  if (x == null) return "";
  if (typeof x === "string") return x;
  return x.Name ?? x.name ?? x.Code ?? x.code ?? "";
}

async function getBranches(force = false) {
  if (!force && Date.now() - branchCache.at < 30 * 60 * 1000 && branchCache.items.length) return branchCache.items;
  const items = asArray(await apiGet("/v1/framework/owner/branch/select"));
  branchCache = { at: Date.now(), items };
  return items;
}
async function getDepots(force = false) {
  if (!force && Date.now() - depotCache.at < 30 * 60 * 1000 && depotCache.items.length) return depotCache.items;
  const items = asArray(await apiGet("/v1/stock/depot/select"));
  depotCache = { at: Date.now(), items };
  return items;
}
async function getArticles(force = false) {
  if (!force && Date.now() - articleCache.at < 30 * 60 * 1000 && articleCache.items.length) return articleCache.items;
  const items = asArray(await apiGet("/v1/stock/article/select"));
  const byId = new Map();
  const byBarcode = new Map();
  for (const a of items) {
    const id = idOf(a);
    const bc = String(a.Barcode ?? a.barcode ?? "").trim();
    if (id) byId.set(id, a);
    if (bc) byBarcode.set(bc, a);
  }
  articleCache = { at: Date.now(), items, byId, byBarcode };
  return items;
}

async function refreshStockCache(force = false) {
  if (stockCache.refreshing) return;
  if (!force && stockCache.ready && Date.now() - stockCache.at < 5 * 60 * 1000) return;

  stockCache.refreshing = true;
  try {
    const depots = (await getDepots(false)).map(simpleDepot).filter(d => d.id);
    const byArticle = new Map();

    for (let i = 0; i < depots.length; i += 2) {
      const batch = depots.slice(i, i + 2);
      const results = await Promise.all(batch.map(async depot => {
        const rows = asArray(await apiGet("/v1/resume/currentBalance", { depotId: [depot.id] }));
        return { depot, rows };
      }));

      for (const { depot, rows } of results) {
        for (const row of rows) {
          const aid = idOf(row.Article ?? row.article ?? row.ArticleId ?? row.articleId);
          if (!aid) continue;
          const qty = Number(row.BalanceQuantitySum ?? row.balanceQuantitySum ?? 0) || 0;
          if (!byArticle.has(aid)) byArticle.set(aid, []);
          byArticle.get(aid).push({ id: depot.id, name: depot.name, quantity: qty });
        }
      }
    }

    stockCache = { at: Date.now(), byArticle, ready: true, refreshing: false };
    console.log(`Stock cache ready: ${byArticle.size} articles across depots`);
  } catch (e) {
    stockCache.refreshing = false;
    console.error("Stock cache refresh failed", e?.message || e);
  }
}

function getCachedStocks(articleId) {
  if (!stockCache.ready) return null;
  const depots = depotCache.items.map(simpleDepot).filter(d => d.id);
  const found = new Map((stockCache.byArticle.get(articleId) || []).map(x => [x.id, x]));
  return depots.map(d => found.get(d.id) || { id: d.id, name: d.name, quantity: 0 });
}

function normalizeDateTime(s, end = false) {
  if (!s) return undefined;
  return s;
}

async function getDocuments(dateFrom, dateTo, extra = {}) {
  const params = {
    documentApprovedOnDateFrom: normalizeDateTime(dateFrom, false),
    documentApprovedOnDateTo: normalizeDateTime(dateTo || dateFrom, true),
    ...extra
  };
  return asArray(await apiGet("/v1/stock/document/select", params));
}
async function getLots(dateFrom, dateTo, extra = {}) {
  const params = {
    documentApprovedOnDateFrom: normalizeDateTime(dateFrom, false),
    documentApprovedOnDateTo: normalizeDateTime(dateTo || dateFrom, true),
    ...extra
  };
  return asArray(await apiGet("/v1/stock/lot/select", params));
}

function simpleBranch(b) { return { id: idOf(b), code: b.Code ?? b.code ?? "", name: b.Name ?? b.name ?? "" }; }
function simpleDepot(d) { return { id: idOf(d), code: d.Code ?? d.code ?? "", name: d.Name ?? d.name ?? "", branch: d.Branch ?? d.branch ?? null }; }
function simpleArticle(a) { return { id: idOf(a), barcode: a.Barcode ?? a.barcode ?? "", code: a.Code ?? a.code ?? "", name: a.Name ?? a.name ?? "", price: a.Price ?? a.price ?? null, reserve: a.Reserve ?? a.reserve ?? null }; }

function docOperation(d) { return d.DocumentOperationType ?? d.documentOperationType ?? ""; }
function docId(d) { return idOf(d.Id ?? d.id ?? d); }
function lotDocId(l) { return idOf(l.Document ?? l.document ?? l.DocumentId ?? l.documentId); }
function lotArticleId(l) { return idOf(l.Article ?? l.article ?? l.ArticleId ?? l.articleId); }
function lotQty(l) { return Number(l.Quantity ?? l.quantity ?? l.BalanceQuantity ?? l.balanceQuantity ?? 0) || 0; }
function lotPrice(l) {
  const vals = [l.CreditPrice, l.creditPrice, l.DebitPrice, l.debitPrice, l.Price, l.price];
  for (const v of vals) { const n = Number(v); if (Number.isFinite(n) && n !== 0) return n; }
  return 0;
}
function docDepotId(d) {
  return idOf(d.CreditDepot ?? d.creditDepot ?? d.DebitDepot ?? d.debitDepot ?? "");
}

async function salesRows(dateFrom, dateTo, depotIds = []) {
  await getArticles(false);
  const [docs, lots] = await Promise.all([getDocuments(dateFrom, dateTo), getLots(dateFrom, dateTo)]);
  let saleDocs = docs.filter(d => String(docOperation(d)).toLowerCase() === String(SALE_OPERATION).toLowerCase());
  if (depotIds?.length) {
    const set = new Set(depotIds.map(String));
    saleDocs = saleDocs.filter(d => set.has(docDepotId(d)) || set.has(idOf(d.CreditDepot)) || set.has(idOf(d.DebitDepot)));
  }
  const ids = new Set(saleDocs.map(docId));
  const rows = [];
  for (const l of lots) {
    if (!ids.has(lotDocId(l))) continue;
    const aid = lotArticleId(l);
    const a = articleCache.byId.get(aid) || (l.Article && typeof l.Article === "object" ? l.Article : {});
    const qty = Math.abs(lotQty(l));
    if (!qty) continue;
    const price = lotPrice(l) || Number(a?.Price || 0) || 0;
    rows.push({
      documentId: lotDocId(l), articleId: aid, barcode: a?.Barcode ?? a?.barcode ?? "",
      code: a?.Code ?? a?.code ?? "", name: a?.Name ?? a?.name ?? nameOf(l.Article),
      quantity: qty, price, amount: qty * price
    });
  }
  return { documents: saleDocs, rows, allDocumentOperations: [...new Set(docs.map(docOperation).filter(Boolean))] };
}

function aggregateSales(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.articleId || r.barcode || r.name;
    const x = m.get(k) || { articleId: r.articleId, barcode: r.barcode, code: r.code, name: r.name, quantity: 0, amount: 0 };
    x.quantity += r.quantity;
    x.amount += r.amount;
    m.set(k, x);
  }
  return [...m.values()];
}

function jsonReply(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function createMcpServer() {
  const mcp = new McpServer(
    { name: "PUDRA Provecta", version: "1.0.0" },
    { instructions: "Read-only access to FAMILYTURCOMPANY / PUDRA data in Provecta. Never claim a transfer, receipt, order or other Provecta document was created: the external Provecta API is read-only. For sales, use top_selling_products/sales_summary; if results look implausible, use recent_documents to calibrate operation types before answering." }
  );

  mcp.registerTool("connection_status", {
    title: "Provecta connection status",
    description: "Verify Provecta credentials and return the selected client plus branch/depot counts.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async () => {
    const a = await login(true);
    const [branches, depots] = await Promise.all([getBranches(true), getDepots(true)]);
    let schema = null;
    try {
      const docs = await fetchJson(`${BASE}/v2/api-docs`, { method: "GET", headers: { "Accept": "application/json" } }, 0);
      const keys = Object.keys(docs?.paths || {}).filter(k => k.includes("/stock/document/select") || k.includes("/stock/lot/select"));
      schema = Object.fromEntries(keys.map(k => [k, docs.paths[k]]));
    } catch {}
    return jsonReply({ ok: true, client: a.client, branches: branches.map(simpleBranch), depots: depots.map(simpleDepot), schema });
  });

  mcp.registerTool("list_branches", {
    title: "List PUDRA branches",
    description: "Return all Provecta branches for the connected FAMILYTURCOMPANY client.",
    inputSchema: { refresh: z.boolean().optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ refresh }) => jsonReply({ branches: (await getBranches(Boolean(refresh))).map(simpleBranch) }));

  mcp.registerTool("list_depots", {
    title: "List Provecta depots",
    description: "Return all depots/warehouses in Provecta.",
    inputSchema: { refresh: z.boolean().optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ refresh }) => jsonReply({ depots: (await getDepots(Boolean(refresh))).map(simpleDepot) }));

  mcp.registerTool("find_products", {
    title: "Find products",
    description: "Search Provecta product catalog by name, barcode or code.",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(100).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ query, limit = 30 }) => {
    const q = query.toLowerCase();
    const items = (await getArticles(false))
      .filter(a => [a.Name, a.name, a.Barcode, a.barcode, a.Code, a.code].some(v => String(v || "").toLowerCase().includes(q)))
      .slice(0, limit)
      .map(simpleArticle);

    if (/^\d{8,14}$/.test(query) && items.length === 1 && String(items[0].barcode || "") === query) {
      if (!stockCache.ready) {
        refreshStockCache(false).catch(() => {});
        const started = Date.now();
        while (!stockCache.ready && Date.now() - started < 2500) await sleep(100);
      } else if (Date.now() - stockCache.at > 5 * 60 * 1000) {
        refreshStockCache(false).catch(() => {});
      }

      const stocks = getCachedStocks(items[0].id);
      if (stocks) {
        const totalQuantity = stocks.reduce((sum, x) => sum + x.quantity, 0);
        return jsonReply({ query, count: 1, products: [{ ...items[0], stocks, totalQuantity, stockCacheAgeMs: Date.now() - stockCache.at }] });
      }
    }

    return jsonReply({ query, count: items.length, products: items });
  });

  mcp.registerTool("current_stock", {
    title: "Current stock",
    description: "Get current Provecta balances. Optionally filter by branch IDs and/or depot IDs.",
    inputSchema: { branchIds: z.array(z.string()).optional(), depotIds: z.array(z.string()).optional(), limit: z.number().int().min(1).max(20000).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ branchIds = [], depotIds = [], limit = 10000 }) => {
    const data = asArray(await apiGet("/v1/resume/currentBalance", { branchId: branchIds, depotId: depotIds }));
    return jsonReply({ count: Math.min(data.length, limit), totalReturnedByProvecta: data.length, items: data.slice(0, limit) });
  });

  mcp.registerTool("recent_documents", {
    title: "Provecta documents for a period",
    description: "Read Provecta documents for a date range. Useful for diagnostics, sales calibration, receipts and transfers.",
    inputSchema: { dateFrom: z.string(), dateTo: z.string().optional(), operationTypes: z.array(z.string()).optional(), limit: z.number().int().min(1).max(5000).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ dateFrom, dateTo, operationTypes = [], limit = 1000 }) => {
    let docs = await getDocuments(dateFrom, dateTo || dateFrom);
    if (operationTypes.length) { const s = new Set(operationTypes.map(x => x.toLowerCase())); docs = docs.filter(d => s.has(String(docOperation(d)).toLowerCase())); }
    const ops = [...new Set(docs.map(docOperation).filter(Boolean))];
    return jsonReply({ count: Math.min(docs.length, limit), total: docs.length, operationTypes: ops, documents: docs.slice(0, limit) });
  });

  mcp.registerTool("sales_summary", {
    title: "Sales summary",
    description: "Summarize retail sales for a date range using the configured Provecta sale operation. Returns total units, estimated amount and detected document operation types for calibration.",
    inputSchema: { dateFrom: z.string(), dateTo: z.string().optional(), depotIds: z.array(z.string()).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ dateFrom, dateTo, depotIds = [] }) => {
    const s = await salesRows(dateFrom, dateTo || dateFrom, depotIds);
    const totalUnits = s.rows.reduce((a, r) => a + r.quantity, 0);
    const estimatedAmount = s.rows.reduce((a, r) => a + r.amount, 0);
    return jsonReply({ saleOperation: SALE_OPERATION, saleDocuments: s.documents.length, lineCount: s.rows.length, totalUnits, estimatedAmount, allDocumentOperations: s.allDocumentOperations });
  });

  mcp.registerTool("top_selling_products", {
    title: "Top selling products",
    description: "Return top-selling products for a date range, ranked by quantity or estimated sales amount.",
    inputSchema: { dateFrom: z.string(), dateTo: z.string().optional(), depotIds: z.array(z.string()).optional(), rankBy: z.enum(["quantity", "amount"]).optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ dateFrom, dateTo, depotIds = [], rankBy = "quantity", limit = 50 }) => {
    const s = await salesRows(dateFrom, dateTo || dateFrom, depotIds);
    const items = aggregateSales(s.rows).sort((a,b) => b[rankBy] - a[rankBy]).slice(0, limit);
    return jsonReply({ saleOperation: SALE_OPERATION, rankBy, count: items.length, products: items, saleDocuments: s.documents.length, allDocumentOperations: s.allDocumentOperations });
  });

  mcp.registerTool("debug_api_schema", {
    title: "Debug Provecta API schema",
    description: "Read Swagger parameter definitions for selected Provecta endpoints.",
    inputSchema: {},
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async () => {
    const docs = await fetchJson(`${BASE}/v2/api-docs`, { method: "GET", headers: { "Accept": "application/json" } }, 0);
    const pick = {};
    for (const p of ["/v1/stock/document/select", "/v1/stock/lot/select"]) {
      pick[p] = docs?.paths?.[p] || null;
    }
    return jsonReply({ paths: pick });
  });

  mcp.registerTool("raw_lots", {
    title: "Provecta lots for a period",
    description: "Read lot/document-line records for diagnostics or detailed analysis.",
    inputSchema: { dateFrom: z.string(), dateTo: z.string().optional(), documentIds: z.array(z.string()).optional(), articleIds: z.array(z.string()).optional(), limit: z.number().int().min(1).max(10000).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ dateFrom, dateTo, documentIds = [], articleIds = [], limit = 3000 }) => {
    const lots = await getLots(dateFrom, dateTo || dateFrom, { documentId: documentIds, lotArticleId: articleIds });
    return jsonReply({ count: Math.min(lots.length, limit), total: lots.length, lots: lots.slice(0, limit) });
  });

  return mcp;
}

function publicBase(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}
function fromB64url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}
function hmac(value) {
  if (!OAUTH_SIGNING_SECRET) throw new Error("OAUTH_SIGNING_SECRET is not configured");
  return crypto.createHmac("sha256", OAUTH_SIGNING_SECRET).update(value).digest("base64url");
}
function signObject(prefix, obj) {
  const payload = b64url(JSON.stringify(obj));
  const body = `${prefix}.${payload}`;
  return `${body}.${hmac(body)}`;
}
function verifyObject(token, prefix) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(hmac(body));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const obj = JSON.parse(fromB64url(parts[1]));
    if (obj.exp && Number(obj.exp) < Math.floor(Date.now() / 1000)) return null;
    return obj;
  } catch { return null; }
}
function sameSecret(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}
function oauthMetadata(req) {
  const base = publicBase(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true
  };
}
function protectedResourceMetadata(req) {
  const base = publicBase(req);
  return {
    resource: `${base}${MCP_PATH}`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE]
  };
}
function verifyClientId(clientId) {
  return verifyObject(clientId, "pudra_client");
}
function createAccessToken(resource, clientId, scope, lifetimeSec = 7 * 24 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  return signObject("pudra_at", { typ: "access", aud: resource, client_id: clientId, scope, iat: now, exp: now + lifetimeSec, jti: crypto.randomUUID() });
}
function createRefreshToken(resource, clientId, scope, lifetimeSec = 180 * 24 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  return signObject("pudra_rt", { typ: "refresh", aud: resource, client_id: clientId, scope, iat: now, exp: now + lifetimeSec, jti: crypto.randomUUID() });
}
function authorized(req) {
  return true;
}
function oauthChallenge(req) {
  const base = publicBase(req);
  return `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="${OAUTH_SCOPE}"`;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "PUDRA Provecta MCP", mcp: MCP_PATH, oauth: true }));
    return;
  }

  if (req.method === "GET" && (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")) {
    sendJson(res, 200, oauthMetadata(req));
    return;
  }
  if (req.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) {
    sendJson(res, 200, protectedResourceMetadata(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/oauth/register") {
    try {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(x => typeof x === "string" && x.startsWith("https://")) : [];
      if (!redirects.length) return sendJson(res, 400, { error: "invalid_client_metadata", error_description: "redirect_uris required" });
      const now = Math.floor(Date.now() / 1000);
      const clientId = signObject("pudra_client", { redirect_uris: redirects, iat: now, exp: now + 365 * 24 * 3600 });
      sendJson(res, 201, {
        client_id: clientId,
        client_id_issued_at: now,
        redirect_uris: redirects,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: body.client_name || "ChatGPT"
      });
    } catch (e) {
      sendJson(res, 400, { error: "invalid_client_metadata" });
    }
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/oauth/authorize") {
    let params = url.searchParams;
    let submittedCode = "";
    if (req.method === "POST") {
      const raw = await readBody(req);
      const form = new URLSearchParams(raw);
      params = form;
      submittedCode = form.get("connect_code") || "";
    }
    const clientId = params.get("client_id") || "";
    const redirectUri = params.get("redirect_uri") || "";
    const responseType = params.get("response_type") || "";
    const state = params.get("state") || "";
    const challenge = params.get("code_challenge") || "";
    const challengeMethod = params.get("code_challenge_method") || "";
    const scope = params.get("scope") || OAUTH_SCOPE;
    const resource = params.get("resource") || `${publicBase(req)}${MCP_PATH}`;
    const client = verifyClientId(clientId);
    if (!client || !Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirectUri) || responseType !== "code" || challengeMethod !== "S256" || !challenge) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Invalid OAuth request");
      return;
    }
    if (req.method === "POST") {
      if (!OAUTH_CONNECT_CODE || !sameSecret(submittedCode, OAUTH_CONNECT_CODE)) {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        res.end("<h2>Incorrect connection code</h2><p>Return to ChatGPT and try connecting again.</p>");
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();
      const code = signObject("pudra_code", { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, scope, resource, nonce, iat: now, exp: now + 180 });
      const dest = new URL(redirectUri);
      dest.searchParams.set("code", code);
      if (state) dest.searchParams.set("state", state);
      dest.searchParams.set("iss", publicBase(req));
      res.writeHead(302, { location: dest.toString(), "cache-control": "no-store" });
      res.end();
      return;
    }
    const hidden = [...params.entries()].map(([k,v]) => `<input type="hidden" name="${String(k).replace(/"/g,"&quot;")}" value="${String(v).replace(/"/g,"&quot;")}">`).join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" });
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect PUDRA</title><style>body{font-family:system-ui;max-width:520px;margin:60px auto;padding:20px}input,button{font-size:18px;padding:12px;width:100%;box-sizing:border-box;margin-top:12px}button{cursor:pointer}p{color:#555}</style></head><body><h1>Connect PUDRA</h1><p>Enter the one-time connection code for the private PUDRA Provecta connector.</p><form method="post" action="/oauth/authorize">${hidden}<input name="connect_code" type="password" autocomplete="one-time-code" required placeholder="Connection code"><button type="submit">Connect</button></form></body></html>`);
    return;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    try {
      const raw = await readBody(req);
      const form = new URLSearchParams(raw);
      const grantType = form.get("grant_type") || "";
      const clientId = form.get("client_id") || "";
      const client = verifyClientId(clientId);
      if (!client) return sendJson(res, 400, { error: "invalid_client" });
      if (grantType === "authorization_code") {
        const code = verifyObject(form.get("code") || "", "pudra_code");
        const verifier = form.get("code_verifier") || "";
        const redirectUri = form.get("redirect_uri") || "";
        if (!code || code.client_id !== clientId || code.redirect_uri !== redirectUri || usedAuthorizationCodes.has(code.nonce)) return sendJson(res, 400, { error: "invalid_grant" });
        const computed = crypto.createHash("sha256").update(verifier).digest("base64url");
        if (!sameSecret(computed, code.code_challenge)) return sendJson(res, 400, { error: "invalid_grant" });
        usedAuthorizationCodes.add(code.nonce);
        const access = createAccessToken(code.resource, clientId, code.scope || OAUTH_SCOPE);
        const refresh = createRefreshToken(code.resource, clientId, code.scope || OAUTH_SCOPE);
        return sendJson(res, 200, { access_token: access, token_type: "Bearer", expires_in: 7 * 24 * 3600, refresh_token: refresh, scope: code.scope || OAUTH_SCOPE });
      }
      if (grantType === "refresh_token") {
        const rt = verifyObject(form.get("refresh_token") || "", "pudra_rt");
        if (!rt || rt.typ !== "refresh" || rt.client_id !== clientId) return sendJson(res, 400, { error: "invalid_grant" });
        const access = createAccessToken(rt.aud, clientId, rt.scope || OAUTH_SCOPE);
        const refresh = createRefreshToken(rt.aud, clientId, rt.scope || OAUTH_SCOPE);
        return sendJson(res, 200, { access_token: access, token_type: "Bearer", expires_in: 7 * 24 * 3600, refresh_token: refresh, scope: rt.scope || OAUTH_SCOPE });
      }
      return sendJson(res, 400, { error: "unsupported_grant_type" });
    } catch (e) {
      return sendJson(res, 400, { error: "invalid_request" });
    }
  }

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id"
    });
    res.end();
    return;
  }
  if (url.pathname === MCP_PATH && ["POST", "GET", "DELETE"].includes(req.method || "")) {
    if (!authorized(req)) {
      res.writeHead(401, { "content-type": "application/json", "WWW-Authenticate": oauthChallenge(req) });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    const mcp = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { try { transport.close(); } catch {} try { mcp.close(); } catch {} });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error("MCP error", e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: "MCP request failed" }));
    }
    return;
  }
  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`PUDRA Provecta MCP listening on :${PORT}${MCP_PATH}`);
  Promise.all([getArticles(false), getDepots(false)])
    .then(() => refreshStockCache(true))
    .catch(e => console.error("Warm-up failed", e?.message || e));
  setInterval(() => refreshStockCache(false).catch(() => {}), 5 * 60 * 1000).unref();
});
