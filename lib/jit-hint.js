// JIT 触发提示器：在「模型本该用某台服务器的工具」的那个当口，补一行提示。
//
// 为什么需要它：只靠模型自觉去检索工具是靠不住的。按需展开（gateway）把 200 个
// 工具的 schema 从请求前缀里拿掉了，省下来的 token 是真的，但「哪些能力存在」
// 这条线索也随之变淡。真实事故：某轮任务里模型动了 40MB 的 libil2cpp.so、跑了几
// 十次 adb、还扒了 tombstone，而 mobile 服务器里一直躺着一个 mobile_get_crash
// 没人想到用。它不是不会用工具，是没有在那个当口想起「这台服务器有这类工具」。
//
// 所以本模块的输入不是「用户想干什么」（那是 context-budget 的活），而是「这一轮
// 眼前出现了哪些信号」：adb、logcat、tombstone、某个 *.so 路径、一句「反汇编」。
// 信号命中某台服务器的触发词，就在这一轮补一行：
//   提示：mobile 有 33 个 设备/日志类工具，可用 mcp_hub_tools(query="设备") 查看
// 一行 token 换一次「想起来」，比模型盲搜几十次便宜得多。
//
// 为什么节流规则写得这么硬：见下方「节流」一节的长注释——这个模块的死因只有
// 一个，就是噪音，而噪音的代价是模型开始忽略所有提示。
//
// 边界：纯内存、零依赖、不落盘。状态按 sessionId 隔离，可单独 reset。
// 所有对外入口都不抛错——它挂在请求装配路径上，抛一次就是整个请求失败。

// 与 gateway.js 里的 BRIDGE_TOOL_NAME 必须一致：提示里要让模型知道
// 该拿哪个工具去查，写错了这条提示就是个死路。
const BRIDGE_TOOL_NAME = "mcp_hub_tools";

// 会话上限。长跑的面板进程里会话只增不减，给个硬顶，淘汰最老的一条。
// 代价只是那个会话的预算从零开始重算——比无界增长好，也比整块清空温和。
const MAX_SESSIONS = 2000;

const CJK_RE = /[\u3400-\u9FFF]/;

// ── 匹配器 ───────────────────────────────────────────────────
// 信号与触发词共用同一套构造器。「怎么算文本里出现过某个词」必须只有一份定义，
// 否则抽信号时用一套规则、匹配触发词时用另一套，so 和 also 这种钉子迟早漏在某一侧。
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 数字/字母视为标识符字符；下划线、连字符、点、斜杠都算分隔符。
// 不用 \b：它把 _ 当词内字符，mcp__mobile__mobile_get_crash 里的 crash
// 就永远匹配不到，而那正是「最近命令/路径」里最常见的形态。
function wordRegExp(word) {
  return new RegExp("(^|[^A-Za-z0-9])" + escapeRe(word) + "(?:es|s)?(?![A-Za-z0-9])", "i");
}

// 扩展名形态：点必须紧贴扩展名，扩展名后面不能再接标识符字符。
//   命中：libil2cpp.so、classes.dex、*.apk、.so 文件、libfoo.so.1
//   不命中：.sock（不是 .so）、also / so that（连点都没有）
function extRegExp(ext) {
  return new RegExp("\\." + escapeRe(ext) + "(?![A-Za-z0-9])", "i");
}

// ── 信号表 ───────────────────────────────────────────────────
// kind 决定「怎么算出现过」：
//   word —— 英文词，必须落在词边界上；
//   cjk  —— 中文没有词边界，按子串匹配才是对的；
//   sub  —— 只给出词干、允许长在别的词里（disasm 要认得 disassembling，
//           il2cpp 要认得 libil2cpp.so 里那一段）；
//   ext  —— 只认文件扩展名形态（见下方长注释）。
//
// label 是「给人看的中文类别词」，只用于拼提示里那一句（`有 33 个 设备/日志类
// 工具`），不参与命中判定也不参与排序。它顺手兼了一份最小的中英桥接字典：
// 模型和用户都在中文语境里，提示里的类别词说成中文才有用；拆成第二张表只会让
// 两张表悄悄失配。
//
// "so" / "dex" / "apk" / "elf" 只认扩展名形态，绝不按英文单词匹配。原因很具体：
// so 是英语里最高频的连接词之一，"also" / "so that" / "so we can" 在任何一段
// 中文技术讨论里都会出现，按单词匹配等于每两句话就误报一次；elf 同理（精灵）。
// 这类「缩写恰好也是常用词」的信号只能靠形态区分，而"查一下 .so 导出符号"这种
// 把扩展名当名词说的中文句子依然命中，所以并不会因此丢掉真实场景。
function signal(id, kind, label) {
  return {
    id,
    kind,
    label: label || (kind === "cjk" ? id : null),
    re: kind === "word" ? wordRegExp(id) : kind === "ext" ? extRegExp(id) : null
  };
}

const SIGNALS = [
  // 设备/安卓（mobile、adb 那一侧）
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
  // 二进制与 native 调试（mobile 与 rea 都会挂这一类）
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
  // 逆向/反汇编（rea）
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
  // 崩溃与日志（几乎所有服务器都会有一两个这类工具）
  signal("crash", "word", "崩溃"),
  signal("崩溃", "cjk"),
  signal("闪退", "cjk"),
  signal("卡死", "cjk"),
  signal("log", "word", "日志"),
  signal("dmesg", "word", "日志"),
  signal("syslog", "word", "日志"),
  signal("日志", "cjk"),
  // 桌面/GUI（windows）
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
  // 安装/卸载/权限（mobile）
  signal("install", "word", "安装"),
  signal("uninstall", "word", "卸载"),
  signal("permission", "word", "权限"),
  signal("安装", "cjk"),
  signal("卸载", "cjk"),
  signal("权限", "cjk"),
  // 媒体（openchatcut 这一类）
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

// 裸写的扩展名。索引里的触发词可能是 ".so"、"*.so"，也可能就是 "so"，
// 三种写法都必须归到扩展名匹配上——否则索引里写 "so" 的那台服务器会每两句话
// 被 also 触发一次。
const EXT_NAMES = new Set(["so", "dex", "apk", "elf", "oat", "vdex"]);

// 从一段文本里抽信号词。返回值按信号表顺序去重，不按文本出现顺序：
// 同一段文本两次提取必须逐字一致，否则「同样的现场给同样的提示」这条性质就没了。
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

// ── 触发词 ───────────────────────────────────────────────────
// 索引里的 triggers 是人/程序写出来的，形态不统一：adb、*.so、.so、so、反汇编
// 都可能出现。统一收口成和信号表同一套匹配器，命中判定的定义就只有一份。
function compileTrigger(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  // "*.so" 这种 glob 写法只取扩展名部分
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
  // 带空格或其它符号的短语：退回大小写不敏感的子串
  return { key: "sub:" + s, raw, kind: "sub", text: s, re: null, label: labelOfToken(s, "sub") };
}

function labelOfToken(text, kind) {
  const known = SIGNAL_BY_ID.get(text);
  if (known && known.label) return known.label;
  if (CJK_RE.test(text)) return text;
  // 短的英文触发词本身就是好用的类别词（native / frida / ffmpeg）；长的是工具名
  // 片段（mobile_get_crash），拿它当类别词只会让提示变难读，索性不给。
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

// ── 索引归一化 ───────────────────────────────────────────────
// 索引由部件一产出，这里是它的消费者，所以一律当成「可能畸形」来读：
// 少字段、字段类型不对、条目是 null 都要能跑，最坏退化成「没有可匹配的服务器」。
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
      // 同一台服务器的 "so" 与 "*.so" 归一到同一个 key，别让它算两次匹配分
      if (!spec || keys.has(spec.key)) continue;
      keys.add(spec.key);
      triggers.push(spec);
    }
    // 没有可用触发词的服务器永远匹配不到，留着只是白遍历
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
  // 触发词稀有度：被越多服务器共用的触发词信息量越低（和部件一剔除通用词是同一个
  // 道理——"adb" 只挂在 mobile 上，说明它很指向具体能力；"日志" 要是五台都有，
  // 靠它决定提示哪台就等于抽签）。现算不缓存，索引因此可以保持纯数据。
  const df = new Map();
  for (const s of servers) {
    for (const t of s.triggers) df.set(t.key, (df.get(t.key) || 0) + 1);
  }
  return { servers, df };
}

// 服务器名归一：配置里是裸名（mobile），而调用方可能给的是
// mcp__mobile__mobile_list_apps 这种完整工具名。两种都要认，否则
// usedServers 判不掉，等于节流漏了一层。
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
    // 传进来的也可能是裸工具名 mobile_list_apps。MCP 的服务器分隔符是双下划线，
    // 有它的时候第一个分段就是服务器名；没有就可能是 server_tool 这种粘法，
    // 拿第一段兜一下——多认一个名字比漏判一次便宜。
    const head = name.split("__")[0];
    if (head && head !== name) set.add(head);
  }
  return set;
}

// ── 提示渲染 ─────────────────────────────────────────────────
// 目标是一行、能照着做：说清「哪台服务器、有多少、哪一类」，并给出可以直接抄的
// 检索调用。不写「你可能需要……」这种含糊话——模型要的是动作，不是建议。
function renderHint(cand) {
  const words = classWords(cand);
  const desc = words.length ? words.join("/") + "类工具" : "工具";
  // 中文类别词前不留空格（「33 个设备/日志类工具」），英文留着
  // （「12 个 native/反汇编类工具」）。这只影响可读性，不影响任何匹配。
  let count = "";
  if (cand.toolCount > 0) count = cand.toolCount + " 个" + (CJK_RE.test(desc) ? "" : " ");
  return "提示：" + cand.server + " 有 " + count + desc +
    "，可用 " + BRIDGE_TOOL_NAME + "(query=\"" + queryWord(cand) + "\") 查看";
}

// 类别词优先取「和命中信号对得上」的特征词：那才是检索时真正起作用的词，也最
// 贴近这台服务器自己的说法。对不上时退到特征词前两个，再退到信号的中文类别词。
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

// 查询词优先给中文：模型和用户都在中文语境里，而检索内核有中英桥接，给中文类别
// 词它抄过去就能直接搜。
function queryWord(cand) {
  const pool = cand.labels.concat(cand.features, [cand.server]);
  for (const w of pool) {
    if (w && CJK_RE.test(w)) return w;
  }
  return pool.find(Boolean) || cand.server;
}

// 候选排序：命中强度 → 命中条数 → 服务器名。
// 分数是 Σ 1/df(触发词)，也就是「越稀有的证据越算数」。最后一档故意用服务器名
// 而不是索引顺序：索引顺序会随配置增删而变，名字不会，这样同一句话的提示是稳定的。
function compareCand(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.hits.length !== a.hits.length) return b.hits.length - a.hits.length;
  return a.server < b.server ? -1 : a.server > b.server ? 1 : 0;
}

// ── 节流状态机 ───────────────────────────────────────────────
// 这个模块唯一的死因是噪音，不是漏报。
//
// 漏报一次，最坏结果是模型多搜两次；而噪音会让这条提示本身失效：
//   1) 同一台服务器的同一句话反复出现，模型会开始整段跳过它，连真正有用的那
//      一次也一起跳过——提示的价值全在稀缺；
//   2) 每轮插一句，token 会按「轮数 × 提示长度」涨，而按需展开刚刚才把这些
//      token 省下来，等于自己把自己废掉；
//   3) 已经用过 mobile 的会话再被告知「mobile 有设备工具」，是在侮辱模型。
//
// 所以四道闸门缺一不可：
//   perTurn    一次调用最多拼几条。默认 1，跟着这一轮一起进去。
//   perServer  同一台服务器在一个会话里最多说一次。说过就是说过，用不用是模型的事。
//   maxTotal   一个会话总共 3 条。三条之后还没想起来用工具，再多说只是把对话变长。
//   逐字重复   上一轮那句信号文本刚刚才出过提示，就不再出。它补的是 perServer 的
//              盲区：一段文本常同时命中两三台服务器，perServer 只记账被选中的那台，
//              不做这层判断的话，「push libil2cpp.so 然后 adb logcat」会被连着念
//              两遍、每遍换一台服务器——用户体感就是同一句话被复读。
//
// 逃逸阀：用户明说「找不到工具」时，说明瓶颈是「不知道有什么」而不是「提示太多」。
// 此时解除 perServer、maxTotal 与逐字重复三道闸门，perTurn 保留——一次卡住就能
// 刷屏的话，前面所有约束都白写了。「找不到工具」这句话的语义本来就是「再告诉我一遍」。
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

// sessionId 缺失时退到同一个匿名桶：宁可这类调用共享 3 次预算（等于几乎不提示），
// 也不能凭空造一个新会话把节流彻底废掉——那是最坏的一种「悄悄失效」。
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
  // 预算允许传函数，每次判定现读。
  //
  // 与索引传 getter 是同一个理由，但这里更要紧：maxTotal 与 maxPerServer 是
  // **面板上可调**的，而 hinter 是在 apply() 里建一次、活到插件卸载。把值烤进
  // 闭包，用户改完面板必须重启 DSH 才能生效——而本插件其他所有设置（检索条数、
  // 目录上限、schema 预算）都是「保存后下一步请求即生效」。只有提示要重启，
  // 是那种查起来最费劲的不一致。
  const readLimit = (v, lo, hi, fallback) => (typeof v === "function" ? clampInt(v(), lo, hi, fallback) : clampInt(v, lo, hi, fallback));
  const maxPerServerOf = () => readLimit(opts.maxPerServer, 1, 20, 1);
  const maxTotalOf = () => readLimit(opts.maxTotal, 1, 50, 3);

  // 索引允许传函数：部件一会在配置变更后重建索引，传个 getter 就是活引用，
  // 调用方不用跟着重建 hinter（和面板设置那套「现读」是同一个理由）。
  const indexSource = opts.index;
  const sessions = new Map();
  let cachedRaw = null;
  let cached = normalizeIndex(null);

  // signature 相同就是同一份内容，没必要每轮重新归一化；部件一重建出来的对象
  // 换了个身份但内容没变，这条判断就省掉了重复编译正则。
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
    // 这一层 catch 不是偷懒：本模块被挂在请求装配路径上，漏一次异常就是整条请求
    // 失败。宁可这一轮少一句提示。
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

    // 解除限制要先于所有闸门判断：用户这句「找不到工具」本身不该被节流吃掉，
    // 否则他说了三遍也不会有任何变化（那正是最让人绝望的失效方式）。
    if (isRelief(lower)) st.released = true;

    // 逐字重复：这一段信号刚刚才用来出过提示。网关重试、或模型没照做又拿同样的
    // 现场问一遍，都不该再插一句——那是这条功能最容易变成噪音的入口。
    //
    // 它同时挡住一个隐性的漏报：同一段文本往往同时命中两三台服务器（"adb logcat"
    // 之外还挂着 .so），perServer 只会记账被选中的那一台；不做这层判断的话，下一个
    // 一模一样的轮次就会换一台服务器再提示一次，用户体感是「这句话被念了三遍」。
    // 解除限制后此闸门一并失效——那句话的语义就是「再告诉我一遍」。
    if (!st.released && st.lastText === text) return "";

    const idx = currentIndex();
    if (!idx.servers.length) return "";
    // 预算现读：面板改完下一步就生效，不需要重启（见 readLimit 的注释）。
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

    // 记账。顺序无所谓，但必须只有真正返回到字符串里的候选才算数：
    // 先记账再拼串的话，一次渲染异常就会吞掉预算却什么也没说。
    st.hints += lines.length;
    for (const c of chosen) st.byServer.set(c.server, (st.byServer.get(c.server) || 0) + 1);
    st.lastText = text;
    return lines.join("\n");
  }

  // 清掉某个会话的节流计数。不带参数则清全部（面板上的「清空提示状态」）。
  function reset(sessionId) {
    if (sessionId === undefined || sessionId === null) {
      sessions.clear();
      return;
    }
    sessions.delete(sessionKey(sessionId));
  }

  // 给面板/日志看的汇总。byServer 是按服务器累计发过几条，budget 是当前上限，
  // 出问题时能一眼看出是「没命中」还是「被节流」。
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
