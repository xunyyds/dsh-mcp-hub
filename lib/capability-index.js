import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const INDEX_VERSION = 1;

const MAX_INLINE_SERVERS = 8;

const MAX_FEATURES = 8;
const MAX_RENDER_FEATURES = 5;

const COMMON_COVERAGE = 0.8;

const PARAM_MAX_DEPTH = 3;

const HAN_STOP = new Set(
  Array.from("的了着过是在于与和或及乃就是个这那就也都还又会被把从到为以等于上下时后前里外可要能不对没无有些什么之其而且然则因所如果并再次该每某任何与么很太更最两者这那")
);

const EN_STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "by", "for",
  "with", "from", "into", "onto", "over", "under", "as", "is", "are", "was",
  "were", "be", "been", "being", "it", "its", "this", "that", "these",
  "those", "if", "then", "than", "so", "but", "not", "no", "do", "does",
  "did", "has", "have", "had", "will", "would", "can", "could", "should",
  "may", "might", "must", "when", "while", "where", "which", "who", "whom",
  "whose", "what", "how", "why", "all", "any", "each", "every", "some",
  "such", "only", "also", "more", "most", "other", "same", "very", "just",
  "both", "either", "neither", "per", "via", "one", "two", "own", "out",
  "up", "down", "off", "again", "once", "here", "there", "now", "yet",
  "still", "until", "unless", "whether", "within", "without", "upon",
  "any", "called", "using", "used", "use", "e", "g", "i", "etc"
]);

const BRIDGE = new Map([
  ["adb", "设备"],
  ["device", "设备"],
  ["emulator", "模拟器"],
  ["simulator", "模拟器"],
  ["screenshot", "截图"],
  ["screen", "屏幕"],
  ["logcat", "日志"],
  ["log", "日志"],
  ["crash", "崩溃"],
  ["tombstone", "崩溃"],
  ["install", "安装"],
  ["uninstall", "卸载"],
  ["launch", "启动"],
  ["terminate", "关闭"],
  ["clipboard", "剪贴板"],
  ["swipe", "滑动"],
  ["click", "点击"],
  ["tap", "点击"],
  ["type", "输入"],
  ["disasm", "反汇编"],
  ["disassemble", "反汇编"],
  ["symbol", "符号"],
  ["binary", "二进制"],
  ["apk", "安卓"],
  ["dex", "安卓"],
  ["so", "二进制"],
  ["elf", "二进制"],
  ["dylib", "二进制"],
  ["source", "源码"],
  ["compare", "对比"],
  ["function", "函数"],
  ["address", "地址"],
  ["system", "系统"],
  ["text", "文本"],
  ["coordinate", "坐标"],
  ["orientation", "方向"],
  ["timeline", "时间轴"],
  ["track", "轨道"],
  ["project", "项目"],
  ["clip", "剪辑"],
  ["video", "视频"],
  ["render", "渲染"],
  ["export", "导出"],
  ["file", "文件"],
  ["process", "进程"],
  ["memory", "内存"],
  ["network", "网络"],
  ["registry", "注册表"],
  ["window", "窗口"]
]);

const SIGNAL_WORDS = [
  "adb", "logcat", "tombstone", "anr", "crash", "emulator", "simulator",
  "il2cpp", "unity", "frida", "lldb", "gdb", "dwarf", "macho", "objdump",
  "disasm", "disassemble", "backtrace", "symbol", "binary", "screenshot",
  "install", "uninstall", "clipboard", "swipe", "apk", "dex", "elf",
  "timeline", "clip", "export", "render", "project", "video", "track",
  "device", "screen", "app", "bundle", "file", "process", "memory",
  "network", "registry", "window", "coordinates", "orientation"
];

const EXTENSION_SIGNALS = ["so", "dylib", "ipa", "jar", "aar"];

const MAX_TRIGGERS = 8;
const MIN_TRIGGERS = 3;

const HEAD_WEIGHT = 4;
const MIDDLE_WEIGHT = 2;
const VERB_WEIGHT = 1;

const BRIDGE_BOOST = 1.5;


const HAN_SEGMENT = /([\p{Script=Han}]+)/u;
const HAN_TEST = /\p{Script=Han}/u;

function hanTokens(run) {
  const out = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    for (let i = 0; i + 1 < buf.length; i += 1) out.push(buf.slice(i, i + 2));
    buf = "";
  };
  for (const ch of run) {
    if (HAN_STOP.has(ch)) flush();
    else buf += ch;
  }
  flush();
  return out;
}

function tokenize(raw) {
  const text = String(raw || "");
  const out = [];
  for (const seg of text.split(HAN_SEGMENT)) {
    if (!seg) continue;
    if (HAN_TEST.test(seg)) {
      for (const t of hanTokens(seg)) out.push(t);
      continue;
    }
    for (const word of seg.split(/[^A-Za-z0-9]+/)) {
      if (!word) continue;
      for (const part of word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ")) {
        let low = part.toLowerCase();
        if (low.length < 2) continue;
        if (EN_STOP.has(low)) continue;
        if (low.length > 3 && !/(ss|us|is)$/.test(low)) {
          if (low.endsWith("es") && /(s|x|z|ch|sh)es$/.test(low)) low = low.slice(0, -2);
          else if (low.endsWith("s")) low = low.slice(0, -1);
        }
        if (low.length >= 2 && !EN_STOP.has(low)) out.push(low);
      }
    }
  }
  return out;
}

function collectParameterNames(schema, depth, out) {
  if (!schema || typeof schema !== "object" || depth >= PARAM_MAX_DEPTH) return;
  const props = schema.properties;
  if (!props || typeof props !== "object") return;
  for (const key of Object.keys(props)) {
    out.push(key);
    collectParameterNames(props[key], depth + 1, out);
  }
}

const NAME_PREPOSITIONS = new Set([
  "on", "at", "to", "in", "into", "with", "for", "from", "by", "of",
  "onto", "over", "under", "within", "without", "upon", "via", "per"
]);

function corpusTokens(tool, serverName) {
  const out = [];
  const name = String((tool && tool.name) || "");
  let bare = name;
  const prefix = String(serverName || "") + "_";
  if (serverName && bare.toLowerCase().startsWith(prefix.toLowerCase())) bare = bare.slice(prefix.length);

  const rawWords = bare.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const flat = [];
  for (const w of rawWords) {
    for (const part of w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ")) {
      if (part) flat.push(part);
    }
  }
  const prepAt = flat.findIndex((w) => NAME_PREPOSITIONS.has(w.toLowerCase()));
  const last = flat.length - 1;
  for (let i = 0; i < flat.length; i += 1) {
    let pos;
    if (prepAt >= 0 && i > prepAt) pos = 1;
    else if (i === last) pos = 2;
    else if (i === 0) pos = 0;
    else pos = 1;
    for (const t of tokenize(flat[i])) out.push({ term: t, channels: { name: true, pos } });
  }

  const description = String((tool && tool.description) || "");
  for (const t of tokenize(description)) out.push({ term: t, channels: { desc: true } });
  const params = [];
  collectParameterNames(tool && tool.parameters, 0, params);
  for (const p of params) {
    for (const t of tokenize(p)) out.push({ term: t, channels: { param: true } });
  }
  return out;
}


function stableStringify(value, depth) {
  const d = depth || 0;
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(value);
  if (d > 8) return "\"…\"";
  if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v, d + 1)).join(",") + "]";
  if (t === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k], d + 1)).join(",") + "}";
  }
  return "null";
}

function signatureOf(servers) {
  try {
    const list = Array.isArray(servers) ? servers.slice() : [];
    list.sort((a, b) => {
      const x = String((a && a.server) || "");
      const y = String((b && b.server) || "");
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const lines = ["v" + INDEX_VERSION];
    for (const s of list) {
      lines.push("S:" + String((s && s.server) || ""));
      const tools = Array.isArray(s && s.tools) ? s.tools.slice() : [];
      tools.sort((a, b) => {
        const x = String((a && a.name) || "");
        const y = String((b && b.name) || "");
        return x < y ? -1 : x > y ? 1 : 0;
      });
      for (const t of tools) {
        lines.push("T:" + String((t && t.name) || ""));
        lines.push("D:" + String((t && t.description) || "").replace(/\s+/g, " ").trim());
        lines.push("P:" + stableStringify(t && t.parameters));
      }
    }
    return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
  } catch {
    return "signature-unavailable";
  }
}


function localRarity(stat, toolCount) {
  if (!toolCount || !stat.df) return 1;
  return Math.sqrt(toolCount / stat.df);
}

function isParameterDimension(stat) {
  if (!stat.inParam) return false;
  return stat.paramDf >= stat.nameDf;
}

function isHanTerm(term) {
  return HAN_TEST.test(term);
}

function featureScore(stat, serverCount, toolCount) {
  const spread = Math.max(1, stat.servers.size);
  const cross = Math.log(1 + serverCount / spread);
  const local = localRarity(stat, toolCount);

  if (isHanTerm(stat.term)) {
    if (!stat.df) return 0;
    return stat.df * local * cross;
  }
  let base;
  if (stat.nameDf > 0) {
    const slot = stat.bestPos === 2 ? HEAD_WEIGHT : stat.bestPos === 1 ? MIDDLE_WEIGHT : VERB_WEIGHT;
    const exclusivity = 1 / Math.sqrt(stat.nameDf);
    base = slot * exclusivity;
  } else {
    base = 0.3;
  }
  let score = base * local * cross;
  if (isParameterDimension(stat)) score *= 0.5;
  if (!BRIDGE.has(stat.term)) score *= 0.33;
  return score;
}

function triggersOf(text, seen) {
  const out = [];
  const tokens = new Set(tokenize(text));
  const lower = String(text || "").toLowerCase();
  for (const word of SIGNAL_WORDS) {
    if (tokens.has(word) && !seen.has(word)) {
      out.push(word);
      seen.add(word);
    }
    if (out.length >= MAX_TRIGGERS) return out;
  }
  for (const word of EXTENSION_SIGNALS) {
    if (out.length >= MAX_TRIGGERS) break;
    if (seen.has(word)) continue;
    const re = new RegExp("\\." + word + "(?:$|[^A-Za-z0-9])", "m");
    if (re.test(lower)) {
      out.push("." + word);
      seen.add(word);
    }
  }
  return out;
}

function padTriggers(triggers, features) {
  if (triggers.length >= MIN_TRIGGERS) return triggers;
  const seen = new Set(triggers);
  for (const f of features) {
    if (triggers.length >= MIN_TRIGGERS) break;
    if (!f || seen.has(f)) continue;
    triggers.push(f);
    seen.add(f);
  }
  return triggers.slice(0, MAX_TRIGGERS);
}

function buildCapabilityIndex(servers, options) {
  const opts = options && typeof options === "object" ? options : {};
  const builtAt = Number.isFinite(opts.now) ? opts.now : Date.now();
  const list = Array.isArray(servers) ? servers : [];

  const prepared = [];
  const globalSpread = new Map();
  for (const s of list) {
    const name = String((s && s.server) || "");
    const tools = Array.isArray(s && s.tools) ? s.tools : [];
    const selfWords = new Set(tokenize(name));
    const stats = new Map();
    const raw = [];
    for (const tool of tools) {
      const entries = corpusTokens(tool, name);
      raw.push(String((tool && tool.name) || "") + " " + String((tool && tool.description) || ""));
      const touched = new Set();
      const touchedInName = new Set();
      const touchedInParam = new Set();
      for (const e of entries) {
        if (e.term.length < 2 || selfWords.has(e.term)) continue;
        let stat = stats.get(e.term);
        if (!stat) {
          stat = { term: e.term, df: 0, nameDf: 0, paramDf: 0, inName: false, inDesc: false, inParam: false, bestPos: -1, servers: new Set() };
          stats.set(e.term, stat);
        }
        if (e.channels.name) {
          stat.inName = true;
          if (e.channels.pos > stat.bestPos) stat.bestPos = e.channels.pos;
          if (!touchedInName.has(e.term)) {
            touchedInName.add(e.term);
            stat.nameDf += 1;
          }
        }
        if (e.channels.desc) stat.inDesc = true;
        if (e.channels.param) {
          stat.inParam = true;
          if (!touchedInParam.has(e.term)) {
            touchedInParam.add(e.term);
            stat.paramDf += 1;
          }
        }
        if (!touched.has(e.term)) {
          touched.add(e.term);
          stat.df += 1;
        }
      }
    }
    for (const term of stats.keys()) {
      const set = globalSpread.get(term) || new Set();
      set.add(name);
      globalSpread.set(term, set);
    }
    prepared.push({ server: name, tools, stats, raw });
  }

  const serverCount = Math.max(1, list.length);

  const out = [];
  for (const p of prepared) {
    const merged = new Map();
    for (const stat of p.stats.values()) {
      const spread = (globalSpread.get(stat.term) || new Set()).size;
      if (serverCount > 1 && spread / serverCount >= COMMON_COVERAGE) continue;
      const score = featureScore(stat, serverCount, p.tools.length);
      if (score <= 0) continue;
      const label = BRIDGE.get(stat.term) || stat.term;
      const prev = merged.get(label);
      if (prev) {
        prev.score += score;
      } else {
        const boost = BRIDGE.has(stat.term) ? BRIDGE_BOOST : 1;
        merged.set(label, { term: label, score: score * boost, source: stat.term });
      }
    }

    const scored = Array.from(merged.values());
    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.term < b.term ? -1 : a.term > b.term ? 1 : 0));

    const picked = scored.slice(0, MAX_FEATURES);

    out.push({
      server: p.server,
      toolCount: p.tools.length,
      features: picked.map((x) => x.term),
      triggers: padTriggers(triggersOf(p.raw.join(" "), new Set()), picked.map((x) => x.term))
    });
  }

  out.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));

  return { version: INDEX_VERSION, signature: signatureOf(list), builtAt, servers: out };
}


function summaryText(index, options) {
  const opts = options && typeof options === "object" ? options : {};
  const servers = Array.isArray(index && index.servers) ? index.servers : [];
  if (!servers.length) return "";

  const maxFeatures = Number.isFinite(opts.maxFeatures) ? opts.maxFeatures : MAX_RENDER_FEATURES;
  const maxServers = Number.isFinite(opts.maxServers) ? opts.maxServers : MAX_INLINE_SERVERS;

  const sorted = servers.slice().sort((a, b) => {
    const x = String((a && a.server) || "");
    const y = String((b && b.server) || "");
    return x < y ? -1 : x > y ? 1 : 0;
  });

  if (sorted.length > maxServers) return compressSummary(sorted, opts);

  const lines = [];
  for (const s of sorted) {
    const name = String((s && s.server) || "");
    if (!name) continue;
    const count = Number.isFinite(s && s.toolCount) ? s.toolCount : 0;
    const features = Array.isArray(s && s.features) ? s.features : [];
    const triggers = Array.isArray(s && s.triggers) ? s.triggers : [];
    const shown = (features.length ? features : triggers).slice(0, Math.max(0, maxFeatures));
    lines.push(name + "（" + count + " 工具）" + (shown.length ? "：" + shown.join("·") : ""));
  }
  return lines.join("\n");
}

function compressSummary(servers, opts) {
  const total = servers.reduce((sum, s) => sum + (Number.isFinite(s && s.toolCount) ? s.toolCount : 0), 0);
  const groups = new Map();
  for (const s of servers) {
    const name = String((s && s.server) || "");
    if (!name) continue;
    const head = /^[A-Za-z]/.test(name) ? name[0].toLowerCase() : "#";
    const g = groups.get(head) || { count: 0, tools: 0 };
    g.count += 1;
    g.tools += Number.isFinite(s && s.toolCount) ? s.toolCount : 0;
    groups.set(head, g);
  }
  const heads = Array.from(groups.keys()).sort((a, b) => (a === "#" ? 1 : b === "#" ? -1 : a < b ? -1 : a > b ? 1 : 0));
  const parts = heads.map((h) => {
    const g = groups.get(h);
    return (h === "#" ? "其它" : h + "*") + " " + g.count + " 台/" + g.tools + " 工具";
  });
  const query = opts && typeof opts.queryHint === "string" && opts.queryHint ? opts.queryHint : "反汇编";
  return [
    "MCP 共 " + servers.length + " 台服务器、" + total + " 个工具：" + parts.join("、"),
    "用 mcp_hub_tools({ query: \"<关键词>\" }) 按能力检索，例如 query=\"" + query + "\"。"
  ].join("\n");
}


function isUsableIndex(index) {
  if (!index || typeof index !== "object") return false;
  if (index.version !== INDEX_VERSION) return false;
  if (typeof index.signature !== "string") return false;
  if (!Array.isArray(index.servers)) return false;
  for (const s of index.servers) {
    if (!s || typeof s !== "object") return false;
    if (typeof s.server !== "string" || !s.server) return false;
    if (!Array.isArray(s.features) || !Array.isArray(s.triggers)) return false;
  }
  return true;
}

function readIndexFile(cacheFile) {
  if (!cacheFile) return null;
  try {
    const text = readFileSync(cacheFile, "utf8");
    const parsed = JSON.parse(text);
    return isUsableIndex(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeIndexFile(cacheFile, index) {
  if (!cacheFile) return false;
  const tmp = cacheFile + ".tmp";
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(tmp, JSON.stringify(index), "utf8");
    renameSync(tmp, cacheFile);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
    }
    return false;
  }
}

function loadOrBuildIndex(options) {
  const opts = options && typeof options === "object" ? options : {};
  const cacheFile = typeof opts.cacheFile === "string" ? opts.cacheFile : "";
  const serversProvided = Array.isArray(opts.servers);
  const servers = serversProvided ? opts.servers : [];

  let cached = null;
  try {
    cached = readIndexFile(cacheFile);
  } catch {
    cached = null;
  }

  if (!serversProvided) {
    if (cached) return cached;
    return buildCapabilityIndex([], { now: opts.now });
  }

  const signature = signatureOf(servers);
  if (!opts.force && cached && cached.signature === signature) return cached;

  const fresh = buildCapabilityIndex(servers, { now: opts.now });
  if (servers.length > 0) writeIndexFile(cacheFile, fresh);
  return fresh;
}

export {
  INDEX_VERSION,
  buildCapabilityIndex,
  loadOrBuildIndex,
  signatureOf,
  summaryText
};
