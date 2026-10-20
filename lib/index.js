import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "/mcp-hub";
const PLUGIN_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

// ── 凭证保护 ─────────────────────────────────────────────────
// Token 之前是以明文落在 config.json 与 cordis.patch.yml 里的：任何能读
// profile 的人、任何打包了 profile 的备份、任何误提交的目录，都会把 Token
// 一起带走。这里改成静态加密，密钥只存在本机 storages 目录，与配置文件分离。
//
// 用 AES-256-GCM：密文自带完整性校验，被篡改会解密失败而不是解出垃圾。
// 这不是「防住本机攻击者」的方案——同用户的进程仍能拿到密钥——它防的是
// 凭证随文件扩散：备份、同步盘、误提交、截图。
const CRED_PREFIX = "enc:v1:";
let cachedKey = null;

function credentialKeyPath() {
  return join(configDir(), ".credentials.key");
}

function loadOrCreateKey() {
  if (cachedKey) return cachedKey;
  const file = credentialKeyPath();
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{64}$/i.test(raw)) {
        cachedKey = Buffer.from(raw, "hex");
        return cachedKey;
      }
    }
  } catch {}
  // 没有可用密钥就生成一把，并以仅本人可读的权限落盘。
  const key = randomBytes(32);
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(file, key.toString("hex") + "\n", { encoding: "utf8", mode: 0o600 });
    restrictToOwner(file);
  } catch {}
  cachedKey = key;
  return cachedKey;
}

function encryptSecret(plain) {
  if (typeof plain !== "string" || plain === "") return "";
  const key = loadOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return CRED_PREFIX + Buffer.concat([iv, tag, body]).toString("base64");
}

function decryptSecret(stored) {
  if (typeof stored !== "string" || stored === "") return "";
  // 没有前缀的值是历史遗留的明文：原样返回，下次保存时会被加密。
  if (!stored.startsWith(CRED_PREFIX)) return stored;
  try {
    const buf = Buffer.from(stored.slice(CRED_PREFIX.length), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const body = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", loadOrCreateKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // 密钥换了或密文被改：当作没有凭证，而不是把垃圾当 Token 发出去。
    // 但要留下痕迹——否则用户只会看到「连不上」，无从判断是 Token 丢了。
    decryptFailures.push({ at: Date.now() });
    if (decryptFailures.length > 20) decryptFailures.shift();
    return "";
  }
}

// 解密失败记录，供面板提示「有凭证解不开，请重新填写」。
const decryptFailures = [];

// 落盘前把 Token 换成密文；内存里的 cfg 仍持明文，供连接与调试使用。
function sealServer(server) {
  const copy = JSON.parse(JSON.stringify(server));
  if (copy.token) copy.token = encryptSecret(copy.token);
  return copy;
}

function unsealServer(server) {
  if (server && server.token) {
    const hadCipher = typeof server.token === "string" && server.token.startsWith(CRED_PREFIX);
    server.token = decryptSecret(server.token);
    // 有密文却解出空：密钥不匹配或密文损坏。标记出来让面板能提示重填，
    // 而不是让用户对着「连不上」猜。
    if (hadCipher && !server.token) server.__tokenUnreadable = true;
  }
  return server;
}

// 把文件权限收紧到「只有当前用户」。Windows 上用 icacls，失败就静默跳过：
// 加密本身已经保证了内容不可读，权限只是再加一道。
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
    tools: {}
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

function normalizeServer(raw) {
  const d = defaultServer();
  const s = Object.assign(d, raw || {});
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

const DEFAULT_CONFIG = { profile: "", approval: { followDsh: true }, servers: [] };

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
      return { profile: "", approval: normalizeApproval(), servers: [] };
    }
    const raw = migrateLegacy(JSON.parse(readFileSync(configPath(), "utf8") || "{}"));
    const cfg = { profile: String(raw.profile || ""), approval: normalizeApproval(raw.approval), servers: [] };
    const list = Array.isArray(raw.servers) ? raw.servers : [];
    const seen = new Set();
    for (const item of list) {
      // 磁盘上是密文，内存里必须是明文，否则连接与调试都拿不到 Token。
      const s = normalizeServer(unsealServer(item));
      while (seen.has(s.id)) s.id = newServerId();
      seen.add(s.id);
      cfg.servers.push(s);
    }
    return cfg;
  } catch {
    return { profile: "", approval: normalizeApproval(), servers: [] };
  }
}

let cfg = readConfig();

function persist() {
  try {
    mkdirSync(configDir(), { recursive: true });
    // 落盘一律加密：内存里的 cfg 保持明文，只有写文件这一步做封装。
    const onDisk = Object.assign({}, cfg, { servers: cfg.servers.map(sealServer) });
    const file = configPath();
    writeFileSync(file, JSON.stringify(onDisk, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    restrictToOwner(file);
  } catch (e) {}
  return cfg;
}

function findServer(id) {
  if (!id) return cfg.servers[0] || null;
  return cfg.servers.find((s) => s.id === id) || null;
}

function upsertServer(input) {
  const incoming = normalizeServer(input);
  const idx = cfg.servers.findIndex((s) => s.id === incoming.id);
  if (idx >= 0) {
    cfg.servers[idx] = incoming;
  } else {
    const dup = cfg.servers.some((s) => s.name === incoming.name);
    if (dup) throw new Error("服务器名已存在：" + incoming.name);
    cfg.servers.push(incoming);
  }
  persist();
  return incoming;
}

function removeServer(id) {
  const before = cfg.servers.length;
  cfg.servers = cfg.servers.filter((s) => s.id !== id);
  if (cfg.servers.length !== before) {
    conns.delete(id);
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
    writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n", "utf8");
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

function findProfiles() {
  const base = process.env.DSH_HOME || join(homedir(), ".dsh");
  const out = [];
  try {
    for (const p of readdirSync(join(base, "profiles"))) {
      try {
        const pj = JSON.parse(readFileSync(join(base, "profiles", p, "package.json"), "utf8"));
        const deps = Object.assign({}, pj && pj.dependencies, pj && pj.devDependencies);
        if (deps && deps["@dsh-external/dsh-qfun-mcp"]) out.push(p);
      } catch {}
    }
  } catch {}
  return out;
}

function currentProfileDir() {
  const base = process.env.DSH_HOME || join(homedir(), ".dsh");
  if (cfg.profile) return join(base, "profiles", cfg.profile);
  const found = findProfiles();
  if (found.length) return join(base, "profiles", found[0]);
  return join(base, "profiles", "desktop");
}

function patchFilePath() {
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

// patch 里引用的环境变量名。按服务器名派生，稳定且可预期，
// 用户能在自己的启动脚本里设置同名变量。
function tokenEnvName(serverName) {
  return "DSH_MCP_TOKEN_" + String(serverName || "MCP").toUpperCase().replace(/[^A-Z0-9]/g, "_");
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
      // Token 不写进这个文件。patch 支持 !!js 表达式（js-yaml 的自定义
      // scalar tag，激活时在 with(ctx) 作用域里 eval），能读到 process.env。
      //
      // 写法必须严格：tag 后面紧跟单引号包裹的标量，内部再用模板字符串。
      // 实测（用 DSH 自己的 js-yaml + JSON_SCHEMA.extend(JsExpr)）：
      //   '!!js \`...\`'   → 退化成字面量字符串，token 变成那段源码
      //   !!js \`...\`     → 解析失败（反引号在 YAML 里是保留字符）
      //   !!js '\`...\`'   → 正确求值
      // 写错的后果是 patch 直接坏掉、DSH 起不来，所以这里不要「顺手改一下」。
      const envName = tokenEnvName(safe);
      lines.push("        headers:");
      lines.push("          Authorization: !!js '`Bearer ${process.env." + envName + " || \"\"}`'");
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
  return { start, end: raw.length };
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
    writePatchText(file, head + "\n");
    return { ok: true, changed: true, file };
  }
  let next;
  if (existing) {
    next = raw.slice(0, existing.start) + block + "\n";
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
  return { ok: true, servers, approval: raw.approval, patch: typeof raw.patch === "string" ? raw.patch : "" };
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
  let patchWritten = false;
  if (v.patch && v.patch.trim()) {
    try {
      writePatchText(patchFilePath(), v.patch);
      patchWritten = true;
    } catch {}
  }
  return { ok: true, mode: replaced ? "replace" : "merge", added, updated, total: cfg.servers.length, patchWritten };
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

  const statusOf = (server) => {
    const c = connFor(server);
    const managed = managedTools(server);
    return {
      managed: usesRegistry(server),
      managedToolCount: managed.length,
      id: server.id,
      ok: true,
      status: c.status,
      transport: server.transport,
      url: server.url,
      command: server.command,
      args: server.args,
      env: server.env,
      tokenConfigured: !!(server.token && server.token !== "none"),
      // 磁盘上有密文但解不开时，token 为空。让面板能说清是「没设」还是「解不开」，
      // 否则用户只会看到连不上而无从下手。
      tokenUnreadable: !!(server.__tokenUnreadable),
      tokenEnv: tokenEnvName(sanitizeName(server.name, "mcp")),
      autoReconnect: server.autoReconnect,
      enabled: server.enabled !== false,
      approvalMode: normalizeApprovalMode(server.approvalMode),
      approvalEffective: effectiveApproval(server),
      serverName: sanitizeName(server.name, "mcp"),
      toolCallTimeoutMs: server.toolCallTimeoutMs,
      latencyMs: c.latencyMs,
      server: c.server,
      toolCount: managed.length || c.tools.length,
      toolsAt: c.toolsAt,
      lastConnectedAt: c.lastConnectedAt,
      lastError: c.lastError,
      attempt: c.attempt,
      nextRetryAt: c.nextRetryAt
    };
  };
  const statusPayload = (server) => Object.assign({ ok: true, profile: cfg.profile, approval: normalizeApproval(cfg.approval), servers: cfg.servers.map(statusOf) }, server ? statusOf(server) : {});

  // 禁用必须单调：pre-execute 只决定 allow/deny/ask，可能被后续 listener 翻案，
  // 而 guard 一旦返回理由就不可逆。这里兜住「面板禁用」的最终否决权。
  const guardOff = (exec) => {
    try {
      const server = serverByToolName(exec && exec.name);
      if (!server) return undefined;
      const tool = exec.name.slice(toolPrefix(server.name).length);
      return policyFor(server, tool).enabled ? undefined : "MCP（" + sanitizeName(server.name, "mcp") + "）：工具 " + tool + " 已在面板中禁用";
    } catch {
      return undefined;
    }
  };
  if (ctx.tools && typeof ctx.tools.guard === "function") disposers.push(ctx.tools.guard(guardOff));

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
    if (method === "DELETE") {
      if (!id) {
        json(res, 400, { ok: false, error: "缺少 id" });
        return;
      }
      const removed = removeServer(id);
      json(res, 200, { ok: removed, removed, servers: cfg.servers.map(statusOf) });
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
        json(res, 200, { ok: true, server: statusOf(saved), servers: cfg.servers.map(statusOf) });
      } catch (e) {
        json(res, 400, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    json(res, 200, { ok: true, profile: cfg.profile, servers: cfg.servers.map(statusOf) });
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
      const saved = upsertServer(Object.assign({}, existing || {}, {
        name,
        transport: discovered.transport,
        url: discovered.url,
        command: discovered.command,
        token: discovered.token,
        enabled: true
      }));
      json(res, 200, { ok: true, id: saved.id, adopted: name, server: statusOf(saved), servers: cfg.servers.map(statusOf) });
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
    if (method === "GET") {
      json(res, 200, Object.assign({ ok: true }, importStatus()));
      return;
    }
    const body = await readBody(req);
    const mode = body.mode === "remove" ? "remove" : "add";
    const result = applyImport(mode);
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
      if (!pol.enabled) {
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
          error: "工具已在面板中禁用"
        });
        return { kind: "deny", reason: "MCP（" + serverName + "）：工具 " + tool + " 已在面板中禁用" };
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
    } catch {
      return next();
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

  const onPost = async (exec, result, next) => {
    try {
      const meta = exec && inFlight.get(exec);
      if (meta) {
        inFlight.delete(exec);
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
          error: result && result.isError ? resultText(result).slice(0, 500) : ""
        });
      }
    } catch {}
    return next();
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

  disposers.push(timer);

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
