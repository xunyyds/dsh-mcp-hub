const BRIDGE_TOOL_NAME = "mcp_hub_tools";

const MAX_SESSIONS = 2000;

const CJK_RE = /[\u3400-\u9FFF]/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordRegExp(word) {
  return new RegExp("(^|[^A-Za-z0-9])" + escapeRe(word) + "(?:es|s)?(?![A-Za-z0-9])", "i");
}

function extRegExp(ext) {
  return new RegExp("\\." + escapeRe(ext) + "(?![A-Za-z0-9])", "i");
}

function signal(id, kind, label) {
  return {
    id,
    kind,
    label: label || (kind === "cjk" ? id : null),
    re: kind === "word" ? wordRegExp(id) : kind === "ext" ? extRegExp(id) : null
  };
}

const SIGNALS = [
  signal("adb", "word", "设备"),
  signal("logcat", "word", "日志"),
  signal("tombstone", "word", "崩溃"),
  signal("anr", "word", "崩溃"),
  signal("emulator", "word", "模拟器"),
  signal("avd", "word", "模拟器"),
  signal("uiautomator", "sub", "界面"),
  signal("android", "word", "设备"),
  signal("模拟器", "cjk"),
  signal("安卓", "cjk"),
  signal("设备", "cjk"),
  signal("手机", "cjk"),
  signal("so", "ext", "二进制"),
  signal("dex", "ext", "二进制"),
  signal("apk", "ext", "安装包"),
  signal("elf", "ext", "二进制"),
  signal("native", "word"),
  signal("jni", "word", "二进制"),
  signal("il2cpp", "sub", "二进制"),
  signal("ndk", "word", "二进制"),
  signal("hook", "word", "注入"),
  signal("frida", "word", "注入"),
  signal("gdb", "word", "调试"),
  signal("lldb", "word", "调试"),
  signal("objdump", "word", "反汇编"),
  signal("readelf", "word", "二进制"),
  signal("dalvik", "word", "二进制"),
  signal("smali", "sub", "反编译"),
  signal("jadx", "word", "反编译"),
  signal("apktool", "word", "反编译"),
  signal("disasm", "sub", "反汇编"),
  signal("disassembl", "sub", "反汇编"),
  signal("decompil", "sub", "反编译"),
  signal("pseudocode", "word", "伪代码"),
  signal("symbol", "word", "符号"),
  signal("xref", "word", "交叉引用"),
  signal("callgraph", "word", "调用图"),
  signal("backtrace", "word", "调用栈"),
  signal("反汇编", "cjk"),
  signal("反编译", "cjk"),
  signal("伪代码", "cjk"),
  signal("符号", "cjk"),
  signal("交叉引用", "cjk"),
  signal("调用图", "cjk"),
  signal("调用栈", "cjk"),
  signal("堆栈", "cjk"),
  signal("crash", "word", "崩溃"),
  signal("崩溃", "cjk"),
  signal("闪退", "cjk"),
  signal("卡死", "cjk"),
  signal("log", "word", "日志"),
  signal("dmesg", "word", "日志"),
  signal("syslog", "word", "日志"),
  signal("日志", "cjk"),
  signal("screenshot", "word", "截图"),
  signal("截图", "cjk"),
  signal("click", "word", "点击"),
  signal("点击", "cjk"),
  signal("swipe", "word", "滑动"),
  signal("滑动", "cjk"),
  signal("scroll", "word", "滚动"),
  signal("滚动", "cjk"),
  signal("keyboard", "word", "键盘"),
  signal("输入", "cjk"),
  signal("键盘", "cjk"),
  signal("窗口", "cjk"),
  signal("install", "word", "安装"),
  signal("uninstall", "word", "卸载"),
  signal("permission", "word", "权限"),
  signal("安装", "cjk"),
  signal("卸载", "cjk"),
  signal("权限", "cjk"),
  signal("ffmpeg", "word", "媒体"),
  signal("subtitle", "word", "字幕"),
  signal("timeline", "word", "时间线"),
  signal("transcode", "word", "转码"),
  signal("字幕", "cjk"),
  signal("剪辑", "cjk"),
  signal("时间线", "cjk"),
  signal("转码", "cjk"),
  signal("视频", "cjk"),
  signal("音频", "cjk"),
  signal("渲染", "cjk")
];

const SIGNAL_BY_ID = new Map(SIGNALS.map((s) => [s.id, s]));

const EXT_NAMES = new Set(["so", "dex", "apk", "elf", "oat", "vdex"]);

export function extractSignals(text) {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const out = [];
  for (const sig of SIGNALS) {
    const hit = sig.kind === "word" || sig.kind === "ext"
      ? sig.re.test(raw)
      : lower.includes(sig.id);
    if (hit) out.push(sig.id);
  }
  return out;
}

function compileTrigger(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^\*+/, "");
  if (s.startsWith(".")) {
    const ext = s.slice(1);
    if (!/^[a-z0-9]+$/.test(ext)) return null;
    return { key: "ext:" + ext, raw, kind: "ext", text: ext, re: extRegExp(ext), label: labelOfToken(ext, "ext") };
  }
  if (EXT_NAMES.has(s)) {
    return { key: "ext:" + s, raw, kind: "ext", text: s, re: extRegExp(s), label: labelOfToken(s, "ext") };
  }
  if (CJK_RE.test(s)) {
    return { key: "cjk:" + s, raw, kind: "cjk", text: s, re: null, label: labelOfToken(s, "cjk") };
  }
  if (/^[a-z0-9_+-]+$/.test(s)) {
    return { key: "word:" + s, raw, kind: "word", text: s, re: wordRegExp(s), label: labelOfToken(s, "word") };
  }
  return { key: "sub:" + s, raw, kind: "sub", text: s, re: null, label: labelOfToken(s, "sub") };
}

function labelOfToken(text, kind) {
  const known = SIGNAL_BY_ID.get(text);
  if (known && known.label) return known.label;
  if (CJK_RE.test(text)) return text;
  if (kind === "word" && text.length <= 12) return text;
  return null;
}

function triggerHits(spec, text, lower) {
  if (spec.kind === "cjk" || spec.kind === "sub") return lower.includes(spec.text);
  return spec.re.test(text);
}

function labelsOf(hits) {
  const out = [];
  for (const t of hits) {
    const label = t.label;
    if (!label || out.includes(label)) continue;
    out.push(label);
  }
  return out;
}

function normalizeIndex(index) {
  const servers = [];
  const seen = new Set();
  const list = index && typeof index === "object" && Array.isArray(index.servers) ? index.servers : [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const server = normalizeServerName(raw.server);
    if (!server || seen.has(server)) continue;
    const triggers = [];
    const keys = new Set();
    for (const t of Array.isArray(raw.triggers) ? raw.triggers : []) {
      const spec = compileTrigger(t);
      if (!spec || keys.has(spec.key)) continue;
      keys.add(spec.key);
      triggers.push(spec);
    }
    if (!triggers.length) continue;
    const features = [];
    for (const f of Array.isArray(raw.features) ? raw.features : []) {
      if (typeof f !== "string") continue;
      const text = f.trim();
      if (text && !features.includes(text)) features.push(text);
    }
    const count = Math.round(Number(raw.toolCount));
    seen.add(server);
    servers.push({
      server,
      toolCount: Number.isFinite(count) && count > 0 ? count : 0,
      features,
      triggers
    });
  }
  const df = new Map();
  for (const s of servers) {
    for (const t of s.triggers) df.set(t.key, (df.get(t.key) || 0) + 1);
  }
  return { servers, df };
}

function normalizeServerName(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.trim().toLowerCase().replace(/^mcp__+/, "").replace(/__+$/, "");
  return s;
}

function usedSetOf(usedServers) {
  const set = new Set();
  for (const raw of Array.isArray(usedServers) ? usedServers : []) {
    const name = normalizeServerName(raw);
    if (!name) continue;
    set.add(name);
    const head = name.split("__")[0];
    if (head && head !== name) set.add(head);
  }
  return set;
}

function renderHint(cand) {
  const words = classWords(cand);
  const desc = words.length ? words.join("/") + "类工具" : "工具";
  let count = "";
  if (cand.toolCount > 0) count = cand.toolCount + " 个" + (CJK_RE.test(desc) ? "" : " ");
  return "提示：" + cand.server + " 有 " + count + desc +
    "，可用 " + BRIDGE_TOOL_NAME + "(query=\"" + queryWord(cand) + "\") 查看";
}

function classWords(cand) {
  const related = [];
  for (const f of cand.features) {
    for (const l of cand.labels) {
      if (f.includes(l) || l.includes(f)) {
        related.push(f);
        break;
      }
    }
  }
  const out = [];
  for (const w of related.concat(cand.features, cand.labels)) {
    if (out.length >= 2) break;
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

function queryWord(cand) {
  const pool = cand.labels.concat(cand.features, [cand.server]);
  for (const w of pool) {
    if (w && CJK_RE.test(w)) return w;
  }
  return pool.find(Boolean) || cand.server;
}

function compareCand(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length;
  return a.server < b.server ? -1 : a.server > b.server ? 1 : 0;
}

const RELIEF_PATTERNS = [
  /找不到(?:任何|可用|合适|好用|相关)?的?工具/,
  /没(?:有|有可用|有合适|有好用的?)(?:任何|可用|合适|好用)?的?工具/,
  /不知道(?:该|要)?(?:用|找)(?:哪|什么)?个?工具/,
  /tools?\s+(?:is\s+|are\s+)?(?:not\s+available|missing)/i,
  /no\s+such\s+tool/i,
  /can\s*['\u2019]?t\s+find\s+(?:a|any|the)\s+tool/i,
  /cannot\s+find\s+(?:a|any|the)\s+tool/i,
  /no\s+(?:available|usable)\s+tools?/i
];

function isRelief(lower) {
  for (const re of RELIEF_PATTERNS) {
    if (re.test(lower)) return true;
  }
  return false;
}

function sessionKey(sessionId) {
  if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
  if (typeof sessionId === "number" && Number.isFinite(sessionId)) return "n:" + sessionId;
  return "";
}

function clampInt(v, lo, hi, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export function createJitHinter(options) {
  const opts = options && typeof options === "object" ? options : {};
  const perTurn = clampInt(opts.perTurn, 1, 3, 1);
  const readLimit = (v, lo, hi, fallback) => (typeof v === "function" ? clampInt(v(), lo, hi, fallback) : clampInt(v, lo, hi, fallback));
  const maxPerServerOf = () => readLimit(opts.maxPerServer, 1, 20, 1);
  const maxTotalOf = () => readLimit(opts.maxTotal, 1, 50, 3);

  const indexSource = opts.index;
  const sessions = new Map();
  let cachedRaw = null;
  let cached = normalizeIndex(null);

  function currentIndex() {
    let raw = indexSource;
    if (typeof indexSource === "function") {
      try {
        raw = indexSource();
      } catch {
        raw = null;
      }
    }
    if (raw === cachedRaw) return cached;
    const sig = raw && typeof raw === "object" ? raw.signature : null;
    if (sig && cachedRaw && typeof cachedRaw === "object" && cachedRaw.signature === sig) return cached;
    cachedRaw = raw;
    cached = normalizeIndex(raw);
    return cached;
  }

  function sessionOf(sessionId) {
    const key = sessionKey(sessionId);
    const hit = sessions.get(key);
    if (hit) return hit;
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next();
      if (!oldest.done) sessions.delete(oldest.value);
    }
    const st = { key, turns: 0, hints: 0, released: false, byServer: new Map(), lastText: null };
    sessions.set(key, st);
    return st;
  }

  function hintFor(input) {
    try {
      return hintForUnsafe(input);
    } catch {
      return "";
    }
  }

  function hintForUnsafe(input) {
    const arg = input && typeof input === "object" ? input : {};
    const st = sessionOf(arg.sessionId);
    st.turns += 1;
    const text = typeof arg.text === "string" ? arg.text : "";
    if (!text) return "";
    const lower = text.toLowerCase();

    if (isRelief(lower)) st.released = true;

    if (!st.released && st.lastText === text) return "";

    const idx = currentIndex();
    if (!idx.servers.length) return "";
    const maxTotal = maxTotalOf();
    const maxPerServer = maxPerServerOf();
    if (!st.released && st.hints >= maxTotal) return "";

    const used = usedSetOf(arg.usedServers);
    const cands = [];
    for (const s of idx.servers) {
      if (used.has(s.server)) continue;
      const said = st.byServer.get(s.server) || 0;
      if (!st.released && said >= maxPerServer) continue;
      const hits = [];
      let score = 0;
      for (const t of s.triggers) {
        if (!triggerHits(t, text, lower)) continue;
        hits.push(t);
        score += 1 / (idx.df.get(t.key) || 1);
      }
      if (!hits.length) continue;
      cands.push({
        server: s.server,
        toolCount: s.toolCount,
        features: s.features,
        hits,
        score,
        labels: labelsOf(hits)
      });
    }
    if (!cands.length) return "";

    cands.sort(compareCand);
    const chosen = cands.slice(0, perTurn);
    const lines = chosen.map(renderHint);

    st.hints += lines.length;
    for (const c of chosen) st.byServer.set(c.server, (st.byServer.get(c.server) || 0) + 1);
    st.lastText = text;
    return lines.join("\n");
  }

  function reset(sessionId) {
    if (sessionId === undefined || sessionId === null) {
      sessions.clear();
      return;
    }
    sessions.delete(sessionKey(sessionId));
  }

  function stats() {
    let turns = 0;
    let hints = 0;
    let released = 0;
    const byServer = {};
    for (const st of sessions.values()) {
      turns += st.turns;
      hints += st.hints;
      if (st.released) released += 1;
      for (const [name, n] of st.byServer) byServer[name] = (byServer[name] || 0) + n;
    }
    return {
      sessions: sessions.size,
      turns,
      hints,
      released,
      byServer,
      budget: { perTurn, maxPerServer: maxPerServerOf(), maxTotal: maxTotalOf() }
    };
  }

  return { hintFor, reset, stats };
}
