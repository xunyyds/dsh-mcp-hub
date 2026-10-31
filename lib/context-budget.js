const TIERS = ["full", "lazy", "off"];

function normalizeTier(v) {
  return TIERS.includes(v) ? v : "full";
}

const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "cf", "al", "fig", "figs", "approx", "dept",
  "inc", "ltd", "corp", "vol", "vols", "pp", "esp", "incl", "excl", "resp"
]);

function endsWithAbbreviation(head) {
  const m = /([A-Za-z][A-Za-z.]*)$/.exec(head);
  if (!m) return false;
  const raw = m[1].toLowerCase().replace(/\.+$/, "");
  if (raw.includes(".")) return true;
  if (raw.length <= 2) return true;
  return ABBREVIATIONS.has(raw);
}

const TITLE_ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "rev", "hon", "gen",
  "col", "maj", "capt", "lt", "sgt", "gov", "sen", "rep", "pres", "supt"
]);

function firstSentence(text, fallback) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return fallback || "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (!".。！!?？".includes(ch)) continue;
    if (ch === "。" || ch === "！" || ch === "？") return s.slice(0, i + 1).trim();
    if (s[i + 1] !== undefined && !/\s/.test(s[i + 1])) continue;
    if (ch === ".") {
      const head = s.slice(0, i + 1);
      if (endsWithAbbreviation(head)) {
        const tail = s.slice(i + 1).trimStart();
        const isTitle = TITLE_ABBREVIATIONS.has((/([A-Za-z][A-Za-z.]*)$/.exec(head)?.[1] || "").toLowerCase().replace(/\.+$/, ""));
        if (isTitle) continue;
        const opens = (head.match(/[([]/g) || []).length;
        const closes = (head.match(/[)\]]/g) || []).length;
        if (opens > closes) continue;
        if (!/^[A-Z]/.test(tail)) continue;
      }
    }
    return s.slice(0, i + 1).trim();
  }
  return s.length > 160 ? s.slice(0, 160).trim() : s.trim();
}

function splitToolName(name) {
  const s = String(name || "");
  if (!s.startsWith("mcp__")) return null;
  const rest = s.slice(5);
  const at = rest.indexOf("__");
  if (at < 0) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

const META_TOOL_PATTERNS = [
  /^get_more_tools$/,
  /^more_tools$/,
  /^list_more_tools$/,
  /^fetch_more_tools$/,
  /^discover_more_tools$/,
  /^load_more_tools$/,
  /^get_tools$/,
  /^list_tools$/
];

function isMetaTool(rawToolName) {
  const name = String(rawToolName || "").trim().toLowerCase();
  if (!name) return false;
  return META_TOOL_PATTERNS.some((re) => re.test(name));
}


const BM25_K1 = 1.2;
const BM25_B = 0.75;

const FIELD_WEIGHT = { name: 3, summary: 1, params: 1.2 };

const ALIAS_WEIGHT = 0.8;

const CAPABILITY_NAME_BOOST = 1.5;

const CJK_WHOLE_MAX = 6;

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

const CAPABILITY_GROUPS = [
  ["崩溃", ["crash", "crashes", "crashed", "崩溃", "闪退"]],
  ["反汇编", ["disasm", "disassemble", "disassembles", "disassembly", "反汇编"]],
  ["反编译", ["decompile", "decompiler", "反编译"]],
  ["符号", ["symbol", "symbols", "符号"]],
  ["截图", ["screenshot", "screenshots", "截图", "截屏"]],
  ["日志", ["log", "logs", "logcat", "日志"]],
  ["安装", ["install", "installs", "安装"]],
  ["卸载", ["uninstall", "uninstalls", "卸载"]],
  ["点击", ["click", "clicks", "点击", "单击", "点按"]],
  ["轻点", ["tap", "taps", "轻点", "轻触"]],
  ["双击", ["doubletap", "double", "双击"]],
  ["滑动", ["swipe", "swipes", "滑动", "划动"]],
  ["输入", ["type", "typing", "input", "输入", "打字", "键入"]],
  ["按键", ["press", "按键", "按住", "长按"]],
  ["调试", ["debug", "debugging", "调试"]]
];

const CONTEXT_GROUPS = [
  ["设备", ["device", "devices", "设备", "手机", "真机", "模拟器"]],
  ["应用", ["app", "apps", "application", "applications", "应用"]],
  ["屏幕", ["screen", "screens", "屏幕", "界面"]],
  ["列表", ["list", "lists", "列出", "列举", "清单"]],
  ["打开", ["open", "打开"]],
  ["启动", ["launch", "start", "启动", "拉起"]],
  ["结束", ["terminate", "kill", "结束", "终止", "杀掉"]],
  ["分配", ["allocate", "分配"]],
  ["释放", ["release", "释放"]],
  ["远程", ["remote", "远程", "云端"]],
  ["前台", ["foreground", "前台"]],
  ["坐标", ["coordinate", "coordinates", "坐标"]],
  ["链接", ["url", "链接", "网址"]],
  ["剪贴板", ["clipboard", "剪贴板"]],
  ["旋转", ["orientation", "rotate", "rotation", "旋转", "横屏", "竖屏"]],
  ["录制", ["record", "recording", "录制", "录屏"]],
  ["栈", ["stack", "trace", "backtrace", "栈", "调用栈", "堆栈"]],
  ["二进制", ["binary", "binaries", "二进制", "elf"]],
  ["函数", ["function", "functions", "函数", "方法"]],
  ["地址", ["address", "地址"]],
  ["引用", ["xref", "xrefs", "crossreference", "crossreferences", "references", "reference", "cross", "引用", "被谁引用", "谁引用", "引用了", "交叉引用", "交叉"]],
  ["伪代码", ["pseudocode", "伪代码"]],
  ["字符串", ["string", "strings", "字符串"]],
  ["包含", ["containing", "contains", "contain", "所在", "所属", "包含", "属于"]],
  ["内存", ["memory", "内存"]],
  ["调用", ["call", "calls", "调用"]],
  ["图", ["graph", "diagram", "图"]],
  ["源码", ["source", "sources", "源码", "源代码"]],
  ["固件", ["firmware", "bundle", "固件", "固件包"]],
  ["显示器", ["display", "monitor", "显示器", "显示屏"]],
  ["分辨率", ["resolution", "分辨率"]],
  ["布局", ["layout", "布局"]],
  ["定位", ["location", "gps", "定位"]],
  ["模拟", ["simulate", "simulated", "emulator", "模拟"]],
  ["视频", ["video", "videos", "视频", "影片"]],
  ["剪辑", ["clip", "clips", "剪辑", "片段", "片子", "短片"]],
  ["修剪", ["trim", "trims", "trimming", "剪切", "修剪", "剪掉", "裁掉", "裁剪", "剪"]],
  ["合并", ["merge", "merges", "合并", "拼接"]],
  ["音频", ["audio", "音频", "声音"]],
  ["字幕", ["subtitle", "subtitles", "字幕"]],
  ["文件", ["file", "files", "文件"]],
  ["桌面", ["desktop", "桌面"]],
  ["键盘", ["key", "keys", "键盘", "键"]]
];

const CONCEPT_GROUPS = CAPABILITY_GROUPS.concat(CONTEXT_GROUPS);

function englishTerms(text) {
  const out = [];
  const runs = String(text || "").match(/[A-Za-z0-9]+/g) || [];
  for (const run of runs) {
    const parts = run
      .split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length > 1);
    if (parts.length > 1) out.push(run.toLowerCase());
    out.push(...parts);
  }
  return out;
}

function cjkTerms(text) {
  const out = [];
  const runs = String(text || "").match(CJK_RUN) || [];
  for (const run of runs) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
    if (run.length > 2 && run.length <= CJK_WHOLE_MAX) out.push(run);
  }
  return out;
}

function tokenize(text) {
  const s = String(text || "");
  if (!s) return [];
  return englishTerms(s).concat(cjkTerms(s));
}

function aliasTerms(word) {
  return englishTerms(word).concat(cjkTerms(word));
}

const CAPABILITY_TERMS = new Set(
  CAPABILITY_GROUPS.flatMap(([, words]) => words.flatMap((w) => aliasTerms(w)))
);

function isAsciiWord(word) {
  return /^[a-z0-9]+$/.test(word);
}

function queryTerms(query) {
  const terms = new Map();
  const lexical = tokenize(query);
  for (const t of lexical) if (!terms.has(t)) terms.set(t, 1);
  const lower = String(query || "").toLowerCase();
  const lexicalSet = new Set(lexical);
  for (const [, words] of CONCEPT_GROUPS) {
    const matched = words.some((w) => (isAsciiWord(w) ? lexicalSet.has(w) : lower.includes(w)));
    if (!matched) continue;
    for (const w of words) {
      for (const t of aliasTerms(w)) {
        if (!terms.has(t)) terms.set(t, ALIAS_WEIGHT);
      }
    }
  }
  return terms;
}

function parameterNames(schema, depth) {
  const level = depth || 0;
  const out = [];
  if (!schema || typeof schema !== "object" || level > 2) return out;
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : null;
  if (props) {
    for (const [key, node] of Object.entries(props)) {
      out.push(key);
      out.push(...parameterNames(node, level + 1));
    }
  }
  const items = schema.items && typeof schema.items === "object" ? schema.items : null;
  if (items) out.push(...parameterNames(items, level + 1));
  return out;
}

function countOf(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function sumOf(counts) {
  let n = 0;
  for (const c of counts.values()) n += c;
  return n;
}

function documentOf(entry) {
  const rawParams = entry.parameters || entry.params;
  const paramText = Array.isArray(rawParams) ? rawParams.join(" ") : parameterNames(rawParams, 0).join(" ");
  const name = countOf(tokenize(entry.name));
  const summary = countOf(tokenize(entry.summary || entry.description || ""));
  const params = countOf(tokenize(paramText));
  const len = FIELD_WEIGHT.name * sumOf(name)
    + FIELD_WEIGHT.summary * sumOf(summary)
    + FIELD_WEIGHT.params * sumOf(params);
  return { entry, name, summary, params, len };
}

function rankEntries(entries, query, limit) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e.name === "string" && e.name) : [];
  const wanted = queryTerms(query);
  if (!wanted.size || !list.length) return [];

  const docs = list.map(documentOf);
  const total = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / total || 1;

  const df = new Map();
  for (const d of docs) {
    const seen = new Set([...d.name.keys(), ...d.summary.keys(), ...d.params.keys()]);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }

  const scored = [];
  for (const d of docs) {
    const norm = BM25_K1 * (1 - BM25_B + BM25_B * (d.len / avgLen));
    let score = 0;
    for (const [term, weight] of wanted) {
      const tf = FIELD_WEIGHT.name * (d.name.get(term) || 0)
        + FIELD_WEIGHT.params * (d.params.get(term) || 0)
        + FIELD_WEIGHT.summary * (d.summary.get(term) || 0);
      if (tf <= 0) continue;
      const freq = df.get(term) || 0;
      const idf = Math.log(1 + (total - freq + 0.5) / (freq + 0.5));
      let gain = (idf * (tf * (BM25_K1 + 1)) / (tf + norm)) * weight;
      if (d.name.has(term) && CAPABILITY_TERMS.has(term)) gain *= CAPABILITY_NAME_BOOST;
      score += gain;
    }
    if (score > 0) scored.push({ entry: d.entry, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.entry.name).localeCompare(String(b.entry.name)));
  return scored.slice(0, limit || 8).map((s) => s.entry);
}

export { TIERS, normalizeTier, firstSentence, splitToolName, rankEntries, tokenize, isMetaTool };
