// 上下文预算：把 MCP 工具 schema 从「每轮都在提示词里」改成分级投放。
//
// 事实源是 dsh-tools 的请求装配路径：
//   systemPrompt.assemble() 收集 registry.schemas(scope) → 排序 → 交给 adapter。
// 本模块只做两件事，都在 system-prompt/assemble 这个官方瀑布钩子里：
//   1) 把被降级服务器的 schema 从这一轮的 tools 里摘掉（真省 token，不是 guard 拦）；
//   2) 往 schema 里注入 deferLoading，让它们在历史里以「已声明但非即时」的形式存在。
//
// 摘掉不等于调用不到：本模块同时注册一个 run_code 之外的检索工具，
// 模型按需取回完整 schema，之后该 schema 立刻进入本会话的放行集合。

// 每台服务器的投放档位：
//   full  —— schema 全量进提示词（默认，行为与未装本插件一致）
//   lazy  —— 目录里只剩工具名与一句话摘要，需要时再取
//   off   —— 完全不进提示词，也不可检索（等价于这台服务器不存在）
const TIERS = ["full", "lazy", "off"];

function normalizeTier(v) {
  return TIERS.includes(v) ? v : "full";
}

// 只有「确实是缩写」的词才进表。刻意不收 ref / min / max / no / co 这类
// 同时也是正常英文词的写法——收录它们会让 `the ref. Then ...` 这种正常
// 句末被当成缩写而不截断，摘要于是又变回一整段。
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "cf", "al", "fig", "figs", "approx", "dept",
  "inc", "ltd", "corp", "vol", "vols", "pp", "esp", "incl", "excl", "resp"
]);

// 切点是否是真正的句末。
//
// 缩写（e.g. / i.e. / Dr. / etc.）后面的句点只在「后面还有实质内容」时
// 才可能不是句末；真正的区分信号是下一句的起始形态：
//   `Dr. Smith`      → Smith 大写，但 Dr 是头衔，仍属同一句；
//   `... etc. Then`  → Then 大写，这就是下一句的开始。
// 两条规则叠在一起才既不切坏 `e.g.`，也不把整段吞成一句。
function endsWithAbbreviation(head) {
  const m = /([A-Za-z][A-Za-z.]*)$/.exec(head);
  if (!m) return false;
  const raw = m[1].toLowerCase().replace(/\.+$/, "");
  if (raw.includes(".")) return true;
  if (raw.length <= 2) return true;
  return ABBREVIATIONS.has(raw);
}

// 头衔/单位类缩写：即使后面是大写，也仍属同一句。
const TITLE_ABBREVIATIONS = new Set([
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "rev", "hon", "gen",
  "col", "maj", "capt", "lt", "sgt", "gov", "sen", "rep", "pres", "supt"
]);

// 摘要取描述的第一句：MCP 服务器的描述常以「第一行标题 + 多段说明」开头，
// 首句通常就是用途，后面的段落是参数故事，属于取回后才该付的成本。
//
// 两类终止符的判据不同：
//   中文 。！？  —— 本身自带断句语义，后面不需要空白（「中文第一句。第二句。」）；
//   英文 .!?     —— 先要求后面是空白或结尾（否则是 `e.g` 这类连写），
//                  再看前一个词是不是缩写：
//                    头衔类（Dr. Smith）—— 仍属同一句，跳过；
//                    其他缩写（etc. Then）—— 下一句以大写起头就是句末。
function firstSentence(text, fallback) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return fallback || "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (!".。！!?？".includes(ch)) continue;
    if (ch === "。" || ch === "！" || ch === "？") return s.slice(0, i + 1).trim();
    // 英文标点：后面紧跟非空白字符说明这是缩写内部连写，不是句子边界。
    if (s[i + 1] !== undefined && !/\s/.test(s[i + 1])) continue;
    if (ch === ".") {
      const head = s.slice(0, i + 1);
      if (endsWithAbbreviation(head)) {
        const tail = s.slice(i + 1).trimStart();
        const isTitle = TITLE_ABBREVIATIONS.has((/([A-Za-z][A-Za-z.]*)$/.exec(head)?.[1] || "").toLowerCase().replace(/\.+$/, ""));
        if (isTitle) continue;
        // 括号未闭合：`(i.e. JSON). Done.` 的句点在 `)` 之后才结束。
        // 用 head 里的未闭合括号数判断，比猜下一词大小写更可靠。
        const opens = (head.match(/[([]/g) || []).length;
        const closes = (head.match(/[)\]]/g) || []).length;
        if (opens > closes) continue;
        // 只有「缩写 + 大写起头的下一句」才断。
        if (!/^[A-Z]/.test(tail)) continue;
      }
    }
    return s.slice(0, i + 1).trim();
  }
  return s.length > 160 ? s.slice(0, 160).trim() : s.trim();
}

// 工具名在 DSH 里是 mcp__<server>__<tool>；反查归属靠前缀，与 index.js 保持一致。
function splitToolName(name) {
  const s = String(name || "");
  if (!s.startsWith("mcp__")) return null;
  const rest = s.slice(5);
  const at = rest.indexOf("__");
  if (at < 0) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

// ── 上游元工具 ───────────────────────────────────────────────
// 有些 MCP 服务器会自己暴露一个「列出更多工具」的元工具（mobile 的
// get_more_tools 就是一例）。它是服务器内部的目录开关，不是可执行能力，
// 占用检索位只会让模型在「两层目录」之间反复横跳。
//
// 判据刻意收窄到「整段名字就是一个列出/获取更多工具的动作」，避免把
// 真正业务工具（如 list_tools_in_project）误判掉。
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

// 该裸工具名是否是上游元工具。
function isMetaTool(rawToolName) {
  const name = String(rawToolName || "").trim().toLowerCase();
  if (!name) return false;
  return META_TOOL_PATTERNS.some((re) => re.test(name));
}

// ── 检索内核：CJK 分词 + BM25 + 能力词加权 ────────────────────
//
// 为什么整段推倒：旧 tokenize 用 /[^a-z0-9]+/ 切词，中文连续段落整段被当成
// 分隔符丢掉。现场证据：tokenize("反汇编 so 符号 调试") 只回 ["so"]，于是任何
// 中文任务句式都恒等于零命中——检索工具对中文用户完全不可用。
// 更贵的是旧 scoreEntry 拿 name.includes(term) 做子串匹配："so" 于是命中
// compare_source_to_bundle（source 里含 so），把一条只在描述散文里顺带提到
// 这两个字母的冷门工具顶到第一位。模型拿到错的第一名比拿到「没命中」更贵：
// 它会照那个工具去调用，再花一轮才发现方向错了。
//
// 现在三件事，全部零依赖：
//   1) 分词：英文按非字母数字切开后拆驼峰（工具名是 snake_case 与驼峰混排），
//      CJK 连续段切 2-gram——中文没有空格，2-gram 是不需要词典就能覆盖
//      未见新词（反汇编、屏幕录制）的唯一稳妥切法；
//   2) 打分：BM25。idf 从本次传入的目录现算，不做任何进程级缓存：目录每轮
//      都可能因为服务器连上/断开、工具被禁用而变化，缓存 idf 等于把上一轮的
//      目录当成事实，是同一句话上午命中、下午不命中的典型幽灵 bug；
//   3) 加权：文档按字段加权（工具名 > 参数名 > 一句话摘要），再叠一张中英
//      桥接表与「能力词命中工具名」的额外加成。

// BM25 的两个标准参数。k1 控制词频饱和，b 控制长度归一的强度。b 取 0.75 是
// 这里必须的：摘要写得越长（散文越多）的工具被稀释得越厉害，正是我们要的方向。
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// 字段权重。为什么工具名是摘要的三倍：名字是工具的自述，摘要是别人转述的介绍。
// 操作者说「截图」时，他要的是名字里带 screenshot 的那个工具，而不是摘要里
// 顺带提到 screenshot 的分析工具——这正是旧实现让人踩坑的地方。
// 参数名居中：按「要填什么参数」找工具（device、url、session_id）确实存在，
// 但它比能力弱，不该压过名字。
const FIELD_WEIGHT = { name: 3, summary: 1, params: 1.2 };

// 桥接别名的权重略低于原词：原词是操作者的原话，别名是我们替他猜的同义词，
// 猜错了也不该压过字面命中。
const ALIAS_WEIGHT = 0.8;

// 能力词命中「工具名」时的额外加成。要求是「显著高于」，而字段权重只给出
// 3 倍；再乘这一档，才是「名字里就是干这个的」与「摘要里提到过」的差距。
const CAPABILITY_NAME_BOOST = 1.5;

// 中文整段最多保留到多长。2-gram 已经覆盖了短段的全部信息，再留整段就是
// 重复计词频；只有比 2-gram 更长的段（反汇编、屏幕录制）才额外保留整段，
// 让长词精确命中时拿到更高词频，同时不把两个字的高频词算成两遍。
const CJK_WHOLE_MAX = 6;

// CJK 连续段。范围只取常用汉字 + 扩展 A + 兼容区：它已经覆盖本仓库能见到的
// 全部中文工具摘要，再宽的区（emoji、其他语种）只会让 2-gram 变脏。
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

// 中英桥接表：每组是「同一件事」的不同说法。
//
// 为什么必须有这张表：工具的官方名字几乎全是英文（take_screenshot / get_crash），
// 而操作者用中文提需求（截个图、拿崩溃栈）。不做映射，中文查询在英文目录里
// 恒等于零命中——这正是旧实现线上「中文完全不可用」的成因。
// 表是双向使用的：中文查询词映射到英文工具词，英文查询词也映射到中文摘要词，
// 所以同一张表同时覆盖「崩溃 → crash」与「crash → 崩溃」两个方向。
//
// 前面是「能力动词组」：这些词出现在工具名里，说明该工具就是干这件事的，
// 命中时额外加成。组名按惯例放第一个词，但代码不特殊对待它——组内每个词
// （含中文说法）都会被真的拿去匹配。这一点必须写清：曾经以为「组名不参与
// 匹配」，「引用」组里于是没写「引用」这个词，结果「被谁引用过」零命中。
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

// 语境组只做桥接，不加成：它们帮我们对齐「说的是什么东西」，
// 但决定「用哪个工具」的仍然是上面的能力词。
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
  // 组名只是给这组起名，不参与匹配；每个中文说法都必须真的列进词表。
  // 这里曾经漏了「引用」本身，于是「被谁引用过」完全零命中——留出组测出来的。
  ["引用", ["xref", "xrefs", "crossreference", "crossreferences", "references", "reference", "cross", "引用", "被谁引用", "谁引用", "引用了", "交叉引用", "交叉"]],
  ["伪代码", ["pseudocode", "伪代码"]],
  ["字符串", ["string", "strings", "字符串"]],
  ["包含", ["containing", "contains", "contain", "所在", "所属", "包含", "属于"]],
  ["内存", ["memory", "内存"]],
  // 下面这些是实测漏网的口语写法：操作者不会说「列出 xrefs」，他说的
  // 是「属于哪个函数」「画一下调用图」。不把口语对到工具词，中文就仍然
  // 是零命中——桥接表的覆盖面本身就是中文可用性的上限。
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

// 英文词：下划线/标点天然是分界（工具名是 snake_case），再拆一次驼峰。
// 拆驼峰是必需的：windows 的 DisplayInventory、rea 的 compareSourceToBundle
// 都只有驼峰，只按整词索引会让 query=display 永远命不中。
// 拼接词（displayinventory）要跟着一起产出：日志里常见全小写粘贴的工具名，
// 它不带大小写信息，只有拼接词能对上驼峰原名。
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

// CJK：连续段切 2-gram。
// 两字的段不额外保留整段（2-gram 就是它本身，否则词频会被算两遍）；
// 单字段单独保留一个字，好让「点」「栈」这类单字查询不至于零词可用。
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

// 分词对外仍然只回字符串数组：既有调用方（含仓库测试）按 tokenize(x).includes("so")
// 这种用法断言，签名一变就会连带打断它们。顺序先英后中，顺序本身不带语义。
function tokenize(text) {
  const s = String(text || "");
  if (!s) return [];
  return englishTerms(s).concat(cjkTerms(s));
}

function aliasTerms(word) {
  return englishTerms(word).concat(cjkTerms(word));
}

// 能力词集合：把所有能力组里的每种说法（含中文词的 2-gram 展开）摊平。
// 打分时只对「命中了工具名」的这些词加成，见 rankEntries。
const CAPABILITY_TERMS = new Set(
  CAPABILITY_GROUPS.flatMap(([, words]) => words.flatMap((w) => aliasTerms(w)))
);

function isAsciiWord(word) {
  return /^[a-z0-9]+$/.test(word);
}

// 查询词 → { 词: 权重 }。
//
// 桥接的匹配方式刻意分两种：
//   英文别名按「整词」对齐——按子串匹配会让 blog 里的 log、comparison 里的
//     compare 都算命中，正是旧实现子串匹配出事的那一类误伤；
//   中文别名按「子串」匹配——2-gram 会把「反汇编」切碎（反汇/汇编），
//     而查询原文里「反汇编」是连续三个字，按子串才抓得稳。
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

// 参数名也是文档的一部分：模型经常是按「要填什么参数」找工具（device、url、
// session_id）。只认 schema.properties 的键名，递归三层为止——再深的嵌套参数名
// 对「找哪个工具」几乎没有区分度，却会把文档长度撑长、稀释真正的命中。
//
// 注意本函数读的是 entry.parameters，而 lib/gateway.js 的 entryOf 目前不把
// parameters 放进目录条目（本轮不许改 gateway.js）。所以生产路径上这一字段为空，
// 参数名这条通路暂时只是「接线接好了」：一旦 entryOf 补上 parameters 就自动生效，
// 评测语料里带着参数，保证这段代码确实被跑到、而不是死代码。
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

// 一条工具 → 三个带词频的字段 + 加权文档长度。
// 加权长度参与 BM25 的长度归一，所以「名字长、摘要长」的工具会被适度稀释，
// 不至于因为某个词在长摘要里出现一次就压过名字里就带着这个词的工具。
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

// 检索入口。签名与返回值形态保持不变：entries 进来，entry 对象数组出去——
// lib/gateway.js 直接用返回的条目渲染「名字 + 一句话摘要」，任何形状变化都会
// 打断这条链，而它正是「按需投放」唯一的取用口。
function rankEntries(entries, query, limit) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e.name === "string" && e.name) : [];
  const wanted = queryTerms(query);
  if (!wanted.size || !list.length) return [];

  const docs = list.map(documentOf);
  const total = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / total || 1;

  // 文档频率现算：一个词出现在多少条工具里。目录里到处都有的词（get、list、
  // mobile）idf 低，只在一两条工具里出现的词（tombstone、allocate）idf 高——
  // 这正是「按能力命中」与「按写错的词撞运气」之间的区分度来源。
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
      // idf 用 +1 的那一版，恒为正：负 idf 会让「命中的词越多分越低」，
      // 排序直接反过来，而那种错法极难从结果上看出来。
      const idf = Math.log(1 + (total - freq + 0.5) / (freq + 0.5));
      let gain = (idf * (tf * (BM25_K1 + 1)) / (tf + norm)) * weight;
      // 能力词加成只认「工具名里有」：名字是工具的自述，摘要只是转述。
      // 判据必须是名字命中而不是任意字段命中，否则摘要里顺带一提的散文词
      // 又会被顶到前面，也就是这次要修掉的那个老毛病。
      if (d.name.has(term) && CAPABILITY_TERMS.has(term)) gain *= CAPABILITY_NAME_BOOST;
      score += gain;
    }
    if (score > 0) scored.push({ entry: d.entry, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.entry.name).localeCompare(String(b.entry.name)));
  return scored.slice(0, limit || 8).map((s) => s.entry);
}

export { TIERS, normalizeTier, firstSentence, splitToolName, rankEntries, tokenize, isMetaTool };
