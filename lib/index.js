import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { firstSentence, normalizeTier } from "./context-budget.js";
import { createGateway } from "./gateway.js";

const BASE = "/mcp-hub";
const PLUGIN_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

// ── 凭证 ─────────────────────────────────────────────────────
// 不做静态加密：主流 MCP 管理器（含 524 星的 ravitemer/mcp-hub）都把凭证明文
// 存本地配置，靠文件权限与「不入库」控制扩散；自造加密时密钥与密文同机，
// 挡不住能读文件的人，只是多一层可失效的复杂度。MCP 规范只要求安全存储
// OAuth 短期令牌，用户填的 API key 走引用。落盘的明文由两道边界兜住：
// 文件已在 .gitignore、权限收紧到当前用户，对外路由只回本机同源请求。
function unsealServer(server) {
  // 历史版本写入的密文无法再解：当作没有凭证，让用户重填一次。
  if (server && typeof server.token === "string" && server.token.startsWith("enc:v1:")) {
    server.token = "";
    server.__tokenUnreadable = true;
  }
  return server;
}

// 把这个文件写到只有当前用户能读。config.json 里有明文 Token，
// 权限就是它的边界；Windows 上用 icacls，失败静默跳过。
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
    // ESM 里没有全局 require，这里必须用同步导入后的 spawnSync。
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

// ── 审批策略 ─────────────────────────────────────────────────
// 三态而不是布尔：inherit 跟全局总开关，follow 强制跟随 DSH，manual 回到逐工具开关。
// 保留 inherit 是为了让「改总开关」真的对未单独表态的服务器生效。
const APPROVAL_MODES = ["inherit", "follow", "manual"];

function normalizeApproval(raw) {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { followDsh: a.followDsh !== false };
}

function normalizeApprovalMode(v) {
  return APPROVAL_MODES.includes(v) ? v : "inherit";
}

// 网关（mcp_hub_tools 检索工具）的三个可调参数。范围钳制在这里做一次，
// gateway.js 里还会再做一次——面板输入与磁盘旧值都不被信任。
const GATEWAY_DEFAULTS = { searchLimit: 8, catalogLimit: 200, schemaMaxBytes: 16000, loadBatchMax: 12 };

function normalizeGateway(raw) {
  const g = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const num = (v, lo, hi, fb) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
  };
  return {
    searchLimit: num(g.searchLimit, 1, 20, GATEWAY_DEFAULTS.searchLimit),
    catalogLimit: num(g.catalogLimit, 1, 500, GATEWAY_DEFAULTS.catalogLimit),
    schemaMaxBytes: num(g.schemaMaxBytes, 2000, 128000, GATEWAY_DEFAULTS.schemaMaxBytes),
    loadBatchMax: num(g.loadBatchMax, 1, 50, GATEWAY_DEFAULTS.loadBatchMax)
  };
}

// 工具目录：把「按需」服务器的工具名常驻进系统提示词。
// 模型开局就能说出「我有哪些工具」，只是不知道参数；调用前用
// mcp_hub_tools(names=[...]) 取回即可。省的是 schema，不是「存在性」。
const CATALOG_DEFAULTS = { enabled: true, mode: "names", limit: 200 };
const CATALOG_MODES = ["names", "summary"];

function normalizeCatalog(raw) {
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const n = Math.round(Number(c.limit));
  return {
    enabled: c.enabled !== false,
    mode: CATALOG_MODES.includes(c.mode) ? c.mode : CATALOG_DEFAULTS.mode,
    limit: Number.isFinite(n) ? Math.min(500, Math.max(1, n)) : CATALOG_DEFAULTS.limit
  };
}

function normalizeServer(raw) {
  const d = defaultServer();
  // Object.assign 会把值为 undefined 的键也算进去，覆盖掉默认值。
  // 于是 normalizeServer({ id: undefined }) 会把 id 变成字符串 "undefined"，
  // 而不是回落到新生成的 id——这个假 id 之后会一路写进 config.json。
  // 先把 undefined 的键剔掉，让「没传」和「传了空」都能正确回落到默认值。
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
  // 投放档位：full 保持既有行为（全部 schema 常驻），lazy 只留工具名与摘要，
  // off 连检索都不给。旧配置没有这个键，必须回落到 full，否则升级即变行为。
  s.budgetTier = normalizeTier(s.budgetTier);
  const t = Number(s.toolCallTimeoutMs);
  s.toolCallTimeoutMs = Number.isFinite(t) && t >= 1000 ? t : 60000;
  return s;
}

// 旧版本是「单服务器」扁平配置：url/token/serverName/tools。
// 这里把它等价迁移成 servers[0]，窗口内不改变用户既有连接行为。
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

// stdio 服务器由 DSH 原生 mcp-client 连接，hub 不另开连接：
// 工具清单、审批、禁用、调试全部改读 ctx.tools 注册表。
let toolsRegistry = null;
let pluginCtx = null;

function readConfig() {
  try {
    if (!existsSync(configPath())) {
      const migrated = tryMigrateLegacyConfig();
      if (migrated) return migrated;
      return { profile: "", approval: normalizeApproval(), gateway: normalizeGateway(), catalog: normalizeCatalog(), servers: [] };
    }
    const raw = migrateLegacy(JSON.parse(readFileSync(configPath(), "utf8") || "{}"));
    const cfg = { profile: String(raw.profile || ""), approval: normalizeApproval(raw.approval), gateway: normalizeGateway(raw.gateway), catalog: normalizeCatalog(raw.catalog), servers: [] };
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
    return { profile: "", approval: normalizeApproval(), gateway: normalizeGateway(), catalog: normalizeCatalog(), servers: [] };
  }
}

let cfg = readConfig();

// 最近一次 persist 的失败原因，供路由判断要不要报 ok:false。
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
    // 静默吞掉写入失败等于骗用户「已保存」：重开面板配置就回去了。
    // 记下原因，由路由把 ok:false 带回面板。
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

// 面板编辑器只提交它看得见的那几个字段，因此「没传」与「传了空」必须区分：
// 没传 = 保持原值，传了空 = 用户真的清空了。
//   - token 没传（或 keepToken），保留磁盘上已解密的凭证，否则一次保存就把
//     Token 抹掉，下一次连接变 401；
//   - tools 没传，保留逐工具策略，否则改个 URL 就把所有审批开关清零。
function upsertServer(input) {
  const raw = Object.assign({}, input);
  const incoming = normalizeServer(raw);
  const incomingId = String((raw && raw.id) || "");
  const idx = incomingId ? cfg.servers.findIndex((s) => s.id === incomingId) : -1;
  // 先查重名再落库：两台同名服务器会映射到同一个 mcp__<name>__ 前缀，
  // 审批与记录都会指向错误的那一台，所以必须在写入前拒绝。
  const clash = cfg.servers.some((s) => s.name === incoming.name && s.id !== incoming.id);
  if (clash) throw new Error("服务器名已存在：" + incoming.name);
  if (idx >= 0) {
    const prev = cfg.servers[idx];
    if (raw.token === undefined || raw.keepToken === true) incoming.token = prev.token;
    if (raw.tools === undefined) incoming.tools = prev.tools;
    if (raw.enabled === undefined) incoming.enabled = prev.enabled;
    // 「没传」保持原值：「改个 URL」不该顺手把 lazy 档位打回 full。
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
    // 授权是按「会话 + 服务器名 + 工具」记的，不跟着 id 走。删掉服务器却留着
    // 授权，意味着「删掉再同名重建」这种最常见的修配置方式，会让新服务器
    // 静默继承旧服务器所有已批准工具——没有任何弹窗。
    // 所以连同这个服务器名的授权一起清掉。
    if (removed) {
      const key = sanitizeName(removed.name, "mcp");
      // 通过函数访问 sessionGrants：它的 const 声明在文件后面，模块顶层的
      // removeServer 这里直接引用会撞上 TDZ（当前只在 apply 之后调用，但
      // 不该依赖调用时机）。
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

// 配置属于用户数据，必须放在 storages 而不是插件包内：
// 包目录每次安装/升级都会被覆盖，README 也会说明 files 不含 config.json。
function legacyConfigPath() {
  return join(PLUGIN_ROOT, "config.json");
}

// 从旧版（config.json 打包在插件目录里）平滑迁移到 storages。
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
    // 连接方是原生 mcp-client，插件只观察它注册进注册表的工具。
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

// ── 注册表适配层 ───────────────────────────────────────────────
// stdio 工具由 dsh-mcp-client 注册进 ctx.tools，公开名为 mcp__<server>__<tool>。
// 面板不再自建连接，只读/驱动这份注册表。

// 服务可能在 apply 之后才挂载，取用点惰性解析一次并缓存。
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

// schemas() 投影出 { name, description, parameters }，不含 execute。
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

// 该服务器是否走注册表：stdio 恒走；HTTP 在已注册到 DSH 时也走（面板可直接管理）。
function usesRegistry(server) {
  if (!server) return false;
  if (server.transport === "stdio") return true;
  return managedTools(server).length > 0;
}

function policyFor(server, tool) {
  const p = (server.tools && server.tools[tool]) || {};
  return { enabled: p.enabled !== false, approval: p.approval === true };
}

// 工具名在 DSH 里是 mcp__<serverName>__<tool>。按前缀反查归属服务器，
// 让审批与记录对所有服务器一致生效，而不是只认某一家。
function serverByToolName(name) {
  if (typeof name !== "string") return null;
  for (const s of cfg.servers) {
    if (name.startsWith("mcp__" + sanitizeName(s.name, "mcp") + "__")) return s;
  }
  return null;
}

// ── 一个真相源：这个工具「能不能被调用」与「要不要进提示词」 ──────────
// 过去只有 guard 一道：它否决执行，但 schema 早在注册时就进了请求，
// 于是「面板里禁用一个 207 工具的重型服务器」白付 20 万 token，
// 还让那些工具变成一叫就报错的诱饵。这里把两件事拆开说清：
//
//   blockReason  —— 不许调用。禁用的服务器、禁用的工具、off 档位。
//                   既不进提示词，也不许检索取回。
//   hiddenReason —— 不进提示词，但可检索、可取回、可调用。
//                   lazy 档位：省的是常驻 schema，不是能力。
//
// 两者都按公开名（mcp__<server>__<tool>）判定，因此提示词过滤与执行
// 否决读的是同一份配置，不会出现「面板说禁用、模型却还能叫」。
function blockReason(fullName) {
  const server = serverByToolName(fullName);
  if (!server) return null;
  if (server.enabled === false) return "服务器 " + sanitizeName(server.name, "mcp") + " 已在面板中禁用";
  if (normalizeTier(server.budgetTier) === "off") return "服务器 " + sanitizeName(server.name, "mcp") + " 的投放档位是 off";
  const tool = String(fullName).slice(toolPrefix(server.name).length);
  if (!policyFor(server, tool).enabled) return "工具 " + tool + " 已在面板中禁用";
  return null;
}

// 现在统一走「分层按需」：不再有任何服务器把 schema 常驻提示词，
// 全部由 mcp_hub_tools 三段式展开。档位仍保留 full / lazy 的配置兼容，
// 但 full 的语义已改为「与 lazy 相同」——按用户的决定，不为 full 单开
// 一条常驻路径。off 仍然是真·关掉。
function hiddenReason(fullName) {
  const blocked = blockReason(fullName);
  if (blocked) return blocked;
  const server = serverByToolName(fullName);
  if (!server) return null;
  return "服务器 " + sanitizeName(server.name, "mcp") + " 的工具按需展开";
}

// ── 工具目录：把「按需」服务器的工具名常驻进系统提示词 ──────────
// 模型开局就能说出「我有哪些工具」，只是不知道参数；调用前用
// mcp_hub_tools(names=[...]) 取回即可。省的是 schema，不是「存在性」。
//
// 只列 lazy 且真的在线的：full 的 schema 本来就在提示词里（重复列是白花钱），
// off / 整台禁用 / 逐工具禁用的列出来就是「一叫就失败」的诱饵；
// 未连接 / 连接失败 / 从未拨过号的同样不列——连上都自动回来，
// 目录不需要一个现在叫不通的名字。
//
// 在线的判定与 /tools 路由同源，只是不能在这里拨号：
//   注册表有工具 → 在线（stdio 与已注册的 HTTP 都走这条）；
//   否则 → 只有拨号状态是 connected 时，用 conn.tools。
// 「有可列的工具」就是「在线」——注册表空、连接也没连上，目录里就没有它。
function catalogTools(s) {
  const managed = managedTools(s);
  if (managed.length) return managed;
  const conn = connFor(s);
  return conn.status === "connected" ? conn.tools : [];
}

// 工具目录：三段式渐进披露在提示词里的那一层。
//
// 历史上这里铺开的是「服务器名 + 每个工具名（可选摘要）」，200 个工具名
// 本身就值几千 token，而绝大多数轮次一个都用不到。现在只列**服务器名与
// 工具数**，工具名与参数都要模型显式展开：
//   系统提示词  →  服务器列表（本函数）
//   server=<名>  →  该服务器的工具名 + 一句话摘要
//   names=[...]  →  完整参数 schema
//
// 这样常驻成本是 O(服务器数)，与工具总数无关。
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
    groups.push({ server: name, count: tools.length });
    total += tools.length;
  }
  if (!groups.length) return "";
  groups.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
  const shown = groups.slice(0, c.limit);
  const parts = [
    "<mcp-tool-catalog>",
    "所有 MCP 工具的参数 schema 都没有常驻提示词，只用 mcp_hub_tools 一个工具分层展开：",
    "  1) mcp_hub_tools（不带参数）→ 服务器列表",
    "  2) mcp_hub_tools({ server: \"<服务器名>\" }) → 该服务器的工具名与摘要",
    "  3) mcp_hub_tools({ names: [\"<完整工具名>\"] }) → 完整参数，之后即可直接调用",
    "也可以用 mcp_hub_tools({ query: \"<关键词>\" }) 跨服务器检索。",
    "服务器：" + shown.map((g) => g.server + "（" + g.count + " 个工具）").join("、")
  ];
  if (groups.length > shown.length) {
    parts.push("（另有 " + (groups.length - shown.length) + " 个服务器未列出，用 mcp_hub_tools 查看）");
  }
  parts.push("</mcp-tool-catalog>");
  return parts.join("\n");
}

// ── 审批判定 ─────────────────────────────────────────────────
// effectiveApproval 把「总开关 + 服务器三态」压成一次决定。
// inherit 存在的意义是让总开关真的能一把改掉所有未单独表态的服务器。
function effectiveApproval(server) {
  const mode = server && server.approvalMode ? server.approvalMode : "inherit";
  const globalFollow = !cfg.approval || cfg.approval.followDsh !== false;
  if (mode === "follow") return { follow: true, source: "server" };
  if (mode === "manual") return { follow: false, source: "server" };
  if (!globalFollow) return { follow: false, source: "global" };
  // 总开关「跟随 DSH」时不再看逐工具布尔：那只是旧语义的遗留，
  // 混用会让「总开关打开却还在弹窗」变得无法解释。
  return { follow: true, source: "global" };
}

// 读官方那次真实折叠，不在本地重算策略。approval.overrideOf(session) 是
// dsh-user-approval 自己的读取路径，config.policy 是它 schema 回落到 "ask" 的默认值。
// 读不到返回 null，调用方按 fail closed 处理，绝不在这里假装它是 ask。
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

// 会话级授权：同一工具在一次对话里批准过一次，后续调用不再重复询问。
// 键是「会话 + 服务器 + 工具」，值是批准时间；会话结束（session/disposed）即清空。
//
// 粒度刻意是工具而不是服务器：按服务器记忆会让一次对 get_self_info 的批准
// 顺带解锁同服务器的 get_skey / kick / run_script。弹窗里用户看到的是
// 「读取自己的账号信息」，他批准的是那一次，不是整台服务器的全部能力。
// 语义上仍然对齐官方 allowed-once——一次授权只覆盖它所针对的那一个动作。
const sessionGrants = new Map();

// 客户端渲染埋点，仅在排查 slot 是否接通时使用；不落盘、不进备份。
const traceLog = [];

// 正在等审批的 MCP 调用：callId → 工具身份。
// 客户端审批卡片只拿到 callId，靠这张表反查工具名，才能决定是否显示
// 「记住本会话」以及把授权写到正确的工具上。调用结束即删除。
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

// 删服务器时连带清掉这个服务器名下的全部授权。
// 键是「会话\0服务器名\0工具」，中段就是服务器名。
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

// 「跟随 DSH」不是一句口号：这里读的就是官方那次真实折叠。
// approval.overrideOf(session) 是 dsh-user-approval 自己的读取路径，
// config.policy 是它 schema 里回落到 "ask" 的部署默认值。
// 读不到就如实说读不到，绝不在这里假装策略是 ask。
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
  // 权限预设名（配置里的 / 当前会话的），用于把「跟随」对接成用户能认出来的那条模式。
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

// 日志按「服务器 → 日期」两级聚合，服务器清单取自配置，
// 历史上已删除服务器的记录归到 unassigned，避免数据静默消失。
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

// 这里曾经有 findProfiles() / currentProfileDir()，键的是
// @dsh-external/dsh-qfun-mcp——那是另一个插件。两个函数已无人调用，
// 留着只会让下一个人以为「profile 是这样找到的」。统一走 allProfileDirs()。

// 测试会在系统临时目录下 mkdtemp 一个 DSH_HOME。判据用「DSH_HOME 是否落在
// tmpdir 下」而不是读 NODE_TEST_CONTEXT：后者在直接 `node xxx.test.mjs` 与
// `node --test` 下都不可见，拿不到就等于没有防护。
function underTempDir(p) {
  const t = resolve(tmpdir());
  const r = resolve(p);
  return r === t || r.startsWith(t + sep);
}

function patchFilePath() {
  // 测试要在临时目录里造补丁文件；不给这条缝，测试的保存/删除路径会直接
  // 改写插件真实的 cordis.patch.yml ——那是有毒的测试副作用。
  const override = process.env.DSH_MCP_HUB_PATCH_FILE;
  if (override && override.trim()) return override;
  // 兜底：测试进程里 DSH_HOME 一定指向临时目录，但未必记得设 override。
  // 少了这一步，任何一条「忘了接管」的测试都会静默覆盖真实补丁
  // ——budget.routes.test.mjs 就这么把线上补丁写成过只剩 dead-end 的形态。
  // 走临时路径而不是抛错：测试仍然要能读写一个补丁，只是不许碰真的那个。
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

// 桥接区从第一条 mcp-hub- 条目开始，到「不再属于桥接区」的第一行为止。
//
// 判据是：`- id: mcp-hub-*` 开头，且紧跟的下一行是
// `name: '@deepseek-ai/dsh-mcp-client'`。
// 只看行首 `- ` 是不够的：args 数组元素 `          - '-m'` 也是它开头，
// 那会把边界切在半个条目上；只看第一条也不够：后续同 id 的桥接条目会留在
// 区外，下次写入时与新区块并存，于是 patch 里出现两份 mcp-hub-windows /
// mcp-hub-mobile，两个 mcp-client 实例抢同一个 serverName。
// 这是上一版真实发生过的故障，别再把判据简化回去。
function findBridgeInPatch(raw) {
  const idx = raw.indexOf("- id: mcp-hub-");
  if (idx < 0) return null;
  const start = raw.lastIndexOf("\n", idx) + 1;
  const lines = raw.split("\n");
  // 把 start 换算成行号。
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
    // 桥接条目在 patch 里是四空格缩进的 `- id: mcp-hub-`（`- insert:` 下的列表）。
    if (!/^\s*- id: mcp-hub-/.test(line)) return false;
    // 下一行必须是 mcp-client 的 name。
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (/^\s*$/.test(next)) continue;
      return /^\s+name:\s*'@deepseek-ai\/dsh-mcp-client'/.test(next);
    }
    return false;
  };
  // 边界只认「列表条目开头」：`- id: ...` / `- insert:` / `- name: ...`。
  // 不能只看 `- `——args 里的 `          - '-m'` 也是 `- ` 开头，
  // 那样会把边界切在第一个 args 数组元素上，桥接区被截断成半个条目。
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
  // 这个文件现在是明文 Bearer Token 的落点，权限必须与 config.json 同一档。
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

// 桥接区已存在时，按当前配置重写它 —— 用于「禁用/删除服务器后让补丁跟上」。
// 未写过补丁的机器不动：没桥接就是没桥接，不该因为禁用一台就凭空生成一份。
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
    // 桥接区后面的内容要原样接回来，不能只留 head。
    const tail = raw.slice(existing.end);
    const body = [head, tail.trim()].filter((x) => x !== "").join("\n");
    writePatchText(file, body ? body + "\n" : patchHeader());
    return { ok: true, changed: true, file };
  }
  // 一台启用的服务器都没有：桥接块是空的，此时「写入」实际等于把已有桥接删掉。
  // 之前照样报 changed:true 并提示「重启后生效」，而 imported 随后变 false，
  // 面板和提示互相打脸。这里如实拒绝，让用户先启用至少一台。
  if (!block) {
    return { ok: false, changed: false, file, error: "没有启用的服务器，未写入任何桥接条目" };
  }
  let next;
  if (existing) {
    // 只替换桥接区，前后文都保留。
    next = raw.slice(0, existing.start) + block + "\n" + raw.slice(existing.end);
  } else {
    const base = raw.trim() ? raw.replace(/\s+$/, "") + "\n" : patchHeader();
    next = base + block + "\n";
  }
  writePatchText(file, next);
  return { ok: true, changed: true, file };
}

// ── 整插件备份与恢复 ───────────────────────────────────────────
// 备份包含：服务器列表（含策略）+ 当前加载补丁文本。
// 刻意不含调用日志：日志是按天增量的流水，塞进备份会让文件失控。

const BACKUP_KIND = "dsh-mcp-hub/backup";
const BACKUP_VERSION = 1;

function buildBackup() {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    profile: cfg.profile,
    // 审批总开关也进备份：它是策略的一部分，漏了会让「精确复刻一台机器」变成假承诺。
    approval: normalizeApproval(cfg.approval),
    gateway: normalizeGateway(cfg.gateway),
    catalog: normalizeCatalog(cfg.catalog),
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
  return { ok: true, servers, approval: raw.approval, gateway: raw.gateway, catalog: raw.catalog, patch: typeof raw.patch === "string" ? raw.patch : "" };
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
  // 旧备份没有 approval 字段：合并时保留本机现值，覆盖时回到跟随默认值，
  // 而不是把「没写」误当成「关掉」。
  if (v.approval && typeof v.approval === "object") {
    cfg.approval = normalizeApproval(v.approval);
  } else if (replaced) {
    cfg.approval = normalizeApproval();
  }
  // 旧备份没有 gateway / catalog 字段：合并时保留本机现值，覆盖时回到默认值。
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
  const seen = new Set(cfg.servers.map((s) => s.id));
  let added = 0;
  let updated = 0;
  for (const s of incoming) {
    if (!seen.has(s.id) && cfg.servers.some((x) => x.name === s.name)) {
      // 同名但不同 id：按名覆盖，避免出现两套同名服务器争同一前缀。
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
  // 备份里的 patch 是「导出时的补丁快照」，它可能来自另一台机器、也可能因为
  // 导出时该机器还没写过补丁而为空。两种情况都不能决定本机补丁的最终形态。
  //
  // 唯一的真相是本机刚恢复出来的启用列表：恢复完必须让它重建桥接区，否则
  // 会出现「config.json 里五台服务器、cordis.patch.yml 里只有一台死端点」的
  // 分裂状态——DSH 下次启动按补丁拉 mcp-client，工具目录因此整个空掉。
  // 这就是本仓库真实发生过的故障，别再把 syncBridgeIfPresent 只挂到面板路由上。
  let patchWritten = false;
  if (v.patch && v.patch.trim()) {
    try {
      writePatchText(patchFilePath(), v.patch);
      patchWritten = true;
    } catch {}
  }
  // 补丁里已有桥接区时按当前启用列表重写它；没有桥接区就不凭空生成
  // ——「没写过补丁的机器不该因为恢复一份备份就被塞进一份补丁」。
  const patched = syncBridgeIfPresent();
  return { ok: true, mode: replaced ? "replace" : "merge", added, updated, total: cfg.servers.length, patchWritten, patch: patched };
}

// ── 本地服务器发现 ─────────────────────────────────────────────
// 扫描 DSH profile 的 cordis 配置，找出所有 mcp-client 实例，
// 让面板可以「接管」已由 DSH 连接的服务器，而不是让用户重填一遍。

// 扫描范围是 profile 目录本身，与既有 findProfiles() 的用途不同：
// 那个函数找「装了本插件的 profile」，这里找「有 cordis 配置的 profile」。
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

// bundle 补丁层可能出现在两处：profile 根目录，以及任意已安装插件包内
// （本插件自己就把 mcp-client 条目写在包内 cordis.patch.yml）。
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
  // 插件包内的 bundle patch
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

// 极简 YAML 扫描：只认 mcp-client 条目需要的几个键，避免引入 yaml 依赖。
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
  // 注册表服务可能在 apply 之后才就绪，取用点再读一次（ctx.get 是惰性的）。
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

  // ── 凭证只回给「本机发起的同源请求」 ───────────────────────────
  // 这些路由挂在 DSH 的 webServer 上，而 webServer 绑定哪个地址不由本插件决定：
  // dsh-remote-web-ui 这类插件就是专门把 web 改绑到局域网地址的。一旦发生，
  // 任何能访问该端口的人都能读走全部 Bearer Token 与补丁全文。
  //
  // 判断只看请求头，不依赖对端地址（req.socket.remoteAddress 在反代后面不可信）：
  //   1) Host 必须是回环——端口已经不是边界了，只有「请求来自本机」还是；
  //   2) Sec-Fetch-Site 存在时必须是 same-origin / none；
  //   3) 带 Origin 时其主机也必须在回环上。
  // 三条都过才给凭证；其余一律按「只回结构、不回密钥」处理。
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
      // 凭证只回给回环地址。这是唯一不依赖「谁能访问到这个端口」的判断：
      // webServer 一旦被改绑到局域网（有插件专门做这件事），端口本身就不再
      // 是边界，只有「请求来自本机」还能算边界。
      if (!loopbackHosts.has(host)) return false;
      // 浏览器同源请求：Origin 必须也在回环上。跨站页面（evil.example 打
      // 127.0.0.1）会被这里挡掉——那是本插件最现实的 CSRF 面。
      if (site && site !== "same-origin" && site !== "none") return false;
      if (!origin) return !site; // 无头直连（本机脚本）= 等同读文件
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
    // 一次扫描复用到两处：managedToolCount 与 managed 判定原本各调一次
    // managedTools，而它每次都要把该服务器全部 schema 序列化一遍。
    // /status 是 12 秒一次的轮询，207 个工具上这是每轮两次全量深拷贝。
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
      // env 刻意不在 /status 里：stdio 的 env 经常装着 API key，而 status 是
      // 每 12 秒一次、会被浏览器缓存的轮询。凭证只在 editableOf() 里给出，
      // 与 _token 同一条规则（同源 + 本机）。
      tokenConfigured: !!(server.token && server.token !== "none"),
      // 历史版本留下的密文解不开时 token 为空，让面板能提示重填。
      tokenUnreadable: !!(server.__tokenUnreadable),
      // 面板用它来告诉用户「Token 落到哪里」。曾经这里给的是环境变量名，
      // 现在是补丁里直写的 Bearer，所以改报补丁路径。
      tokenAppliedTo: patchFilePath(),
      autoReconnect: server.autoReconnect,
      enabled: server.enabled !== false,
      approvalMode: normalizeApprovalMode(server.approvalMode),
      approvalEffective: effectiveApproval(server),
      // 投放档位与它此刻是否真的从提示词里被摘掉，是两件事：
      // full 档位也可能因为「整台禁用」而不可见。面板要能说清这一差别。
      budgetTier: normalizeTier(server.budgetTier),
      // 这一项只在面板真正打开时才需要，而 /status 是每 12 秒一次、会被浏览器
      // 缓存的轮询。这里不再顺手算：hiddenToolCount() 要遍历该服务器的全部
      // schema，把它放进轮询里等于每 12 秒为 207 个工具做一次全量序列化。
      // 由 /tools 与 /budget 两条按需路由单独给。
      serverName: sanitizeName(server.name, "mcp"),
      toolCallTimeoutMs: server.toolCallTimeoutMs,
      tools: server.tools || {},
      latencyMs: c.latencyMs,
      server: c.server,
      // 「面板能拨通几个」与「模型真的看得到几个」是两件事，不能合成一个数。
      // qfun 是活例子：面板自带 Token 拨号成功拿到 38 个工具，但原生
      // mcp-client 因为环境变量没设而 401、注册表里 0 个 mcp__qfun__*
      // ——此时显示「已连接 38 工具」会让用户以为模型能用，实际一个都用不上。
      // toolCount 保留为「面板视角」的量（兼容既有 UI），另给两个明确口径。
      toolCount: managed.length || c.tools.length,
      dialToolCount: c.tools.length,
      // 注册表里该服务器名下的工具数 —— 这才是模型真正能看见/调用的数量。
      visibleToolCount: managed.length,
      // 拨通了但注册表是空的：模型一个工具都拿不到，光看 toolCount 会误判。
      // 这类情况最常见的原因是原生 mcp-client 缺少环境变量里的 Token。
      registryMissing: c.status === "connected" && managed.length === 0 && c.tools.length > 0,
      toolsAt: c.toolsAt,
      lastConnectedAt: c.lastConnectedAt,
      lastError: c.lastError,
      attempt: c.attempt,
      nextRetryAt: c.nextRetryAt
    };
  };

  // 编辑器要能把已保存的 Token 填回输入框，否则「打开-保存」一次就把它抹掉。
  // 只有配置读写这条路由带明文，轮询的 /status 不带：密码不该出现在每 12 秒
  // 一次、且被浏览器缓存的响应里。绑定在 127.0.0.1，与读 config.json 等价。
  const editableOf = (server) =>
    Object.assign({}, statusOf(server), {
      _token: server.__tokenUnreadable ? "" : server.token && server.token !== "none" ? server.token : "",
      // env 与 _token 一起只在这条路由上出现（stdio 的 env 里常有密钥）。
      env: server.env,
      _id: server.id,
      _name: server.name
    });
  const configPayload = (extra, view) =>
    Object.assign({ ok: true, profile: cfg.profile, approval: normalizeApproval(cfg.approval), servers: cfg.servers.map(view || editableOf) }, extra || {});
  const statusPayload = (server) => Object.assign({ ok: true, profile: cfg.profile, approval: normalizeApproval(cfg.approval), servers: cfg.servers.map(statusOf) }, server ? statusOf(server) : {});

  // 禁用必须单调：pre-execute 只决定 allow/deny/ask，可能被后续 listener 翻案，
  // 而 guard 一旦返回理由就不可逆。这里兜住「面板禁用」的最终否决权。
  // 判定与提示词过滤共用 blockReason：禁用既不该进 schema，也不该能被调用。
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

  // ── 上下文预算网关 ───────────────────────────────────────────
  // guard 只否决执行，schema 早在注册时就进了请求前缀。这个网关走官方
  // system-prompt/assemble 瀑布钩子，直接改这一轮交给 adapter 的 tools 数组，
  // 再注册一个检索工具让模型按需取回。省的是真 token，能力一个没少。
  const gateway = createGateway({
    hiddenReason,
    // 两个谓词必须分开传：hiddenReason 只决定「进不进提示词」，lazy 也在其中；
    // blockReason 才决定「能不能调用 / 该不该出现在检索目录」。
    // 混用会让 lazy 服务器的 schema 既取不回、又搜不到，却还能直接调用。
    blockReason,
    registry: () => registryService(pluginCtx || ctx),
    // 活引用：检索/取回时现读 cfg.gateway，面板改完下一步请求即生效。
    settings: () => cfg.gateway,
    // 已配置、但当前一个工具都没注册的服务器（未连接 / 拨号失败）。
    // 目录只列「现在真的能调用」的，但代价是模型会看到两份不一致的服务器清单
    // ——运行时上下文里有 5 台，检索池里只有 3 台。把差集如实报出来，
    // 模型才不会以为那两台的工具有别的问题。
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

  // 工具目录走官方入口 ctx.systemPrompt.section()：官方明令不要用
  // system-prompt/assemble 增删文本。服务可能不存在（测试 harness、
  // 精简 profile）→ 整体跳过，绝不让整条插件 failed。
  // order 3110 紧跟 SECTION_ORDERS.MCP_SERVERS(3100)，在 TOOLS_SDK(5000) 之前。
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

  // 面板调试走原生管线（含审批、超时、内容投影），不再自建连接。
  // parent 标记让调用被识别为子派发，从而不被 PTC 模式折叠掉。
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
    // 只有本机同源请求才拿得到 _token。非本机请求照常能读写配置结构，
    // 只是看不到凭证——这样面板在局域网访问时仍然可用，但不会把密钥送出去。
    const withSecrets = isCredentialSafeRequest(req);
    const viewOf = withSecrets ? editableOf : statusOf;
    if (method === "DELETE") {
      if (!id) {
        json(res, 400, { ok: false, error: "缺少 id" });
        return;
      }
      const removed = removeServer(id);
      // 删掉一台之后立刻让加载补丁跟上：否则 DSH 下次启动仍会为它拉起一个
      // mcp-client，提示词里继续宣传一台面板已经「删除」的服务器。
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
        // 启用 / 禁用会改变「谁该留在补丁里」。补丁已存在时同步重写，
        // 让「面板里禁用」真的等于「DSH 不再为它起进程、提示词里也不再提它」。
        const patched = syncBridgeIfPresent();
        // 回给面板的是可编辑值（含 _token）：编辑器保存后要立刻用新值重建草稿，
        // 拿 statusOf 的话 token 又变回空，用户会以为刚存的凭证没生效。
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
    // stdio（以及已注册进 DSH 的 HTTP）优先读注册表：那是工具事实源。
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

  // 审批设置：一处读写总开关 + 分服务器三态，以及本进程里的会话级授权。
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
    // 让面板能直接说出「跟随 DSH」到底意味着什么，而不是让用户猜。
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
    // 客户端审批面板的「本次会话都允许」：写入一条会话授权后，该工具在本对话
    // 内不再询问。只接受本插件自己前缀下的工具名，避免被当成任意放行通道。
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
    // 客户端组件渲染埋点。只在排查「按钮为什么不出现」时使用：
    // 有记录说明组件被渲染了，没有说明 slot 根本没接上。刻意不落盘。
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
      // 不带 server 的 approvalMode 视作「全部服务器一起设」，避免用户逐个点。
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

  // 网关设置：检索条数、目录上限、取回字节预算、单次批量上限。
  // 旧配置没有 gateway 键也照常可读——normalizeGateway 会补默认值。
  // 工具目录的预览与真实注入共用同一个 catalogText()：面板承诺给用户看的
  // 和模型实际收到的必须逐字节一致，否则这类「看起来对、实际不对」最难查。
  const catalogState = () => {
    const text = catalogText();
    return Object.assign({}, normalizeCatalog(cfg.catalog), {
      preview: { text, bytes: Buffer.byteLength(text) }
    });
  };
  route(BASE + "/gateway", async (req, res) => {
    const method = String(req.method || "GET").toUpperCase();
    const gatewayPayload = () => Object.assign(
      { ok: true, defaults: GATEWAY_DEFAULTS },
      normalizeGateway(cfg.gateway),
      { catalog: catalogState() }
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
    // stdio 与已注册的 HTTP 都走注册表执行：同一套审批、超时、内容投影。
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
    // 备份里是明文 Token 与补丁全文（补丁含全部 mcp-client 配置），
    // 与 /servers 同一条规则：只回本机同源请求。
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
      // 接管：把 DSH 已连接的服务器写进面板配置，连接方仍是原生 mcp-client。
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
      // 补丁里直写的是明文 Bearer，扫描器能读回来（这正是「接管本地服务器」
      // 能连 Token 一起接管的前提）。但只有真的扫到凭证才覆盖已存的那份：
      // 手写的 !!js 表达式条目、或没写 Authorization 的条目都读不到明文，
      // 此时把空串写进去会抹掉面板里已保存的 Token。
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
    // importStatus() 里的 block 是补丁正文，含各服务器的 url 与 Authorization
    // 表达式；同样只回本机同源请求。
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

  // 客户端审批卡片的 detail slot 只收到 callId，靠它反查这次审批是哪个 MCP 工具。
  // 查不到就返回 ok:false，让客户端不显示任何按钮——绝不猜一个工具名写进授权。
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
      // 与提示词过滤、guard 共用同一个判定：禁用的服务器 / off 档位 / 禁用的工具
      // 都在这里就拒掉，并如实记录。off 档位的工具从不出现在 schema 里，
      // 模型理论上叫不到；但手写调用、历史重放仍可能撞进来，所以入口必须拦。
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
      // 面板调试调用没有 agent，也就没有会话可审计、没有面板可弹。
      // 官方的结论是 deny（fail closed），但那条路径上「点运行」本身
      // 就是用户对这次调用的明确授权，所以这里放行并如实记录。
      if (!exec.agent) {
        inFlight.set(exec, { t0: Date.now(), decision: "panel", tool, serverName, args: exec.arguments });
        return next();
      }

      // 会话级授权：同一工具在本对话里批准过一次就不再重复询问。
      // 只对 follow 生效；manual 是用户显式钉住的逐工具规则，不该被记住的授权绕过。
      if (decision.follow && hasSessionGrant(exec.agent.session, serverName, tool)) {
        inFlight.set(exec, { t0: Date.now(), decision: "grant", tool, serverName, args: exec.arguments });
        return next();
      }

      // 这里刻意不返回 {kind:"ask"} 让 dsh-tools 代问，而是自己读官方策略、
      // 自己消费官方 ctx.approval。原因有二：
      //  1) dsh-tools 把 ask 一律解释成「沙箱升权」，它把 never 映射成拒绝；
      //     可 MCP 工具根本没有沙箱，never 在官方语义里是「别弹窗」（用户选了
      //     danger-full-access 预设就是不想要提示）。照搬那套映射会让用户在
      //     Full access 下每个 MCP 调用都被拒，这显然不是「跟随」的含义。
      //  2) 只有自己拿到 allowed-once 结果，才能记住本次对话的授权。
      if (decision.follow) {
        const policy = dshEffectivePolicy(exec.agent.session);
        if (policy === null) {
          // 没有审批服务就读不到策略。此时假装它是 ask 会静默变成拒绝，
          // 假装它是 never 会静默放行——两种猜测都不该做，明确拒绝并说清原因。
          appendRecord({
            ts: new Date().toISOString(), t: Date.now(), server: serverName, source: "agent",
            tool, decision: "deny", ok: false, ms: 0, args: exec.arguments,
            error: "审批跟随 DSH，但读不到官方审批策略"
          });
          return { kind: "deny", reason: "MCP（" + serverName + "）：审批设置为跟随 DSH，但官方审批服务不可用（未组合 dsh-user-approval），已按 fail closed 拒绝" };
        }
        if (policy === "never") {
          // never = 用户关掉了提示。放行并如实记录，而不是像沙箱升权那样拒绝。
          inFlight.set(exec, { t0: Date.now(), decision: "follow:never", tool, serverName, args: exec.arguments });
          return next();
        }
        const outcome = await askOfficial(exec, serverName, tool);
        inFlight.set(exec, {
          t0: Date.now(),
          decision: outcome === "allowed-once" ? "follow:allowed" : "follow:" + outcome,
          tool, serverName, args: exec.arguments
        });
        if (outcome === "allowed-once") {
          addSessionGrant(exec.agent.session, serverName, tool);
          return next();
        }        // 结果词表与 dsh-tools.serviceAsk 逐项对齐，让模型看到的措辞和官方一致。
        if (outcome === "rejected") return { kind: "deny", reason: "the user rejected tool \"" + exec.name + "\"" };
        if (outcome === "cancelled") return { kind: "cancel" };
        return { kind: "deny", reason: "tool \"" + exec.name + "\" requires approval, but no approval channel is available" };
      }

      // manual：回到旧的逐工具布尔语义，问与不问完全由面板决定。
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
      // 这里绝不能 return next()。上面的每一条失败路径都是刻意 fail closed 的
      // （读不到策略 → deny，审批服务异常 → unavailable → deny），唯独这条
      // 最外层兜底曾经是 fail **open**：exec 的某个 getter 抛错、previewArgs
      // 撞上循环引用、inFlight.set 失败……任何一种都会让工具带着「没有审批、
      // 没有记录」直接执行。任何一种都比拒绝更危险。
      // 唯一的例外是 next 本身不存在——那说明调用方不是这条管线，不该拦。
      if (typeof next !== "function") return undefined;
      try {
        // 读 exec.arguments 也可能就是抛错的那一处，所以整个记录动作再包一层。
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

  // 官方审批请求。返回官方结果词表里的一项；任何异常都折成 unavailable（fail closed），
  // 与 dsh-user-approval 对「应答者缺失或失败」的处理一致。
  async function askOfficial(exec, serverName, tool) {
    const approval = dshApprovalService();
    if (!approval) return "unavailable";
    const reason = "MCP 审批（" + serverName + "）：将调用 " + tool + " " + previewArgs(exec.arguments);
    // 登记这次待审批，供客户端 detail slot 用 callId 反查工具名。
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
      // fail closed 是对的，但静默 fail closed 没法排查。留一条日志，
      // 让「为什么每次都被拒」在 DSH 日志里有个能搜到的原因。
      try {
        pluginCtx?.logger?.warn?.("mcp-hub: 官方审批请求失败（" + serverName + "/" + tool + "）：" + String((e && e.message) || e));
      } catch {}
      return "unavailable";
    } finally {
      // 无论结果如何都要撤掉，否则这张表会一直长，也会让过期的 callId
      // 还能查到工具名，进而让客户端对着一个不存在的审批显示按钮。
      if (askKey) pendingAsks.delete(askKey);
    }
  }

  // 审批回执文案。返回 null 表示「这次没有发生需要告诉模型的审批决策」。
  //
  // 为什么必须回执：审批发生在 UI，模型侧完全不可见——它无法区分「用户点了
  // 允许一次」「这工具本来免审批」「本对话内已授权」这三种情况，也就无法判断
  // 后续同类调用会不会再次打断用户。一行回执把这件事补上。
  const approvalReceipt = (decision) => {
    switch (decision) {
      case "follow:allowed": return "审批：本次已由用户允许一次（下次仍会询问）";
      case "ask:allowed": return "审批：本次已由用户允许一次（下次仍会询问）";
      case "grant": return "审批：本对话内已授权，本次未再次询问";
      case "follow:never": return "审批：当前策略为 never，未弹窗直接放行";
      case "allow": return "审批：该工具在面板中设为免审批，未弹窗";
      case "panel": return "审批：面板调试调用，视为已授权";
      default: return null;
    }
  };

  // 把回执拼进**已存在的最后一个 text block**，而不是追加新 block。
  //
  // 两次现场失败记录决定了这里的形状：
  //   1) 追加 {type:"text"} 新块 → 模型侧看不到；
  //   2) 改成拼进 content 的 text block → 记录 receipt:"skipped:object"，
  //      说明拿到的对象根本没有 content 数组，我此前假设的 MCP 形状是错的。
  // 所以这里不再猜形状：handled 与 result 都试（next() 可能返回空对象，
  // 真载荷在 result 里），并把候选的真实键名写进记录——一次失败就能定位。
  function appendToContent(base, receipt) {
    const content = base.content;
    if (!Array.isArray(content) || !content.length) return null;
    for (let i = content.length - 1; i >= 0; i -= 1) {
      const block = content[i];
      if (block && block.type === "text" && typeof block.text === "string") {
        const next = content.slice();
        next[i] = { ...block, text: block.text + "\n[" + receipt + "]" };
        return { ...base, content: next };
      }
    }
    return { ...base, content: [...content, { type: "text", text: "\n[" + receipt + "]" }] };
  }

  function applyReceipt(base, receipt) {
    if (typeof base === "string") return { value: base + "\n[" + receipt + "]", via: "string" };
    if (!base || typeof base !== "object") return { value: null, via: "typeof:" + typeof base };
    const direct = appendToContent(base, receipt);
    if (direct) return { value: direct, via: "content" };
    for (const key of ["result", "data", "value", "output", "payload"]) {
      const inner = base[key];
      if (typeof inner === "string") return { value: { ...base, [key]: inner + "\n[" + receipt + "]" }, via: key + ":string" };
      if (inner && typeof inner === "object") {
        const nested = appendToContent(inner, receipt);
        if (nested) return { value: { ...base, [key]: nested }, via: key + ":content" };
      }
    }
    for (const key of ["text", "output", "message", "content"]) {
      if (typeof base[key] === "string") return { value: { ...base, [key]: base[key] + "\n[" + receipt + "]" }, via: key + ":string" };
    }
    return { value: null, via: "keys:" + Object.keys(base).slice(0, 10).join(",") };
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
    // 回执追加到结果内容之后，而不是替换它：失败结果同样需要这行，
    // 否则「被拒绝」和「工具自己报错」在模型眼里会变成同一件事。
    if (meta) {
      let note = "";
      if (receipt) {
        // handled 优先，但它可能是 next() 给的空对象；真载荷常在 result。
        const tries = [handled, result];
        const seen = [];
        for (const candidate of tries) {
          try {
            const applied = applyReceipt(candidate, receipt);
            if (applied.value) {
              handled = applied.value;
              note = "ok:" + applied.via;
              break;
            }
            seen.push(applied.via);
          } catch {
            seen.push("throw");
          }
        }
        if (!note) note = "miss:" + seen.join("|");
      }
      try {
        appendRecord({
          ts: new Date().toISOString(),
          t: Date.now(),
          server: meta.serverName,
          source: "agent",
          tool: meta.tool,
          decision: meta.decision,
          ok: !(result && result.isError),
          ms: Date.now() - meta.t0,
          args: meta.args,
          error: result && result.isError ? resultText(result).slice(0, 500) : "",
          receipt: note
        });
      } catch {}
    }
    if (failure) throw failure;
    return handled;
  };

  disposers.push(ctx.on("tools/pre-execute", onPre));
  disposers.push(ctx.on("tools/post-execute", onPost));

  // 会话结束即释放该会话的授权，语义与官方 allowed-once 的会话边界一致：
  // 授权不跨对话延续，也就不会在用户下次打开新对话时静默免询问。
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

  // 必须注册一个真正能停掉定时器的 disposer。直接把 timer 对象塞进 disposers
  // 的话，卸载时 off && off() 会对 setInterval 句柄调用 off()，抛 TypeError 被
  // 吞掉——于是每次热更新就多一个每 5 秒跑一次的重连循环。
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
