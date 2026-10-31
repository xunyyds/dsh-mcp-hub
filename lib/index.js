import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrBuildIndex, signatureOf } from "./capability-index.js";
import { firstSentence, normalizeTier } from "./context-budget.js";
import { createGateway } from "./gateway.js";
import { createJitHinter } from "./jit-hint.js";

const BASE = "/mcp-hub";
const PLUGIN_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function unsealServer(server) {
  if (server && typeof server.token === "string" && server.token.startsWith("enc:v1:")) {
    server.token = "";
    server.__tokenUnreadable = true;
  }
  return server;
}

function restrictToOwner(file) {
  if (process.platform !== "win32") {
    try {
      writeFileSync(file, readFileSync(file, "utf8"), { mode: 0o600 });
    } catch {}
    return;
  }
  try {
    const user = process.env.USERNAME;
    if (!user) return;
    spawnSync("icacls", [file, "/inheritance:r", "/grant:r", user + ":F"], { stdio: "ignore" });
  } catch {}
}

function configDir() {
  return join(dshHome(), "storages", "mcp-hub");
}

function configPath() {
  return join(configDir(), "config.json");
}
const DEFAULT_TRANSPORT = "streamable-http";

function sanitizeName(v, fallback) {
  const s = String(v || "").replace(/[^A-Za-z0-9_-]/g, "");
  return s || fallback;
}

function newServerId() {
  return "srv_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

function defaultServer() {
  return {
    id: newServerId(),
    name: "mcp",
    transport: DEFAULT_TRANSPORT,
    url: "",
    token: "",
    command: "",
    args: [],
    env: {},
    autoReconnect: true,
    toolCallTimeoutMs: 60000,
    enabled: true,
    approvalMode: "inherit",
    tools: {},
    budgetTier: "full"
  };
}

const APPROVAL_MODES = ["inherit", "follow", "manual"];

function normalizeApproval(raw) {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { followDsh: a.followDsh !== false };
}

function normalizeApprovalMode(v) {
  return APPROVAL_MODES.includes(v) ? v : "inherit";
}

const GATEWAY_DEFAULTS = { searchLimit: 8, catalogLimit: 200, schemaMaxBytes: 16000, loadBatchMax: 12, revealMax: 0 };

function normalizeGateway(raw) {
  const g = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const num = (v, lo, hi, fb) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
  };
  const reveal = Math.round(Number(g.revealMax));
  return {
    searchLimit: num(g.searchLimit, 1, 20, GATEWAY_DEFAULTS.searchLimit),
    catalogLimit: num(g.catalogLimit, 1, 500, GATEWAY_DEFAULTS.catalogLimit),
    schemaMaxBytes: num(g.schemaMaxBytes, 2000, 128000, GATEWAY_DEFAULTS.schemaMaxBytes),
    loadBatchMax: num(g.loadBatchMax, 1, 50, GATEWAY_DEFAULTS.loadBatchMax),
    revealMax: Number.isFinite(reveal) && reveal >= 0 ? reveal : GATEWAY_DEFAULTS.revealMax
  };
}

const CATALOG_DEFAULTS = { enabled: true, mode: "names", limit: 200, capabilities: true };
const CATALOG_MODES = ["names", "summary"];

function normalizeCatalog(raw) {
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const n = Math.round(Number(c.limit));
  return {
    enabled: c.enabled !== false,
    mode: CATALOG_MODES.includes(c.mode) ? c.mode : CATALOG_DEFAULTS.mode,
    limit: Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : CATALOG_DEFAULTS.limit,
    capabilities: c.capabilities !== false
  };
}

const HINT_DEFAULTS = { enabled: false, maxTotal: 3, maxPerServer: 1 };

function normalizeHint(raw) {
  const h = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const num = (v, lo, hi, fb) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
  };
  return {
    enabled: h.enabled === true,
    maxTotal: num(h.maxTotal, 0, 20, HINT_DEFAULTS.maxTotal),
    maxPerServer: num(h.maxPerServer, 0, 10, HINT_DEFAULTS.maxPerServer)
  };
}

function normalizeServer(raw) {
  const d = defaultServer();
  const clean = {};
  for (const k of Object.keys(raw || {})) {
    if (raw[k] !== undefined) clean[k] = raw[k];
  }
  const s = Object.assign(d, clean);
  s.id = String(s.id || d.id);
  s.name = sanitizeName(s.name, "mcp");
  s.transport = s.transport === "stdio" ? "stdio" : DEFAULT_TRANSPORT;
  s.url = String(s.url || "").trim();
  s.token = String(s.token || "").trim();
  s.command = String(s.command || "").trim();
  if (!Array.isArray(s.args)) s.args = [];
  s.args = s.args.map((a) => String(a));
  if (!s.env || typeof s.env !== "object" || Array.isArray(s.env)) s.env = {};
  if (!s.tools || typeof s.tools !== "object" || Array.isArray(s.tools)) s.tools = {};
  s.autoReconnect = s.autoReconnect !== false;
  s.enabled = s.enabled !== false;
  s.approvalMode = normalizeApprovalMode(s.approvalMode);
  s.budgetTier = normalizeTier(s.budgetTier);
  const t = Number(s.toolCallTimeoutMs);
  s.toolCallTimeoutMs = Number.isFinite(t) && t >= 1000 ? t : 60000;
  return s;
}

function migrateLegacy(raw) {
  if (!raw || Array.isArray(raw.servers)) return raw;
  const hasLegacy = raw.url !== undefined || raw.serverName !== undefined || raw.token !== undefined;
  if (!hasLegacy) return raw;
  return {
    ...raw,
    servers: [
      normalizeServer({
        id: newServerId(),
        name: raw.serverName || "qfun",
        transport: DEFAULT_TRANSPORT,
        url: raw.url,
        token: raw.token,
        autoReconnect: raw.autoReconnect,
        tools: raw.tools
      })
    ]
  };
}

const DEFAULT_CONFIG = { profile: "", approval: { followDsh: true }, gateway: GATEWAY_DEFAULTS, servers: [] };

export const inject = ["webServer", "tools"];
export const name = "mcp-hub";

let toolsRegistry = null;
let pluginCtx = null;

function readConfig() {
  try {
    if (!existsSync(configPath())) {
      const migrated = tryMigrateLegacyConfig();
      if (migrated) return migrated;
      return { profile: "", approval: normalizeApproval(), gateway: normalizeGateway(), catalog: normalizeCatalog(), hint: normalizeHint(), servers: [] };
    }
    const raw = migrateLegacy(JSON.parse(readFileSync(configPath(), "utf8") || "{}"));
    const cfg = { profile: String(raw.profile || ""), approval: normalizeApproval(raw.approval), gateway: normalizeGateway(raw.gateway), catalog: normalizeCatalog(raw.catalog), hint: normalizeHint(raw.hint), servers: [] };
    const list = Array.isArray(raw.servers) ? raw.servers : [];
    const seen = new Set();
    for (const item of list) {
      const s = normalizeServer(unsealServer(item));
      while (seen.has(s.id)) s.id = newServerId();
      seen.add(s.id);
      cfg.servers.push(s);
    }
    return cfg;
  } catch {
    return { profile: "", approval: normalizeApproval(), gateway: normalizeGateway(), catalog: normalizeCatalog(), hint: normalizeHint(), servers: [] };
  }
}

let cfg = readConfig();

let lastPersistError = null;

function persist() {
  let lastError = null;
  try {
    mkdirSync(configDir(), { recursive: true });
    const file = configPath();
    const onDisk = Object.assign({}, cfg, { servers: cfg.servers.map((s) => { const c = { ...s }; delete c.__tokenUnreadable; return c; }) });
    writeFileSync(file, JSON.stringify(onDisk, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    restrictToOwner(file);
  } catch (e) {
    lastError = e;
    try {
      pluginCtx?.logger?.warn?.("mcp-hub: 配置写入失败：" + String((e && e.message) || e));
    } catch {}
  }
  lastPersistError = lastError;
  return cfg;
}


function findServer(id) {
  if (!id) return cfg.servers[0] || null;
  return cfg.servers.find((s) => s.id === id) || null;
}

function upsertServer(input) {
  const raw = Object.assign({}, input);
  const incoming = normalizeServer(raw);
  const incomingId = String((raw && raw.id) || "");
  const idx = incomingId ? cfg.servers.findIndex((s) => s.id === incomingId) : -1;
  const clash = cfg.servers.some((s) => s.name === incoming.name && s.id !== incoming.id);
  if (clash) throw new Error("服务器名已存在：" + incoming.name);
  if (idx >= 0) {
    const prev = cfg.servers[idx];
    if (raw.token === undefined || raw.keepToken === true) incoming.token = prev.token;
    if (raw.tools === undefined) incoming.tools = prev.tools;
    if (raw.enabled === undefined) incoming.enabled = prev.enabled;
    if (raw.budgetTier === undefined) incoming.budgetTier = prev.budgetTier;
    cfg.servers[idx] = incoming;
  } else {
    cfg.servers.push(incoming);
  }
  persist();
  return incoming;
}

function removeServer(id) {
  const before = cfg.servers.length;
  const removed = cfg.servers.find((s) => s.id === id);
  cfg.servers = cfg.servers.filter((s) => s.id !== id);
  if (cfg.servers.length !== before) {
    conns.delete(id);
    if (removed) {
      const key = sanitizeName(removed.name, "mcp");
      dropGrantsForServerName(key);
    }
    persist();
    return true;
  }
  return false;
}

function storagesDir() {
  const base = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(base, "storages", "mcp-hub");
}

function legacyConfigPath() {
  return join(PLUGIN_ROOT, "config.json");
}

function tryMigrateLegacyConfig() {
  try {
    const legacy = legacyConfigPath();
    if (!existsSync(legacy)) return null;
    const raw = migrateLegacy(JSON.parse(readFileSync(legacy, "utf8") || "{}"));
    const next = { profile: String(raw.profile || ""), approval: normalizeApproval(raw.approval), servers: [] };
    for (const item of Array.isArray(raw.servers) ? raw.servers : []) next.servers.push(normalizeServer(item));
    if (!next.servers.length) return null;
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    restrictToOwner(configPath());
    return next;
  } catch {
    return null;
  }
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function dayOf(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function dayFile(day) {
  return join(storagesDir(), "calls-" + day + ".jsonl");
}

const MAX_RECORD_BYTES = 2 << 20;
const MAX_RECORD_LINES = 3000;

function trimRecordFile(file) {
  try {
    const st = statSync(file);
    if (st.size < MAX_RECORD_BYTES) return;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n").filter(Boolean);
    if (lines.length <= MAX_RECORD_LINES) return;
    writeFileSync(file, lines.slice(-MAX_RECORD_LINES).join("\n") + "\n", "utf8");
  } catch {}
}

function appendRecord(rec) {
  try {
    mkdirSync(storagesDir(), { recursive: true });
    const file = dayFile(dayOf(rec.t));
    appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    trimRecordFile(file);
  } catch {}
}

function previewArgs(args) {
  try {
    const s = JSON.stringify(args == null ? {} : args);
    return s.length > 240 ? s.slice(0, 240) + "…" : s;
  } catch {
    return "{}";
  }
}

function resultText(result) {
  try {
    const content = result && result.content;
    if (Array.isArray(content)) {
      const parts = [];
      for (const item of content) {
        if (item && typeof item.text === "string") parts.push(item.text);
        else parts.push(JSON.stringify(item));
      }
      return parts.join("\n");
    }
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

const conns = new Map();

function connFor(server) {
  const id = server && server.id ? server.id : "default";
  let c = conns.get(id);
  if (!c) {
    c = {
      status: "idle",
      lastError: "",
      latencyMs: 0,
      server: null,
      tools: [],
      toolsAt: 0,
      lastConnectedAt: 0,
      attempt: 0,
      nextRetryAt: 0
    };
    conns.set(id, c);
  }
  return c;
}

let rpcSeq = 1;
let inFlight = new WeakMap();

function authHeaders(server) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream"
  };
  if (server.token && server.token !== "none") headers.Authorization = "Bearer " + server.token;
  return headers;
}

async function rpc(server, method, params, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  const id = rpcSeq++;
  try {
    const res = await fetch(server.url, {
      method: "POST",
      headers: authHeaders(server),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }),
      signal: controller.signal,
      cache: "no-store"
    });
    if (res.status === 401) throw new Error("鉴权失败(401)：Token 无效或未授权");
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("响应不是 JSON（HTTP " + res.status + "）：" + text.slice(0, 120));
    }
    if (body && body.error) throw new Error("RPC 错误 " + body.error.code + ": " + body.error.message);
    return body ? body.result : {};
  } finally {
    clearTimeout(timer);
  }
}

async function connectOnce(server) {
  const conn = connFor(server);
  const t0 = Date.now();
  const init = await rpc(server, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "dsh-mcp-hub", version: "0.2.0" }
  }, 12000);
  conn.latencyMs = Date.now() - t0;
  conn.server = (init && init.serverInfo) || null;
  try {
    await rpc(server, "notifications/initialized", {}, 5000).catch(() => {});
  } catch {}
  const list = await rpc(server, "tools/list", {}, 12000);
  conn.tools = Array.isArray(list && list.tools) ? list.tools : [];
  conn.toolsAt = Date.now();
  conn.status = "connected";
  conn.lastError = "";
  conn.lastConnectedAt = Date.now();
  conn.attempt = 0;
  return conn;
}

async function reconnectNow(server) {
  const conn = connFor(server);
  if (server.transport === "stdio") {
    const managed = managedTools(server);
    conn.status = managed.length ? "managed" : "idle";
    conn.lastError = managed.length ? "" : "DSH 尚未注册该服务器的工具（检查 cordis.patch.yml 与 DSH 日志）";
    if (managed.length) conn.lastConnectedAt = conn.lastConnectedAt || Date.now();
    return managed.length ? { managed: true, tools: managed.length } : null;
  }
  if (!server.url) {
    conn.status = "offline";
    conn.lastError = "未填写 URL";
    return null;
  }
  conn.status = conn.lastConnectedAt ? "reconnecting" : "connecting";
  try {
    return await connectOnce(server);
  } catch (e) {
    conn.status = "offline";
    conn.lastError = String((e && e.message) || e);
    conn.attempt++;
    return null;
  }
}

function scheduleRetry(server) {
  if (!server.autoReconnect) return;
  const conn = connFor(server);
  const delay = Math.min(60000, 1000 * Math.pow(2, Math.min(conn.attempt, 6)));
  conn.nextRetryAt = Date.now() + delay;
  return delay;
}

async function ensureTools(server) {
  const conn = connFor(server);
  if (conn.status === "connected" && conn.tools.length) return conn.tools;
  await reconnectNow(server);
  return conn.tools;
}


function registryService(ctx) {
  if (toolsRegistry) return toolsRegistry;
  try {
    toolsRegistry = (ctx && typeof ctx.get === "function" ? ctx.get("tools") : null) || (ctx && ctx.tools) || null;
  } catch {
    toolsRegistry = null;
  }
  return toolsRegistry;
}

function toolPrefix(name) {
  return "mcp__" + sanitizeName(name, "mcp") + "__";
}

function managedTools(server) {
  if (!toolsRegistry && pluginCtx) registryService(pluginCtx);
  if (!toolsRegistry || typeof toolsRegistry.schemas !== "function") return [];
  const prefix = toolPrefix(server.name);
  let list = [];
  try {
    list = toolsRegistry.schemas() || [];
  } catch {
    return [];
  }
  const out = [];
  for (const s of list) {
    if (!s || typeof s.name !== "string" || !s.name.startsWith(prefix)) continue;
    out.push({
      name: s.name.slice(prefix.length),
      description: s.description || "",
      inputSchema: s.parameters || {}
    });
  }
  return out;
}

function usesRegistry(server) {
  if (!server) return false;
  if (server.transport === "stdio") return true;
  return managedTools(server).length > 0;
}

function policyFor(server, tool) {
  const p = (server.tools && server.tools[tool]) || {};
  return { enabled: p.enabled !== false, approval: p.approval === true };
}

function serverByToolName(name) {
  if (typeof name !== "string") return null;
  for (const s of cfg.servers) {
    if (name.startsWith("mcp__" + sanitizeName(s.name, "mcp") + "__")) return s;
  }
  return null;
}

function blockReason(fullName) {
  const server = serverByToolName(fullName);
  if (!server) return null;
  if (server.enabled === false) return "服务器 " + sanitizeName(server.name, "mcp") + " 已在面板中禁用";
  if (normalizeTier(server.budgetTier) === "off") return "服务器 " + sanitizeName(server.name, "mcp") + " 的投放档位是 off";
  const tool = String(fullName).slice(toolPrefix(server.name).length);
  if (!policyFor(server, tool).enabled) return "工具 " + tool + " 已在面板中禁用";
  return null;
}

function hiddenReason(fullName) {
  const blocked = blockReason(fullName);
  if (blocked) return blocked;
  const server = serverByToolName(fullName);
  if (!server) return null;
  return "服务器 " + sanitizeName(server.name, "mcp") + " 的工具按需展开";
}

function catalogTools(s) {
  const managed = managedTools(s);
  if (managed.length) return managed;
  const conn = connFor(s);
  return conn.status === "connected" ? conn.tools : [];
}

function catalogText() {
  const c = normalizeCatalog(cfg.catalog);
  if (!c.enabled) return "";
  const groups = [];
  let total = 0;
  for (const s of cfg.servers) {
    if (s.enabled === false) continue;
    const tools = catalogTools(s).filter((t) => policyFor(s, t.name).enabled);
    if (!tools.length) continue;
    const name = sanitizeName(s.name, "mcp");
    const meta = tools.map((t) => ({ name: t.name, description: t.description || "", parameters: t.inputSchema || {} }));
    groups.push({ server: name, count: tools.length, meta });
    total += tools.length;
  }
  if (!groups.length) return "";
  groups.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
  const shown = groups.slice(0, c.limit);
  const features = c.capabilities ? capabilityFeaturesOf(shown) : null;
  const label = (g) => {
    const f = features && features.get(g.server);
    return g.server + "（" + g.count + " 个工具）" + (f && f.length ? "：" + f.join("·") : "");
  };
  const parts = [
    "<mcp-tool-catalog>",
    "所有 MCP 工具的参数 schema 都没有常驻提示词，只用 mcp_hub_tools 一个工具分层展开：",
    "  1) mcp_hub_tools（不带参数）→ 服务器列表",
    "  2) mcp_hub_tools({ server: \"<服务器名>\" }) → 该服务器的工具名与摘要",
    "  3) mcp_hub_tools({ names: [\"<完整工具名>\"] }) → 完整参数，之后即可直接调用",
    "也可以用 mcp_hub_tools({ query: \"<关键词>\" }) 跨服务器检索。",
    "服务器：" + shown.map(label).join("、")
  ];
  if (groups.length > shown.length) {
    parts.push("（另有 " + (groups.length - shown.length) + " 个服务器未列出，用 mcp_hub_tools 查看）");
  }
  parts.push("</mcp-tool-catalog>");
  return parts.join("\n");
}

let hintIndexMemo = { signature: "", index: null };
function currentCapabilityIndex() {
  try {
    const servers = [];
    for (const s of cfg.servers) {
      if (s.enabled === false) continue;
      if (normalizeTier(s.budgetTier) === "off") continue;
      const tools = catalogTools(s).filter((t) => policyFor(s, t.name).enabled);
      if (!tools.length) continue;
      servers.push({
        server: sanitizeName(s.name, "mcp"),
        tools: tools.map((t) => ({ name: t.name, description: t.description || "", parameters: t.inputSchema || {} }))
      });
    }
    const sig = signatureOf(servers);
    if (hintIndexMemo.signature === sig && hintIndexMemo.index) return hintIndexMemo.index;
    const index = loadOrBuildIndex({ cacheFile: capabilityCachePath(), servers });
    hintIndexMemo = { signature: sig, index };
    return index;
  } catch {
    return { version: 1, signature: "", servers: [] };
  }
}

const HINT_SIGNAL_EVENTS = 24;

function lastTurnSignalText(agent) {
  try {
    const session = agent && agent.session;
    if (!session || typeof session.snapshotEvents !== "function") return "";
    const events = session.snapshotEvents() || [];
    const parts = [];
    let seen = 0;
    for (let i = events.length - 1; i >= 0 && seen < HINT_SIGNAL_EVENTS; i -= 1) {
      const ev = events[i];
      if (!ev || !ev.data) continue;
      if (ev.type === "user/message") {
        const src = ev.data.source;
        if (src && src.kind === "runtime-context") continue;
        parts.push(textOfMessage(ev.data));
        seen += 1;
      } else if (ev.type === "tool/result") {
        parts.push(textOfMessage(ev.data));
        seen += 1;
      }
    }
    return parts.join("\n").slice(-4000);
  } catch {
    return "";
  }
}

function textOfMessage(message) {
  try {
    const content = message && message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const out = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string") out.push(block.text);
      else if (block.input && typeof block.input === "object") out.push(JSON.stringify(block.input));
    }
    return out.join("\n");
  } catch {
    return "";
  }
}

let capabilityMemo = { signature: "", features: null };

function capabilityCachePath() {
  return join(storagesDir(), "capability-index.json");
}

const CATALOG_FEATURES_MAX = 5;

const CATALOG_FEATURES_MIN = 3;

function capabilityFeaturesOf(groups) {
  try {
    const servers = groups.map((g) => ({ server: g.server, tools: g.meta }));
    const sig = signatureOf(servers);
    if (capabilityMemo.signature === sig && capabilityMemo.features) return capabilityMemo.features;
    const index = loadOrBuildIndex({ cacheFile: capabilityCachePath(), servers });
    const map = new Map();
    for (const s of (index && index.servers) || []) {
      if (s && typeof s.server === "string") {
        const features = Array.isArray(s.features) ? s.features.slice(0, CATALOG_FEATURES_MAX) : [];
        map.set(s.server, features.length >= CATALOG_FEATURES_MIN ? features : []);
      }
    }
    capabilityMemo = { signature: sig, features: map };
    return map;
  } catch (e) {
    try {
      pluginCtx?.logger?.warn?.("mcp-hub: 能力摘要生成失败，本轮目录不含特征词：" + String((e && e.message) || e));
    } catch {}
    return null;
  }
}


function effectiveApproval(server) {
  const mode = server && server.approvalMode ? server.approvalMode : "inherit";
  const globalFollow = !cfg.approval || cfg.approval.followDsh !== false;
  if (mode === "follow") return { follow: true, source: "server" };
  if (mode === "manual") return { follow: false, source: "server" };
  if (!globalFollow) return { follow: false, source: "global" };
  return { follow: true, source: "global" };
}

function dshApprovalService() {
  const ctx = pluginCtx;
  if (!ctx) return null;
  try {
    const svc = ctx.get ? ctx.get("approval") : ctx.approval;
    return svc && typeof svc.request === "function" ? svc : null;
  } catch {
    return null;
  }
}

function dshEffectivePolicy(session) {
  const svc = dshApprovalService();
  if (!svc) return null;
  try {
    if (session && typeof svc.overrideOf === "function") {
      const override = svc.overrideOf(session);
      if (override) return override;
    }
    return (svc.config && svc.config.policy) || "ask";
  } catch {
    return null;
  }
}

const sessionGrants = new Map();

const traceLog = [];

const pendingAsks = new Map();

function grantKeyOf(session, serverName, tool) {
  const sid = session && typeof session.id === "string" ? session.id : "";
  return sid + "\u0000" + serverName + "\u0000" + String(tool || "");
}

function hasSessionGrant(session, serverName, tool) {
  if (!session) return false;
  return sessionGrants.has(grantKeyOf(session, serverName, tool));
}

function addSessionGrant(session, serverName, tool) {
  if (!session) return false;
  sessionGrants.set(grantKeyOf(session, serverName, tool), Date.now());
  return true;
}

function dropSessionGrants(session) {
  const sid = session && typeof session.id === "string" ? session.id : "";
  if (!sid) return 0;
  let removed = 0;
  const prefix = sid + "\u0000";
  for (const key of Array.from(sessionGrants.keys())) {
    if (key.startsWith(prefix)) {
      sessionGrants.delete(key);
      removed++;
    }
  }
  return removed;
}

function dropGrantsForServerName(serverName) {
  let removed = 0;
  for (const key of Array.from(sessionGrants.keys())) {
    if (key.split("\u0000")[1] === serverName) {
      sessionGrants.delete(key);
      removed++;
    }
  }
  return removed;
}

function listSessionGrants() {
  const out = [];
  for (const [key, at] of sessionGrants) {
    const parts = key.split("\u0000");
    out.push({ session: parts[0], server: parts[1], tool: parts[2] || "", at });
  }
  return out;
}

function dshApprovalState() {
  const ctx = pluginCtx;
  const out = {
    available: false,
    defaultPolicy: "",
    policy: "",
    presets: null,
    sessions: [],
    reason: ""
  };
  if (!ctx) {
    out.reason = "宿主上下文未就绪";
    return out;
  }
  const svc = dshApprovalService();
  if (!svc) {
    out.reason = "未组合 @deepseek-ai/dsh-user-approval：跟随模式下无法询问，只能按策略放行或拒绝";
    return out;
  }
  out.available = true;
  try {
    out.defaultPolicy = (svc.config && svc.config.policy) || "ask";
  } catch {
    out.defaultPolicy = "ask";
  }
  try {
    const store = ctx.get ? ctx.get("sessions") : ctx.sessions;
    const list = store && typeof store.list === "function" ? store.list() : [];
    for (const session of list) {
      const policy = dshEffectivePolicy(session) || out.defaultPolicy;
      const id = session && session.id ? String(session.id) : "";
      out.sessions.push({
        id,
        policy,
        grants: listSessionGrants().filter((g) => g.session === id)
      });
    }
  } catch {}
  out.policy = out.sessions.length ? out.sessions[0].policy : out.defaultPolicy;
  try {
    const presets = ctx.get ? ctx.get("permissionPresets") : ctx.permissionPresets;
    if (presets) {
      out.presets = {
        names: Array.isArray(presets.names) ? presets.names.slice() : [],
        default: typeof presets.defaultPreset === "string" ? presets.defaultPreset : "",
        current: (() => {
          try {
            const store = ctx.get ? ctx.get("sessions") : ctx.sessions;
            const list = store && typeof store.list === "function" ? store.list() : [];
            return list.length && typeof presets.current === "function" ? presets.current(list[0]) : "";
          } catch {
            return "";
          }
        })()
      };
    }
  } catch {}
  return out;
}

function listDays() {
  const out = [];
  try {
    mkdirSync(storagesDir(), { recursive: true });
    for (const f of readdirSync(storagesDir())) {
      const m = /^calls-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      const file = join(storagesDir(), f);
      let count = 0;
      try {
        const text = readFileSync(file, "utf8");
        count = text.split("\n").filter(Boolean).length;
      } catch {}
      out.push({ day: m[1], count, bytes: statSync(file).size });
    }
  } catch {}
  out.sort((a, b) => (a.day < b.day ? 1 : -1));
  return out;
}

function readDayAll(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return [];
  try {
    const text = readFileSync(dayFile(day), "utf8");
    return text.split("\n").filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean).slice(-2000);
  } catch {
    return [];
  }
}

function serverKeyOf(rec) {
  return sanitizeName(rec && rec.server, "unassigned");
}

function readDay(day, serverName) {
  const all = readDayAll(day);
  const filtered = serverName ? all.filter((r) => serverKeyOf(r) === serverName) : all;
  return filtered.slice(-500).reverse();
}

function listServersWithLogs() {
  const counts = new Map();
  for (const item of listDays()) {
    for (const rec of readDayAll(item.day)) {
      const key = serverKeyOf(rec);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const out = [];
  const seen = new Set();
  for (const s of cfg.servers) {
    const key = sanitizeName(s.name, "mcp");
    seen.add(key);
    out.push({ name: key, id: s.id, count: counts.get(key) || 0, configured: true });
  }
  for (const [key, count] of counts) {
    if (!seen.has(key)) out.push({ name: key, id: "", count, configured: false });
  }
  out.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  return out;
}

function listDaysFor(serverName) {
  const out = [];
  for (const item of listDays()) {
    const recs = readDayAll(item.day);
    const matched = serverName ? recs.filter((r) => serverKeyOf(r) === serverName) : recs;
    if (!matched.length) continue;
    out.push({ day: item.day, count: matched.length, bytes: item.bytes });
  }
  return out;
}

function clearRecords(day) {
  let removed = 0;
  try {
    mkdirSync(storagesDir(), { recursive: true });
    if (day) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(day)) && existsSync(dayFile(day))) {
        rmSync(dayFile(day), { force: true });
        removed = 1;
      }
      return removed;
    }
    for (const f of readdirSync(storagesDir())) {
      if (/^calls-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) {
        rmSync(join(storagesDir(), f), { force: true });
        removed++;
      }
    }
  } catch {}
  return removed;
}


function underTempDir(p) {
  const t = resolve(tmpdir());
  const r = resolve(p);
  return r === t || r.startsWith(t + sep);
}

function patchFilePath() {
  const override = process.env.DSH_MCP_HUB_PATCH_FILE;
  if (override && override.trim()) return override;
  if (underTempDir(dshHome())) return join(dshHome(), "cordis.patch.yml");
  return join(PLUGIN_ROOT, "cordis.patch.yml");
}

function patchHeader() {
  return [
    "# dsh-mcp-hub bundle patch",
    "# 由面板按当前服务器列表生成：每个启用的服务器一条 insert",
    "- insert:",
    "    - id: mcp-hub",
    "      name: '@dsh-external/dsh-mcp-hub'"
  ].join("\n") + "\n";
}

function yamlQuote(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function oneBridge(server) {
  const safe = sanitizeName(server.name, "mcp");
  const lines = [];
  lines.push("    - id: mcp-hub-" + safe);
  lines.push("      name: '@deepseek-ai/dsh-mcp-client'");
  lines.push("      config:");
  lines.push("        serverName: " + safe);
  lines.push("        transport: " + server.transport);
  if (server.transport === "stdio") {
    lines.push("        command: " + yamlQuote(server.command));
    lines.push("        args:");
    for (const a of server.args) lines.push("          - " + yamlQuote(a));
    const envKeys = Object.keys(server.env || {});
    if (envKeys.length) {
      lines.push("        env:");
      for (const k of envKeys) lines.push("          " + k + ": " + yamlQuote(server.env[k]));
    }
  } else {
    lines.push("        url: " + yamlQuote(server.url));
    if (server.token && server.token !== "none") {
      lines.push("        headers:");
      lines.push("          Authorization: " + yamlQuote("Bearer " + server.token));
    }
  }
  lines.push("        toolCallTimeoutMs: " + (server.toolCallTimeoutMs || 60000));
  lines.push("        failOnStartupError: false");
  lines.push("        reconnect:");
  lines.push("          enabled: " + (server.autoReconnect !== false));
  lines.push("          initialDelayMs: 500");
  lines.push("          maxDelayMs: 30000");
  lines.push("          maxAttempts: 10");
  return lines.join("\n");
}

function bridgeBlock() {
  const active = cfg.servers.filter((s) => s.enabled !== false);
  if (!active.length) return "";
  return active.map(oneBridge).join("\n");
}

function findBridgeInPatch(raw) {
  const idx = raw.indexOf("- id: mcp-hub-");
  if (idx < 0) return null;
  const start = raw.lastIndexOf("\n", idx) + 1;
  const lines = raw.split("\n");
  let startLine = 0;
  let consumed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    consumed += lines[i].length + 1;
    if (consumed > start) {
      startLine = i;
      break;
    }
  }
  const isBridgeLine = (i) => {
    const line = lines[i] || "";
    if (!/^\s*- id: mcp-hub-/.test(line)) return false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (/^\s*$/.test(next)) continue;
      return /^\s+name:\s*'@deepseek-ai\/dsh-mcp-client'/.test(next);
    }
    return false;
  };
  const isItemStart = (i) => /^\s*- (id|name|insert|disabled):/.test(lines[i] || "");
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i += 1) {
    if (isItemStart(i)) {
      if (isBridgeLine(i)) continue;
      endLine = i;
      break;
    }
  }
  let end = 0;
  for (let i = 0; i < endLine; i += 1) end += lines[i].length + 1;
  if (end > raw.length) end = raw.length;
  return { start, end };
}

function importStatus() {
  const file = patchFilePath();
  let present = false;
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
    present = findBridgeInPatch(raw) != null;
  } catch {}
  return {
    patchPath: file,
    cordisPath: file,
    exists: existsSync(file),
    imported: present,
    block: bridgeBlock()
  };
}

function writePatchText(file, text) {
  if (existsSync(file)) {
    try {
      renameSync(file, file + ".bak-" + Date.now());
    } catch {}
  }
  writeFileSync(file, text.endsWith("\n") ? text : text + "\n", "utf8");
  restrictToOwner(file);
  try {
    const dir = dirname(file);
    const baks = readdirSync(dir)
      .filter((n) => n.startsWith("cordis.patch.yml.bak-"))
      .sort();
    while (baks.length > 5) {
      try {
        rmSync(join(dir, baks.shift()), { force: true });
      } catch {}
    }
  } catch {}
}

function syncBridgeIfPresent() {
  const file = patchFilePath();
  let raw = "";
  try {
    raw = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    return { ok: false, changed: false, reason: "读取补丁失败" };
  }
  const existing = findBridgeInPatch(raw);
  if (!existing) return { ok: true, changed: false, reason: "补丁里没有桥接区，未改动" };
  const block = bridgeBlock();
  const next = block
    ? raw.slice(0, existing.start) + block + "\n" + raw.slice(existing.end)
    : (() => {
        const head = raw.slice(0, existing.start).replace(/\s+$/, "");
        const tail = raw.slice(existing.end);
        const body = [head, tail.trim()].filter((x) => x !== "").join("\n");
        return body ? body + "\n" : patchHeader();
      })();
  try {
    writePatchText(file, next);
    return { ok: true, changed: true, reason: block ? "已按当前启用列表重写桥接区" : "已清空桥接区" };
  } catch (e) {
    return { ok: false, changed: false, reason: String((e && e.message) || e) };
  }
}

function applyImport(mode) {
  const file = patchFilePath();
  let raw = "";
  try {
    raw = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    raw = "";
  }
  const existing = findBridgeInPatch(raw);
  const block = bridgeBlock();
  if (mode === "remove") {
    if (!existing) return { ok: true, changed: false, file };
    const head = raw.slice(0, existing.start).replace(/\s+$/, "");
    const tail = raw.slice(existing.end);
    const body = [head, tail.trim()].filter((x) => x !== "").join("\n");
    writePatchText(file, body ? body + "\n" : patchHeader());
    return { ok: true, changed: true, file };
  }
  if (!block) {
    return { ok: false, changed: false, file, error: "没有启用的服务器，未写入任何桥接条目" };
  }
  let next;
  if (existing) {
    next = raw.slice(0, existing.start) + block + "\n" + raw.slice(existing.end);
  } else {
    const base = raw.trim() ? raw.replace(/\s+$/, "") + "\n" : patchHeader();
    next = base + block + "\n";
  }
  writePatchText(file, next);
  return { ok: true, changed: true, file };
}


const BACKUP_KIND = "dsh-mcp-hub/backup";
const BACKUP_VERSION = 1;

function buildBackup() {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    profile: cfg.profile,
    approval: normalizeApproval(cfg.approval),
    gateway: normalizeGateway(cfg.gateway),
    catalog: normalizeCatalog(cfg.catalog),
    hint: normalizeHint(cfg.hint),
    servers: cfg.servers.map((s) => normalizeServer(JSON.parse(JSON.stringify(s)))),
    patch: (() => {
      try {
        return existsSync(patchFilePath()) ? readFileSync(patchFilePath(), "utf8") : "";
      } catch {
        return "";
      }
    })()
  };
}

function validateBackup(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "备份必须是 JSON 对象" };
  if (raw.kind !== BACKUP_KIND) return { ok: false, error: "不是本插件的备份文件（kind 应为 " + BACKUP_KIND + "）" };
  if (Number(raw.version) !== BACKUP_VERSION) return { ok: false, error: "备份版本不支持：" + String(raw.version) + "，当前仅支持 " + BACKUP_VERSION };
  const servers = Array.isArray(raw.servers) ? raw.servers : [];
  if (!servers.length) return { ok: false, error: "备份里没有任何服务器" };
  const names = servers.map((s) => sanitizeName(s && s.name, "mcp"));
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return { ok: false, error: "备份里有重名服务器：" + dup };
  return { ok: true, servers, approval: raw.approval, gateway: raw.gateway, catalog: raw.catalog, hint: raw.hint, patch: typeof raw.patch === "string" ? raw.patch : "" };
}

function restoreBackup(raw, mode) {
  const v = validateBackup(raw);
  if (!v.ok) return v;
  const replaced = mode === "replace";
  const incoming = v.servers.map((s) => normalizeServer(s));
  if (replaced) {
    cfg.servers = [];
    conns.clear();
  }
  if (v.approval && typeof v.approval === "object") {
    cfg.approval = normalizeApproval(v.approval);
  } else if (replaced) {
    cfg.approval = normalizeApproval();
  }
  if (v.gateway && typeof v.gateway === "object") {
    cfg.gateway = normalizeGateway(v.gateway);
  } else if (replaced) {
    cfg.gateway = normalizeGateway();
  }
  if (v.catalog && typeof v.catalog === "object") {
    cfg.catalog = normalizeCatalog(v.catalog);
  } else if (replaced) {
    cfg.catalog = normalizeCatalog();
  }
  if (v.hint && typeof v.hint === "object") {
    cfg.hint = normalizeHint(v.hint);
  } else if (replaced) {
    cfg.hint = normalizeHint();
  }
  const seen = new Set(cfg.servers.map((s) => s.id));
  let added = 0;
  let updated = 0;
  for (const s of incoming) {
    if (!seen.has(s.id) && cfg.servers.some((x) => x.name === s.name)) {
      const idx = cfg.servers.findIndex((x) => x.name === s.name);
      cfg.servers[idx] = s;
      updated++;
      continue;
    }
    const idx = cfg.servers.findIndex((x) => x.id === s.id);
    if (idx >= 0) {
      cfg.servers[idx] = s;
      updated++;
    } else {
      cfg.servers.push(s);
      seen.add(s.id);
      added++;
    }
  }
  persist();
  let patchWritten = false;
  if (v.patch && v.patch.trim()) {
    try {
      writePatchText(patchFilePath(), v.patch);
      patchWritten = true;
    } catch {}
  }
  const patched = syncBridgeIfPresent();
  return { ok: true, mode: replaced ? "replace" : "merge", added, updated, total: cfg.servers.length, patchWritten, patch: patched };
}


function allProfileDirs() {
  try {
    const base = join(dshHome(), "profiles");
    if (!existsSync(base)) return [];
    return readdirSync(base).filter((n) => {
      try {
        return statSync(join(base, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function cordisFilesOf(profile) {
  const dir = join(dshHome(), "profiles", profile);
  const out = [];
  const push = (f) => {
    if (existsSync(f) && out.every((x) => x !== f)) out.push(f);
  };
  try {
    for (const n of readdirSync(dir)) {
      if (/^cordis.*\.(yml|yaml)$/.test(n) && !/\.bak-/.test(n)) push(join(dir, n));
    }
  } catch {}
  const nm = join(dir, "node_modules");
  try {
    for (const scope of readdirSync(nm)) {
      if (!scope.startsWith("@")) continue;
      for (const pkg of readdirSync(join(nm, scope))) {
        push(join(nm, scope, pkg, "cordis.patch.yml"));
      }
    }
  } catch {}
  return out;
}

function scanLocalServers() {
  const found = [];
  const seen = new Set();
  for (const profile of allProfileDirs()) {
    for (const file of cordisFilesOf(profile)) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const blocks = text.split(/\n(?=\s*-\s+id:)/);
      for (const block of blocks) {
        if (!/dsh-mcp-client/.test(block)) continue;
        const serverName = (/serverName:\s*['"]?([A-Za-z0-9_-]+)/.exec(block) || [])[1];
        if (!serverName || seen.has(serverName)) continue;
        const transport = (/transport:\s*['"]?([a-z-]+)/.exec(block) || [])[1] || "";
        const url = (/url:\s*['"]?([^'"\s]+)/.exec(block) || [])[1] || "";
        const command = (/command:\s*['"]?([^'"\n]+)['"]?\s*$/m.exec(block) || [])[1] || "";
        const bearer = /Authorization:\s*['"]?Bearer\s+([^'"\s]+)/.exec(block);
        const isStdio = transport === "stdio" || (!url && !!command);
        if (!isStdio && !url) continue;
        seen.add(serverName);
        found.push({
          serverName,
          transport: isStdio ? "stdio" : "streamable-http",
          url: url,
          command: isStdio ? command.trim() : "",
          token: bearer ? bearer[1] : "",
          hasToken: !!bearer,
          profile,
          file
        });
      }
    }
  }
  return found;
}

export function apply(ctx) {
  const webServer = ctx.webServer;
  pluginCtx = ctx;
  registryService(ctx);
  if (!webServer || typeof webServer.register !== "function") return;

  const disposers = [];
  const json = (res, code, body) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const route = (path, handler) => {
    disposers.push(
      webServer.register({
        method: "GET",
        path,
        async handler(req, res) {
          try {
            await handler(req, res);
          } catch (e) {
            json(res, 500, { ok: false, error: String((e && e.message) || e) });
          }
        }
      })
    );
  };

  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);
  function hostOnly(hostHeader) {
    const h = String(hostHeader || "").trim().toLowerCase();
    if (!h) return "";
    if (h.startsWith("[")) {
      const end = h.indexOf("]");
      return end > 0 ? h.slice(0, end + 1) : h;
    }
    const colon = h.indexOf(":");
    return colon < 0 ? h : h.slice(0, colon);
  }
  function isCredentialSafeRequest(req) {
    try {
      const headers = (req && req.headers) || {};
      const origin = String(headers.origin || headers.Origin || "");
      const site = String(headers["sec-fetch-site"] || headers["Sec-Fetch-Site"] || "");
      const host = hostOnly(headers.host || headers.Host || "");
      if (!loopbackHosts.has(host)) return false;
      if (site && site !== "same-origin" && site !== "none") return false;
      if (!origin) return !site;
      let originHost = "";
      try {
        originHost = new URL(origin).hostname.toLowerCase();
      } catch {
        return false;
      }
      return loopbackHosts.has(originHost);
    } catch {
      return false;
    }
  }
  const denyCredentialed = (res) => {
    json(res, 403, { ok: false, error: "本接口会返回凭证，只接受本机同源请求；请从本机面板访问。" });
  };

  const statusOf = (server) => {
    const c = connFor(server);
    const managed = managedTools(server);
    return {
      managed: server.transport === "stdio" || managed.length > 0,
      managedToolCount: managed.length,
      id: server.id,
      ok: true,
      status: c.status,
      transport: server.transport,
      url: server.url,
      command: server.command,
      args: server.args,
      tokenConfigured: !!(server.token && server.token !== "none"),
      tokenUnreadable: !!(server.__tokenUnreadable),
      tokenAppliedTo: patchFilePath(),
      autoReconnect: server.autoReconnect,
      enabled: server.enabled !== false,
      approvalMode: normalizeApprovalMode(server.approvalMode),
      approvalEffective: effectiveApproval(server),
      budgetTier: normalizeTier(server.budgetTier),
      serverName: sanitizeName(server.name, "mcp"),
      toolCallTimeoutMs: server.toolCallTimeoutMs,
      tools: server.tools || {},
      latencyMs: c.latencyMs,
      server: c.server,
      toolCount: managed.length || c.tools.length,
      dialToolCount: c.tools.length,
      visibleToolCount: managed.length,
      registryMissing: c.status === "connected" && managed.length === 0 && c.tools.length > 0,
      toolsAt: c.toolsAt,
      lastConnectedAt: c.lastConnectedAt,
      lastError: c.lastError,
      attempt: c.attempt,
      nextRetryAt: c.nextRetryAt
    };
  };

  const editableOf = (server) =>
    Object.assign({}, statusOf(server), {
      _token: server.__tokenUnreadable ? "" : server.token && server.token !== "none" ? server.token : "",
      env: server.env,
      _id: server.id,
      _name: server.name
    });
  const configPayload = (extra, view) =>
    Object.assign({ ok: true, profile: cfg.profile, approval: normalizeApproval(cfg.approval), servers: cfg.servers.map(view || editableOf) }, extra || {});
  const statusPayload = (server) => Object.assign({ ok: true, profile: cfg.profile, approval: normalizeApproval(cfg.approval), servers: cfg.servers.map(statusOf) }, server ? statusOf(server) : {});

  const guardOff = (exec) => {
    try {
      if (!serverByToolName(exec && exec.name)) return undefined;
      const reason = blockReason(exec.name);
      return reason ? "MCP（mcp-hub）：" + reason : undefined;
    } catch {
      return undefined;
    }
  };
  if (ctx.tools && typeof ctx.tools.guard === "function") disposers.push(ctx.tools.guard(guardOff));

  const gateway = createGateway({
    hiddenReason,
    blockReason,
    registry: () => registryService(pluginCtx || ctx),
    settings: () => cfg.gateway,
    inactiveServers: () => {
      const out = [];
      for (const s of cfg.servers) {
        if (s.enabled === false) continue;
        if (normalizeTier(s.budgetTier) === "off") continue;
        if (catalogTools(s).length) continue;
        const conn = connFor(s);
        out.push({
          server: sanitizeName(s.name, "mcp"),
          reason: conn.lastError || conn.status || "未连接"
        });
      }
      return out;
    },
    log: (m) => {
      try {
        pluginCtx?.logger?.warn?.(m);
      } catch {}
    }
  });
  try {
    disposers.push(gateway.install(ctx));
  } catch (e) {
    try {
      pluginCtx?.logger?.warn?.("mcp-hub: 上下文预算网关安装失败，退回全量 schema：" + String((e && e.message) || e));
    } catch {}
  }

  try {
    if (ctx.inject && typeof ctx.inject === "function") {
      ctx.inject(["systemPrompt"], (c) => {
        try {
          const off = c.systemPrompt.section({
            name: "mcp-hub:tool-catalog",
            order: 3110,
            interpolate: false,
            text: () => catalogText()
          });
          if (typeof off === "function") disposers.push(off);
        } catch (e) {
          pluginCtx?.logger?.warn?.("mcp-hub: 目录 section 注册失败：" + String((e && e.message) || e));
        }
      });
    }
  } catch (e) {
    pluginCtx?.logger?.warn?.("mcp-hub: systemPrompt 服务不可用，跳过工具目录");
  }

  const hinter = createJitHinter({
    index: () => currentCapabilityIndex(),
    maxTotal: () => normalizeHint(cfg.hint).maxTotal,
    maxPerServer: () => normalizeHint(cfg.hint).maxPerServer
  });
  const hintUsed = new Map();
  const usedServersOf = (sessionId) => hintUsed.get(String(sessionId || "")) || [];
  const markServerUsed = (sessionId, serverName) => {
    const key = String(sessionId || "");
    const list = hintUsed.get(key) || [];
    if (!list.includes(serverName)) {
      list.push(serverName);
      hintUsed.set(key, list);
    }
  };
  try {
    if (ctx.inject && typeof ctx.inject === "function") {
      ctx.inject(["systemPrompt"], (c) => {
        try {
          const off = c.systemPrompt.context({
            name: "mcp-hub:jit-hint",
            order: 120,
            text: (assemblyCtx) => {
              const h = normalizeHint(cfg.hint);
              if (!h.enabled) return "";
              try {
                const agent = assemblyCtx && assemblyCtx.agent;
                const sessionId = agent && agent.session && agent.session.id;
                const text = lastTurnSignalText(agent);
                if (!text) return "";
                return hinter.hintFor({
                  sessionId,
                  text,
                  usedServers: usedServersOf(sessionId)
                }) || "";
              } catch {
                return "";
              }
            }
          });
          if (typeof off === "function") disposers.push(off);
        } catch (e) {
          pluginCtx?.logger?.warn?.("mcp-hub: JIT 提示 context 注册失败：" + String((e && e.message) || e));
        }
      });
    }
  } catch (e) {
    pluginCtx?.logger?.warn?.("mcp-hub: systemPrompt 服务不可用，跳过 JIT 提示");
  }

  const executeManaged = async (server, tool, args) => {
    if (!toolsRegistry || typeof toolsRegistry.execute !== "function") {
      throw new Error("ctx.tools 注册表不可用");
    }
    const fullName = toolPrefix(server.name) + tool;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), server.toolCallTimeoutMs || 60000);
    if (typeof timer.unref === "function") timer.unref();
    try {
      const result = await toolsRegistry.execute({
        callId: "mcp-hub:" + Date.now().toString(36) + ":" + Math.random().toString(36).slice(2, 7),
        name: fullName,
        arguments: args,
        parent: "mcp-hub-panel",
        signal: controller.signal
      });
      return { isError: !!result.isError, text: resultText(result).slice(0, 20000), error: result.isError ? resultText(result).slice(0, 500) : "" };
    } finally {
      clearTimeout(timer);
    }
  };

  route(BASE + "/status", async (req, res) => {
    json(res, 200, statusPayload());
  });

  route(BASE + "/servers", async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const url = new URL(req.url || BASE + "/servers", "http://127.0.0.1");
    const id = url.searchParams.get("id") || "";
    const withSecrets = isCredentialSafeRequest(req);
    const viewOf = withSecrets ? editableOf : statusOf;
    if (method === "DELETE") {
      if (!id) {
        json(res, 400, { ok: false, error: "缺少 id" });
        return;
      }
      const removed = removeServer(id);
      const patched = syncBridgeIfPresent();
      json(res, 200, { ok: removed, removed, patch: patched, servers: cfg.servers.map(viewOf) });
      return;
    }
    if (method === "POST" || method === "PUT") {
      const body = await readBody(req);
      if (typeof body.profile === "string") {
        cfg.profile = body.profile.trim();
        persist();
      }
      try {
        const saved = upsertServer(body.server || body);
        const c = connFor(saved);
        c.attempt = 0;
        c.nextRetryAt = 0;
        if (saved.enabled !== false) void reconnectNow(saved);
        const patched = syncBridgeIfPresent();
        if (lastPersistError) {
          json(res, 500, { ok: false, error: "写入配置文件失败：" + String((lastPersistError && lastPersistError.message) || lastPersistError), server: viewOf(saved), servers: cfg.servers.map(viewOf) });
          return;
        }
        json(res, 200, { ok: true, server: viewOf(saved), patch: patched, servers: cfg.servers.map(viewOf) });
      } catch (e) {
        json(res, 400, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    json(res, 200, configPayload({ credentialVisible: withSecrets }, viewOf));
  });

  const resolve = (req) => {
    const url = new URL(req.url || BASE, "http://127.0.0.1");
    return findServer(url.searchParams.get("server") || "");
  };

  route(BASE + "/test", async (req, res) => {
    const server = resolve(req);
    if (!server) {
      json(res, 404, { ok: false, error: "服务器不存在" });
      return;
    }
    const t0 = Date.now();
    const r = await reconnectNow(server);
    const c = connFor(server);
    const managed = managedTools(server);
    json(res, 200, {
      ok: !!r,
      id: server.id,
      managed: usesRegistry(server),
      latencyMs: c.latencyMs,
      totalMs: Date.now() - t0,
      server: c.server,
      toolCount: managed.length || c.tools.length,
      tools: (managed.length ? managed : c.tools).map((t) => t.name),
      error: c.lastError || undefined
    });
  });

  route(BASE + "/reconnect", async (req, res) => {
    const server = resolve(req);
    if (!server) {
      json(res, 404, { ok: false, error: "服务器不存在" });
      return;
    }
    const c = connFor(server);
    c.attempt = 0;
    c.nextRetryAt = 0;
    const r = await reconnectNow(server);
    json(res, 200, { ok: !!r, id: server.id, status: c.status, error: c.lastError || undefined, toolCount: c.tools.length });
  });

  route(BASE + "/tools", async (req, res) => {
    const server = resolve(req);
    if (!server) {
      json(res, 404, { ok: false, error: "服务器不存在" });
      return;
    }
    const url = new URL(req.url || BASE + "/tools", "http://127.0.0.1");
    const fresh = url.searchParams.get("fresh") === "1";
    const c = connFor(server);
    let source = "dial";
    let raw = managedTools(server);
    if (raw.length) {
      source = "registry";
    } else {
      if (fresh || !c.tools.length) await ensureTools(server);
      raw = c.tools;
    }
    const list = raw.map((t) => {
      const p = policyFor(server, t.name);
      return {
        name: t.name,
        description: t.description || "",
        inputSchema: t.inputSchema || {},
        enabled: p.enabled,
        approval: p.approval,
        effective: effectiveApproval(server)
      };
    });
    json(res, 200, Object.assign(statusPayload(server), { ok: true, source, tools: list }));
  });

  route(BASE + "/tool-policy", async (req, res) => {
    const body = await readBody(req);
    const server = findServer(body.server || "");
    if (!server) {
      json(res, 404, { ok: false, error: "服务器不存在" });
      return;
    }
    const c = connFor(server);
    const registryTools = managedTools(server);
    const names = Array.isArray(body.names) && body.names.length
      ? body.names.map(String)
      : (registryTools.length ? registryTools : c.tools).map((t) => t.name);
    for (const toolName of names) {
      const cur = server.tools[toolName] || {};
      const next = Object.assign({}, cur);
      if (typeof body.enabled === "boolean") next.enabled = body.enabled;
      if (typeof body.approval === "boolean") next.approval = body.approval;
      server.tools[toolName] = next;
    }
    persist();
    json(res, 200, { ok: true, id: server.id, updated: names.length });
  });

  const approvalPayload = () => ({
    ok: true,
    approval: normalizeApproval(cfg.approval),
    servers: cfg.servers.map((s) => ({
      id: s.id,
      name: sanitizeName(s.name, "mcp"),
      approvalMode: normalizeApprovalMode(s.approvalMode),
      effective: effectiveApproval(s)
    })),
    grants: listSessionGrants(),
    trace: traceLog.slice(-10),
    dsh: dshApprovalState()
  });

  route(BASE + "/approval", async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    if (method === "GET") {
      json(res, 200, approvalPayload());
      return;
    }
    const body = await readBody(req);
    if (body.action === "revoke-grants") {
      const removed = sessionGrants.size;
      sessionGrants.clear();
      json(res, 200, Object.assign({ ok: true, removed }, approvalPayload()));
      return;
    }
    if (body.action === "grant") {
      const sessionId = String(body.session || "").trim();
      const toolName = String(body.toolName || "").trim();
      if (!sessionId || !toolName) {
        json(res, 400, { ok: false, error: "缺少 session 或 toolName" });
        return;
      }
      const server = serverByToolName(toolName);
      if (!server) {
        json(res, 400, { ok: false, error: "不是本插件管理的 MCP 工具：" + toolName });
        return;
      }
      const tool = toolName.slice(toolPrefix(server.name).length);
      const session = { id: sessionId };
      addSessionGrant(session, sanitizeName(server.name, "mcp"), tool);
      json(res, 200, Object.assign({ ok: true, granted: { session: sessionId, server: sanitizeName(server.name, "mcp"), tool } }, approvalPayload()));
      return;
    }
    if (body.action === "trace") {
      traceLog.push({ at: Date.now(), ...body });
      if (traceLog.length > 20) traceLog.shift();
      json(res, 200, { ok: true });
      return;
    }
    if (typeof body.followDsh === "boolean") {
      cfg.approval = normalizeApproval({ followDsh: body.followDsh });
    }
    const target = body.server ? findServer(body.server) : null;
    if (body.server && !target) {
      json(res, 404, { ok: false, error: "服务器不存在" });
      return;
    }
    if (target && body.approvalMode !== undefined) {
      target.approvalMode = normalizeApprovalMode(body.approvalMode);
    }
    if (body.approvalMode !== undefined && !body.server) {
      const mode = normalizeApprovalMode(body.approvalMode);
      for (const s of cfg.servers) s.approvalMode = mode;
    }
    persist();
    json(res, 200, approvalPayload());
  });

  route(BASE + "/budget", async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const budgetPayload = () => ({
      ok: true,
      bridgeTool: gateway.BRIDGE_TOOL_NAME,
      tiers: ["full", "lazy", "off"],
      servers: cfg.servers.map((s) => ({
        id: s.id,
        name: sanitizeName(s.name, "mcp"),
        enabled: s.enabled !== false,
        tier: normalizeTier(s.budgetTier),
        hidden: usesRegistry(s) ? managedTools(s).filter((t) => hiddenReason(toolPrefix(s.name) + t.name)).length : 0,
        total: usesRegistry(s) ? managedTools(s).length : 0
      }))
    });
    if (method === "GET") {
      json(res, 200, budgetPayload());
      return;
    }
    const body = await readBody(req);
    const target = body.server ? findServer(body.server) : null;
    if (body.server && !target) {
      json(res, 404, { ok: false, error: "服务器不存在" });
      return;
    }
    const tier = normalizeTier(body.tier);
    if (!["full", "lazy", "off"].includes(body.tier)) {
      json(res, 400, { ok: false, error: "tier 只能是 full / lazy / off" });
      return;
    }
    if (target) target.budgetTier = tier;
    else for (const s of cfg.servers) s.budgetTier = tier;
    persist();
    json(res, 200, Object.assign(budgetPayload(), { updated: target ? target.id : "all", tier }));
  });

  const catalogState = () => {
    const text = catalogText();
    return Object.assign({}, normalizeCatalog(cfg.catalog), {
      preview: { text, bytes: Buffer.byteLength(text) }
    });
  };
  route(BASE + "/gateway", async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const gatewayPayload = () => Object.assign(
      { ok: true, defaults: GATEWAY_DEFAULTS, hintDefaults: HINT_DEFAULTS },
      normalizeGateway(cfg.gateway),
      { catalog: catalogState(), hint: normalizeHint(cfg.hint) }
    );
    if (method === "GET") {
      json(res, 200, gatewayPayload());
      return;
    }
    const body = await readBody(req);
    cfg.gateway = normalizeGateway(Object.assign({}, GATEWAY_DEFAULTS, cfg.gateway, body));
    if (body.catalog !== undefined) {
      cfg.catalog = normalizeCatalog(Object.assign({}, cfg.catalog, body.catalog));
    }
    if (body.hint !== undefined) {
      cfg.hint = normalizeHint(Object.assign({}, cfg.hint, body.hint));
    }
    persist();
    if (lastPersistError) {
      json(res, 500, { ok: false, error: "写入配置文件失败：" + String((lastPersistError && lastPersistError.message) || lastPersistError), gateway: normalizeGateway(cfg.gateway) });
      return;
    }
    json(res, 200, gatewayPayload());
  });

  route(BASE + "/invoke", async (req, res) => {
    const body = await readBody(req);
    const server = findServer(body.server || "");
    if (!server) {
      json(res, 404, { ok: false, error: "服务器不存在" });
      return;
    }
    const tool = String(body.tool || "").trim();
    if (!tool) {
      json(res, 400, { ok: false, error: "缺少 tool" });
      return;
    }
    const args = body.arguments && typeof body.arguments === "object" ? body.arguments : {};
    const t0 = Date.now();
    if (server.transport === "stdio" || managedTools(server).length) {
      try {
        const managed = await executeManaged(server, tool, args);
        const ms = Date.now() - t0;
        appendRecord({
          ts: new Date().toISOString(),
          t: Date.now(),
          server: sanitizeName(server.name, "mcp"),
          source: "debug",
          tool,
          decision: "debug",
          ok: !managed.isError,
          ms,
          args,
          error: managed.error
        });
        json(res, 200, { ok: !managed.isError, ms, isError: managed.isError, via: "registry", text: managed.text, error: managed.isError ? managed.text : undefined });
      } catch (e) {
        const ms = Date.now() - t0;
        appendRecord({
          ts: new Date().toISOString(),
          t: Date.now(),
          server: sanitizeName(server.name, "mcp"),
          source: "debug",
          tool,
          decision: "debug",
          ok: false,
          ms,
          args,
          error: String((e && e.message) || e).slice(0, 500)
        });
        json(res, 200, { ok: false, ms, error: String((e && e.message) || e) });
      }
      return;
    }
    try {
      const result = await rpc(server, "tools/call", { name: tool, arguments: args }, 70000);
      const ms = Date.now() - t0;
      appendRecord({
        ts: new Date().toISOString(),
        t: Date.now(),
        server: sanitizeName(server.name, "mcp"),
        source: "debug",
        tool,
        decision: "debug",
        ok: !result.isError,
        ms,
        args,
        error: result.isError ? resultText(result).slice(0, 500) : ""
      });
      json(res, 200, { ok: true, ms, isError: !!result.isError, text: resultText(result).slice(0, 20000) });
    } catch (e) {
      const ms = Date.now() - t0;
      appendRecord({
        ts: new Date().toISOString(),
        t: Date.now(),
        server: sanitizeName(server.name, "mcp"),
        source: "debug",
        tool,
        decision: "debug",
        ok: false,
        ms,
        args,
        error: String((e && e.message) || e).slice(0, 500)
      });
      json(res, 200, { ok: false, ms, error: String((e && e.message) || e) });
    }
  });

  route(BASE + "/backup", async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    if (!isCredentialSafeRequest(req)) {
      denyCredentialed(res);
      return;
    }
    if (method === "POST" || method === "PUT") {
      const body = await readBody(req);
      const result = restoreBackup(body.backup || body, body.mode === "replace" ? "replace" : "merge");
      if (!result.ok) {
        json(res, 400, result);
        return;
      }
      for (const s of cfg.servers) {
        const c = connFor(s);
        c.attempt = 0;
        c.nextRetryAt = 0;
      }
      json(res, 200, Object.assign({ ok: true }, result, { servers: cfg.servers.map(statusOf) }));
      return;
    }
    json(res, 200, Object.assign({ ok: true }, buildBackup(), { import: importStatus() }));
  });

  route(BASE + "/local", async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    if (method === "POST" || method === "PUT") {
      const body = await readBody(req);
      const name = sanitizeName(body.serverName, "");
      if (!name) {
        json(res, 400, { ok: false, error: "缺少 serverName" });
        return;
      }
      const discovered = scanLocalServers().find((s) => s.serverName === name);
      if (!discovered) {
        json(res, 404, { ok: false, error: "未在 cordis 配置中找到该服务器：" + name });
        return;
      }
      const existing = cfg.servers.find((s) => s.name === name);
      const adopted = {
        name,
        transport: discovered.transport,
        url: discovered.url,
        command: discovered.command,
        enabled: true
      };
      if (discovered.token) adopted.token = discovered.token;
      const saved = upsertServer(Object.assign({}, existing || {}, adopted));
      json(res, 200, { ok: true, id: saved.id, adopted: name, server: editableOf(saved), servers: cfg.servers.map(editableOf) });
      return;
    }
    const list = scanLocalServers().map((s) => Object.assign({}, s, {
      adopted: cfg.servers.some((x) => x.name === s.serverName)
    }));
    json(res, 200, { ok: true, profile: cfg.profile, servers: list });
  });

  route(BASE + "/records", async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const url = new URL(req.url || BASE + "/records", "http://127.0.0.1");
    const day = url.searchParams.get("day") || "";
    const serverName = url.searchParams.get("name") || "";
    if (method === "DELETE") {
      const removed = clearRecords(day);
      json(res, 200, { ok: true, removed });
      return;
    }
    if (day) {
      json(res, 200, { ok: true, day, name: serverName, records: readDay(day, serverName) });
      return;
    }
    json(res, 200, {
      ok: true,
      servers: listServersWithLogs(),
      days: listDaysFor(serverName),
      storageDir: storagesDir()
    });
  });

  route(BASE + "/import", async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    if (!isCredentialSafeRequest(req)) {
      denyCredentialed(res);
      return;
    }
    if (method === "GET") {
      json(res, 200, Object.assign({ ok: true }, importStatus()));
      return;
    }
    const body = await readBody(req);
    const mode = body.mode === "remove" ? "remove" : "add";
    const result = applyImport(mode);
    if (!result.ok) {
      json(res, 400, Object.assign({ ok: false }, result, importStatus()));
      return;
    }
    json(res, 200, Object.assign({ ok: true }, result, importStatus()));
  });

  route(BASE + "/pending", async (req, res) => {
    const url = new URL(req.url || BASE + "/pending", "http://127.0.0.1");
    const callId = String(url.searchParams.get("callId") || "");
    if (!callId) {
      json(res, 400, { ok: false, error: "缺少 callId" });
      return;
    }
    const hit = pendingAsks.get(callId);
    if (!hit) {
      json(res, 200, { ok: false, error: "没有对应的待审批 MCP 调用" });
      return;
    }
    json(res, 200, { ok: true, toolName: hit.toolName, session: hit.session, server: hit.server, tool: hit.tool, at: hit.at });
  });

  const onPre = async (exec, next) => {
    try {
      const server = serverByToolName(exec && exec.name);
      if (!server) return next();
      const prefix = "mcp__" + sanitizeName(server.name, "mcp") + "__";
      const tool = exec.name.slice(prefix.length);
      const serverName = sanitizeName(server.name, "mcp");
      const pol = policyFor(server, tool);
      const blocked = blockReason(exec.name);
      if (blocked) {
        appendRecord({
          ts: new Date().toISOString(),
          t: Date.now(),
          server: serverName,
          source: "agent",
          tool,
          decision: "deny",
          ok: false,
          ms: 0,
          args: exec.arguments,
          error: blocked
        });
        return { kind: "deny", reason: "MCP（" + serverName + "）：" + blocked };
      }

      const decision = effectiveApproval(server);
      if (!exec.agent) {
        inFlight.set(exec, { t0: Date.now(), decision: "panel", tool, serverName, args: exec.arguments });
        return next();
      }

      if (decision.follow && hasSessionGrant(exec.agent.session, serverName, tool)) {
        inFlight.set(exec, { t0: Date.now(), decision: "grant", tool, serverName, args: exec.arguments });
        return next();
      }

      if (decision.follow) {
        const policy = dshEffectivePolicy(exec.agent.session);
        if (policy === null) {
          appendRecord({
            ts: new Date().toISOString(), t: Date.now(), server: serverName, source: "agent",
            tool, decision: "deny", ok: false, ms: 0, args: exec.arguments,
            error: "审批跟随 DSH，但读不到官方审批策略"
          });
          return { kind: "deny", reason: "MCP（" + serverName + "）：审批设置为跟随 DSH，但官方审批服务不可用（未组合 dsh-user-approval），已按 fail closed 拒绝" };
        }
        if (policy === "never") {
          inFlight.set(exec, { t0: Date.now(), decision: "follow:never", tool, serverName, args: exec.arguments });
          return next();
        }
        const outcome = await askOfficial(exec, serverName, tool);
        const remembered = outcome === "allowed-once" && hasSessionGrant(exec.agent.session, serverName, tool);
        inFlight.set(exec, {
          t0: Date.now(),
          decision: outcome === "allowed-once" ? (remembered ? "follow:granted" : "follow:allowed") : "follow:" + outcome,
          tool, serverName, args: exec.arguments
        });
        if (outcome === "allowed-once") return next();
        if (outcome === "rejected") return { kind: "deny", reason: "the user rejected tool \"" + exec.name + "\"" };
        if (outcome === "cancelled") return { kind: "cancel" };
        return { kind: "deny", reason: "tool \"" + exec.name + "\" requires approval, but no approval channel is available" };
      }

      if (!pol.approval) {
        inFlight.set(exec, { t0: Date.now(), decision: "allow", tool, serverName, args: exec.arguments });
        return next();
      }
      const manualOutcome = await askOfficial(exec, serverName, tool);
      inFlight.set(exec, {
        t0: Date.now(),
        decision: manualOutcome === "allowed-once" ? "ask:allowed" : "ask:" + manualOutcome,
        tool, serverName, args: exec.arguments
      });
      if (manualOutcome === "allowed-once") return next();
      if (manualOutcome === "rejected") return { kind: "deny", reason: "the user rejected tool \"" + exec.name + "\"" };
      if (manualOutcome === "cancelled") return { kind: "cancel" };
      return { kind: "deny", reason: "tool \"" + exec.name + "\" requires approval, but no approval channel is available" };
    } catch (e) {
      if (typeof next !== "function") return undefined;
      try {
        let safeArgs;
        try {
          safeArgs = exec && exec.arguments;
        } catch {
          safeArgs = "{unreadable}";
        }
        appendRecord({
          ts: new Date().toISOString(), t: Date.now(),
          server: "unknown", source: "agent",
          tool: String((exec && exec.name) || ""),
          decision: "deny", ok: false, ms: 0,
          args: safeArgs,
          error: "审批门内部异常，已 fail closed：" + String((e && e.message) || e)
        });
      } catch {}
      try {
        pluginCtx?.logger?.warn?.("mcp-hub: 审批门异常，已拒绝该调用：" + String((e && e.message) || e));
      } catch {}
      return { kind: "deny", reason: "MCP（mcp-hub）：审批门内部异常，已按 fail closed 拒绝这次调用" + (e && e.message ? "：" + e.message : "") };
    }
  };

  async function askOfficial(exec, serverName, tool) {
    const approval = dshApprovalService();
    if (!approval) return "unavailable";
    const reason = "MCP 审批（" + serverName + "）：将调用 " + tool + " " + previewArgs(exec.arguments);
    const askKey = exec.callId === undefined ? "" : String(exec.callId);
    const sessionId = exec.agent && exec.agent.session && exec.agent.session.id ? String(exec.agent.session.id) : "";
    if (askKey) {
      pendingAsks.set(askKey, { toolName: exec.name, session: sessionId, server: serverName, tool, at: Date.now() });
    }
    try {
      const result = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        ...(exec.callId === undefined ? {} : { callId: exec.callId }),
        reason,
        displayReason: {
          en: "MCP server " + serverName + " wants to run " + tool + " " + previewArgs(exec.arguments),
          zh: reason
        },
        ...(exec.signal === undefined ? {} : { signal: exec.signal })
      });
      return ["allowed-once", "rejected", "cancelled", "unavailable"].includes(result) ? result : "unavailable";
    } catch (e) {
      try {
        pluginCtx?.logger?.warn?.("mcp-hub: 官方审批请求失败（" + serverName + "/" + tool + "）：" + String((e && e.message) || e));
      } catch {}
      return "unavailable";
    } finally {
      if (askKey) pendingAsks.delete(askKey);
    }
  }

  const approvalReceipt = (decision) => {
    switch (decision) {
      case "follow:allowed": return "审批：本次已由用户允许一次（下次仍会询问）";
      case "follow:granted": return "审批：本次已允许，并记住该工具，本对话内下次不再询问";
      case "ask:allowed": return "审批：本次已由用户允许一次（下次仍会询问）";
      case "grant": return "审批：本对话内已授权，本次未再次询问";
      case "follow:never": return "审批：当前策略为 never，未弹窗直接放行";
      case "allow": return "审批：该工具在面板中设为免审批，未弹窗";
      case "panel": return "审批：面板调试调用，视为已授权";
      default: return null;
    }
  };

  function buildReceiptDecision(handled, result, receipt) {
    const content = result && result.content;
    if (!Array.isArray(content) || !content.length) return { decision: null, via: "no-content" };
    let next = null;
    for (let i = content.length - 1; i >= 0; i -= 1) {
      const block = content[i];
      if (block && block.type === "text" && typeof block.text === "string") {
        next = content.slice();
        next[i] = { ...block, text: block.text + "\n[" + receipt + "]" };
        break;
      }
    }
    const via = next ? "content:text-join" : "content:append";
    if (!next) next = [...content, { type: "text", text: "\n[" + receipt + "]" }];
    const decision = { ...(handled && typeof handled === "object" ? handled : {}), content: next };
    delete decision.value;
    return { decision, via };
  }

  const onPost = async (exec, result, next) => {
    let meta = null;
    try {
      meta = exec && inFlight.get(exec);
      if (meta) inFlight.delete(exec);
    } catch {}
    const receipt = meta ? approvalReceipt(meta.decision) : null;
    let handled;
    let failure = null;
    try {
      handled = await next();
    } catch (e) {
      failure = e;
    }
    if (meta) {
      let note = "";
      if (receipt) {
        try {
          const built = buildReceiptDecision(handled, result, receipt);
          if (built.decision) {
            handled = built.decision;
            note = "ok:" + built.via;
          } else {
            note = "miss:" + built.via;
          }
        } catch {
          note = "miss:throw";
        }
      }
      try {
        const broke = Boolean(failure) || Boolean(handled && typeof handled === "object" && handled.kind === "block");
        const errText = failure
          ? String((failure && failure.message) || failure)
          : result && result.isError
            ? resultText(result)
            : "";
        appendRecord({
          ts: new Date().toISOString(),
          t: Date.now(),
          server: meta.serverName,
          source: "agent",
          tool: meta.tool,
          decision: meta.decision,
          ok: !broke && !(result && result.isError),
          ms: Date.now() - meta.t0,
          args: meta.args,
          error: errText ? errText.slice(0, 500) : "",
          receipt: note
        });
      } catch {}
    }
    if (failure) throw failure;
    return handled;
  };

  disposers.push(ctx.on("tools/pre-execute", onPre));
  disposers.push(ctx.on("tools/post-execute", onPost));

  try {
    disposers.push(ctx.on("session/disposed", (session) => {
      dropSessionGrants(session);
    }));
  } catch {}

  const timer = setInterval(() => {
    try {
      const now = Date.now();
      for (const server of cfg.servers) {
        if (server.enabled === false) continue;
        if (server.transport === "stdio" || !server.url) continue;
        if (!server.autoReconnect) continue;
        const c = connFor(server);
        if (c.status === "connected") {
          if (now - c.lastConnectedAt > 60000) {
            void reconnectNow(server).then((r) => {
              if (!r) scheduleRetry(server);
            });
          }
          continue;
        }
        if (c.nextRetryAt && now < c.nextRetryAt) continue;
        void reconnectNow(server).then((r) => {
          if (!r) scheduleRetry(server);
        });
      }
    } catch {}
  }, 5000);
  if (typeof timer.unref === "function") timer.unref();

  disposers.push(() => clearInterval(timer));

  ctx.effect(() => () => {
    for (const off of disposers) {
      try {
        off && off();
      } catch {}
    }
  }, "mcp-hub: routes and gates");

  for (const server of cfg.servers) {
    if (server.enabled === false) continue;
    if (server.transport === "stdio" || !server.url) continue;
    if (!server.autoReconnect) continue;
    void reconnectNow(server).then((r) => {
      if (!r) scheduleRetry(server);
    });
  }
}
