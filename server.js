// oauth-update-test
import { createServer } from "node:http";
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

let authCache = { token: "", client: "", expiresAt: 0 };
let articleCache = { at: 0, items: [], byId: new Map(), byBarcode: new Map() };
let branchCache = { at: 0, items: [] };
let depotCache = { at: 0, items: [] };

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
        const err = new Error(`Provecta HTTP ${r.status} ${r.statusText}`);
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

  const attempts = [USERNAME];
  const lower = USERNAME.toLowerCase();
  if (lower !== USERNAME) attempts.push(lower);

  let lastError;
  for (const username of attempts) {
    try {
      const u = new URL(`${BASE}/v1/framework/common/login`);
      u.searchParams.set("username", username);
      u.searchParams.set("password", PASSWORD);
      const data = await fetchJson(u.toString(), {
        method: "POST",
        headers: { "Accept": "application/json, */*", "Content-Type": "application/json" }
      }, 0);
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
      if (e.status !== 403) break;
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

function normalizeDateTime(s, end = false) {
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T${end ? "23:59:59" : "00:00:00"}`;
  return s;
}

async function getDocuments(dateFrom, dateTo, extra = {}) {
  const params = {
    documentApprovedOnDateFrom: normalizeDateTime(dateFrom, false),
    documentApprovedOnDateTo: normalizeDateTime(dateTo || dateFrom, true),
    documentApprovedOnIncludeTime: true,
    order: "ApprovedOn",
    ...extra
  };
  return asArray(await apiGet("/v1/stock/document/select", params));
}
async function getLots(dateFrom, dateTo, extra = {}) {
  const params = {
    documentApprovedOnDateFrom: normalizeDateTime(dateFrom, false),
    documentApprovedOnDateTo: normalizeDateTime(dateTo || dateFrom, true),
    documentApprovedOnIncludeTime: true,
    order: "Document.ApprovedOn",
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
    return jsonReply({ ok: true, client: a.client, branches: branches.map(simpleBranch), depots: depots.map(simpleDepot) });
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
    const items = (await getArticles(false)).filter(a => [a.Name, a.name, a.Barcode, a.barcode, a.Code, a.code].some(v => String(v || "").toLowerCase().includes(q))).slice(0, limit).map(simpleArticle);
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

function authorized(req) {
  if (!MCP_ACCESS_TOKEN) return false;
  const h = String(req.headers.authorization || "");
  return h === `Bearer ${MCP_ACCESS_TOKEN}`;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "PUDRA Provecta MCP", mcp: MCP_PATH }));
    return;
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
      res.writeHead(401, { "content-type": "application/json", "WWW-Authenticate": "Bearer" });
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
});
