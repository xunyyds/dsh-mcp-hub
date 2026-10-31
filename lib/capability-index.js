// 能力摘要：把「服务器有哪些本事」从工具元数据里长出来，而不是手写。
//
// 为什么必须有这个模块：lib/index.js 的 catalogText() 现在只列
// `mobile（33 个工具）`，模型的全部路由依据就是这一串服务器名。名字认得，
// 能力不认得——「崩溃日志怎么拿」这个问题里没有出现 mobile 这个词，模型
// 就不会想到去 mobile 里翻。补齐的办法本来只有一条：手写一段路由文案塞进
// 提示词。但手写文案会腐烂，而且烂得没有声音：
//   · 新接一台 server，没人想起来去改那段文案，模型于是「想不到它」；
//   · 老 server 加了五个工具，文案还是三年前那四个词；
//   · 两台能力相近的 server（真机 mobile / 逆向 rea）文案会写成同一句话，
//     模型分辨不出该调哪台，开始乱试。
// 这些都不是代码错误，不会报错、不会红测试，只会让每一轮对话多绕几步。
//
// 所以这里反过来做：从工具名、描述、参数名里统计出「这台服务器区别于其他
// 服务器」的词，再渲染成一行。新接一台 server 时摘要自动出现，不需要任何人
// 记得去改 prompt。数学上这件事就是「挑出把本 server 和其他 server 分开的
// 那些词」——出现在所有 server 里的词（get / list / tool / 返回）没有区分度，
// 一个词越稀有、在此 server 里越常见，它越是这台服务器的能力信号。
//
// 本模块只负责算，不负责接。签进去的位置是 catalogText() 里「服务器名 + 个数」
// 那一行，由 lib/index.js 调用。因为每次装配系统提示词都会读它的输出，
// 所以 summaryText() 必须是纯函数式的确定性渲染：
// 同一份 index 调两次要逐字节一致，否则每轮请求的提示词前缀都会失效，
// 缓存命中率归零——改动渲染路径时要守住这条。

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// 索引结构版本。算法改了（分词、权重、桥接表）就要抬这个数，
// 否则磁盘上那份按旧算法算出来的 features 会被当成新结果继续用，
// 表现是「改了算法但摘要毫无变化」，排查起来很像缓存根本没生效。
const INDEX_VERSION = 1;

// 服务器数超过这个值就不再逐个列。提示词里每多一行就多付一份常驻成本，
// 而 8 台之后「逐个列」的边际收益已经低于它的 token 代价；改成按首字母
// 分组报个数，再给一句检索指引就够了——真有需要，模型会自己去展开。
const MAX_INLINE_SERVERS = 8;

// 索引里存 8 个特征，渲染时取前 5 个。存的比用的多，是因为渲染宽度
// 可以按需变（options.maxFeatures），而重建索引是 O(工具总数) 的事，
// 不值得为了少显示几个词再算一遍。
//
// 为什么是 5 而不是 4：4 个词在一台成熟服务器上很容易被「日志·截图·崩溃」
// 这类同族能力占满，安装/点击/滑动这些高频诉求词排在第 5 位之后就被切掉了。
// 5 个词一行仍然在 15-20 token 的目标之内（中文每词约 2 token），
// 却能多覆盖一整个能力族。
const MAX_FEATURES = 8;
const MAX_RENDER_FEATURES = 5;

// 通用词的判据：一个词如果出现在 80% 以上的 server 里，它就描述不了
// 任何一台服务器——把它留在摘要里等于让每行都带一句「本服务器有工具」。
//
// 刻意不写死黑名单（get/list/set/run 这一串）。黑名单的寿命只到下一次
// 接新服务器为止：新 server 的描述里冒出一个新通用词，黑名单立刻过期，
// 而没有人会注意到。用覆盖率在线算，判据随着 server 集合自己更新。
const COMMON_COVERAGE = 0.8;

// 参数名最多下钻 3 层。真实 schema 的嵌套很少超过这个深度，而 MCP 服务器
// 里不乏 depth 20+ 的自引用结构（`additionalProperties` 指回自身），
// 不设上限会让 signatureOf 与语料收集在畸形 schema 上直接栈溢出。
const PARAM_MAX_DEPTH = 3;

// 中文虚词当分隔点用，不当黑名单用。
//
// 「崩溃日志的默认值」整段切 2-gram 会得到「溃日」「志的」「的默」这种
// 跨词垃圾——它们既不是词，也不该有机会被选成特征。而这些垃圾有一个共同
// 特征：都跨过了一个虚词。所以先按虚词把整段切开，段内再切 2-gram，
// 垃圾就不产生了。这比「切完再删」省事，也不会误删真词。
//
// 注意这与上面的 COMMON_COVERAGE 是两件事：那张表管「哪些词没有区分度」
// （靠统计），这张表管「哪里是词的边界」（靠语法）。虚词是句法粘合剂，
// 它的位置由汉语本身决定，不会因为接了新服务器而变，所以这里可以写死。
const HAN_STOP = new Set(
  Array.from("的了着过是在于与和或及乃就是个这那就也都还又会被把从到为以等于上下时后前里外可要能不对没无有些什么之其而且然则因所如果并再次该每某任何与么很太更最两者这那")
);

// 英语虚词（封闭类）：冠词、介词、连词、代词、助动词、普通形容词。
//
// 它们和上面的中文虚词是同一类东西——语法粘合剂，不是能力词。
// 必须在这里挡掉，而不能靠下面的覆盖率判据：覆盖率只认「大多数 server
// 都有」的词，而 on 可能只出现在 mobile 和 openchatcut 两台里。实测
// 一台 mobile 的摘要曾渲染成「设备·on·崩溃·屏幕」——on 来自
// click_on_screen 与 list_elements_on_screen，df 比「崩溃」还高，
// 于是在排名里压过了真正的能力词。
//
// 这张表和「不许用硬编码黑名单」并不冲突：黑名单会过期，是因为它装的是
// 领域词（get / list / tool），领域一变它就错；而 on / to / and 属于
// 封闭类，英语里就那几十个，一百年后也不会因为接了新服务器而变。
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

// 中英桥接表：左列是工具名/描述里会出现的英文词，右列是用户嘴里更可能
// 说的中文词。
//
// 为什么需要它：语料里「screenshot」出现了 40 次，但用户的提问里一个英文
// 都不带——「截个图看看」「崩溃日志发我」。没有桥接时，统计能得出
// screenshot 是 mobile 的高区分度特征，却没法把它变成「截图」这两个字，
// 摘要就还是一行英文，对中文提问不起作用。
//
// 方向是双向的，但落点是同一个：不管语料是英文还是中文，最终都尽量收敛到
// 中文。反向（中文特征挂回英文工具）在打分阶段完成——中文词只要出现在
// 中文语料里就天然被统计到，不需要再查一次表。
//
// 只收「有稳定单译名」的词。screenshot→截图 可以，run→跑 不行：
// 后者在工具名里是「执行」，译错反而制造噪音。
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
  // 键必须是**归一化之后**的形式。tokenize 会把 coordinates 归一成
  // coordinate、logs 归一成 log，写复数形式在这里等于这条桥接永远不生效
  // ——这种错不会报错，只会让摘要里莫名其妙少一个中文词，极难发现。
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

// 信号词：用户原话里会直接打出来的技术名词，供 JIT 触发器匹配。
//
// 与特征词用两套机制是刻意的。特征词可以靠统计挖出来，信号词不行：
// 「.so」和「shared object」是同一件事，这个等号写在文档里而不是语料里，
// 统计永远看不见。所以信号词表必须有，而且必须人工维护——它的价值恰恰
// 在于「用户会这么说」这个确定性事实，而不是可推断的东西。
const SIGNAL_WORDS = [
  "adb", "logcat", "tombstone", "anr", "crash", "emulator", "simulator",
  "il2cpp", "unity", "frida", "lldb", "gdb", "dwarf", "macho", "objdump",
  "disasm", "disassemble", "backtrace", "symbol", "binary", "screenshot",
  "install", "uninstall", "clipboard", "swipe", "apk", "dex", "elf",
  "timeline", "clip", "export", "render", "project", "video", "track",
  "device", "screen", "app", "bundle", "file", "process", "memory",
  "network", "registry", "window", "coordinates", "orientation"
];

// 这几个词在正常英文里也常见（also / destroy / adept），只按 token 出现
// 就收会误伤。所以它们必须同时满足「以 .xxx 的扩展名形态出现」才认。
// 输出时也带着点（".so"），让下游按扩展名匹配，而不是按子串匹配。
const EXTENSION_SIGNALS = ["so", "dylib", "ipa", "jar", "aar"];

const MAX_TRIGGERS = 8;
const MIN_TRIGGERS = 3;

// 工具名词位权重。
//
// MCP 工具名几乎都是 `动词_宾语` 的 snake_case：mobile_list_crashes、
// mobile_get_crash、install_app、open_binary。动词恒在首位，真正描述
// 「能干什么」的宾语恒在末位。于是同一个统计口径下，list / get / open / add
// 这类词会冲到前排——实测 mobile 的摘要一度渲染成
// 「设备·on·崩溃·屏幕·app·list·available」，一大半位置被通用动词吃掉。
//
// 按「通用词」删它们就得再写一张黑名单，而黑名单会随新服务器过期
// （任务要求里明确不要）。但词位是**命名约定**，不是词表：首词是动词槽，
// 末词是宾语槽，这一点在一百台新服务器上依然成立。
const HEAD_WEIGHT = 4;
const MIDDLE_WEIGHT = 2;
const VERB_WEIGHT = 1;

// 桥接命中后的小幅加权：命中桥接意味着「这个词有稳定的中文说法」，
// 正是摘要要展示给用户看的东西。只做 1.5 倍的微调而不做决定性权重，
// 因为排序的主干应该由统计（稀有度 × 覆盖度）决定，
// 桥接只负责在同分附近把 截图/安装/日志 这类真能力词往前拨一位。
const BRIDGE_BOOST = 1.5;

// ── 分词 ─────────────────────────────────────────────────────

// 汉字段整体切出来，再交给 hanTokens 处理。用捕获组保留分隔结构，
// 这样一次 split 就能同时拿到中英两段的切分位置。
const HAN_SEGMENT = /([\p{Script=Han}]+)/u;
const HAN_TEST = /\p{Script=Han}/u;

// 中文段切 2-gram。段长 1 时循环条件 `i + 1 < buf.length` 直接为假，
// 于是单字天然产不出任何 token——「的」「值」这类孤立单字不需要额外的
// 长度黑名单，切法本身就把它挡掉了。
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

// 语料分词。英文走「小写 + 驼峰拆词 + 长度 >= 2」，中文走上面的 2-gram。
//
// 不引入第三方分词器：MCP 工具名基本都是 snake_case / camelCase 的英文，
// 中文集中在描述里，2-gram 对「挑特征词」这个用途足够——我们不需要知道
// 「反汇编」是一个词，只需要知道它比「调试」更稀有、更专属于 rea。
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
      // FileSystem → File System，让 getDeviceLogs 这种驼峰名也能拆出
      // device / logs，而不是产出一个没人会拿去检索的长词。
      for (const part of word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ")) {
        let low = part.toLowerCase();
        if (low.length < 2) continue;
        if (EN_STOP.has(low)) continue;
        // 复数归一：crashes→crash、devices→device、logs→log。不归一的话
        // 「崩溃报告」这个词在 list_crashes 与 get_crash 里会被算成两个
        // 不同的词，df 各算一次，两个都不够强，最后谁都进不了摘要。
        //
        // 只处理 -es / -s，并且 -es 只在词干本身以 s/x/z/ch/sh 结尾时才剥
        // （crashes→crash、boxes→box），否则只剥 -s（devices→device，
        // 剥成 devic 就变成一个谁也不会检索的怪词）。-ss/-us/-is 结尾
        // 一律保护：class、status、analysis 都不是复数。
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

// 参数名递归收集。只顺着 properties 走：anyOf / oneOf / items 里的键
// 通常是类型的复述（string / array），不是能力信息，收进来只会稀释特征。
function collectParameterNames(schema, depth, out) {
  if (!schema || typeof schema !== "object" || depth >= PARAM_MAX_DEPTH) return;
  const props = schema.properties;
  if (!props || typeof props !== "object") return;
  for (const key of Object.keys(props)) {
    out.push(key);
    collectParameterNames(props[key], depth + 1, out);
  }
}

// 工具名里出现的介词。它们标记出「能力宾语到此为止，后面都是修饰语」。
//
// 这条规则解决的是 click_on_screen_at_coordinates 这一类名字：如果只按
// 「末词 = 宾语槽」判位，coordinates 会被当成这台服务器的招牌能力，
// 而它其实是「传到哪」的修饰语，真正的能力是 click。实测 mobile 的摘要
// 一度出现「坐标」，源头就在这里——同一个名字里的 element 也是同样问题。
//
// 判据用语法位置而不是词表：介词之后的部分在英语里本来就是状语，
// 这个结论对任何 MCP 服务器的新工具名都成立。
const NAME_PREPOSITIONS = new Set([
  "on", "at", "to", "in", "into", "with", "for", "from", "by", "of",
  "onto", "over", "under", "within", "without", "upon", "via", "per"
]);

// 一个工具的完整语料：工具名 + 描述 + 参数名。三者一起进统计，
// 是因为能力信息在三处都有分布：mobile_get_crash 的名字里有 crash，
// 参数 crashId 里也有，描述里还会写 "full content of a crash report"。
//
// 工具名额外带 pos（词位）：0 = 动词槽，1 = 修饰槽，2 = 宾语槽。
// 这三个值说的是**命名结构里的槽位**，不是「描述里的第几个词」。
//
// serverName 必须传进来：mobile 那 33 个工具的名字全都以 mobile_ 开头。
// 不剥掉这个前缀，第一段永远被服务器名占着，动词槽整体错位一位，
// 「list」「get」这些动词就被算进了修饰槽，而它们恰恰是最该被压低的。
function corpusTokens(tool, serverName) {
  const out = [];
  const name = String((tool && tool.name) || "");
  // 前缀按 serverName + "_" 剥，只剥一次且只剥开头：
  // 工具名内部出现的 server 字样（如 get_server_status）是真内容。
  let bare = name;
  const prefix = String(serverName || "") + "_";
  if (serverName && bare.toLowerCase().startsWith(prefix.toLowerCase())) bare = bare.slice(prefix.length);

  // 先把名字拆成原始词列（保留顺序与介词），再逐词分词并定槽。
  // 之所以不能在 tokenize 之后定槽：EN_STOP 会把 on / at 这类介词过滤掉，
  // 过滤之后就看不出「哪里是状语的开始了」。
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
    // 判位顺序：介词之后 → 修饰槽；否则首词 → 动词槽；末词 → 宾语槽。
    // 单段工具名（Screenshot / Click / Type）同时命中「首词」与「末词」，
    // 必须先判末词：它其实是**能力名本身**，不是动词。先判首词会把它算成
    // 动词槽，权重掉到最低，导致 windows 的摘要里「截图」被「系统·文本」
    // 挤掉——实测就是这个顺序写反造成的。
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

// ── 签名 ─────────────────────────────────────────────────────

// 稳定序列化：对象键排序，保证「同样的参数、不同的书写顺序」算出同一个
// signature。真实场景是 MCP 服务器重启后 parameters 的键序会变——如果
// signature 跟着变，每次重连都会触发一次全量重建并写盘，缓存形同虚设。
function stableStringify(value, depth) {
  const d = depth || 0;
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(value);
  // 深度封顶：畸形 schema 的环会让这里无限递归。签名只需要「看起来变了」，
  // 不需要还原全部结构，深层截断不影响判等。
  if (d > 8) return "\"…\"";
  if (Array.isArray(value)) return "[" + value.map((v) => stableStringify(v, d + 1)).join(",") + "]";
  if (t === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k], d + 1)).join(",") + "}";
  }
  return "null";
}

// 配置 + 工具签名的决定性 hash。
//
// 为什么不能只 hash 服务器名：能力索引的输入是「工具名 + 描述 + 参数名」，
// 服务器名没变而工具全换了一套，索引必须重建，否则摘要描述的是上一版能力。
// 反过来也要敏感：改了签名算法本身而 version 没抬，也是一个需要能看出来的
// 信号，所以 version 与算法常量一起进了 hash 的输入。
//
// 排序是必须的：servers 的顺序取决于连接完成的先后，谁也不保证两次启动
// 一致。不排序的话 signature 会随机变，缓存每次失效。
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
    // 硬要求是「绝不阻塞启动」。签名算不出来时返回一个固定值而不是抛出去，
    // 代价只是下一次会重建索引，那是可接受的。
    return "signature-unavailable";
  }
}

// ── 建索引 ───────────────────────────────────────────────────

// 服务器内部的稀有度（local IDF）。
//
// 这是跨服务器「通用词」判据的镜像，也是本模块最后一个、也是最关键的一块。
// 跨服务器维度上，「出现在 80% 的 server 里」意味着这个词区分不了服务器；
// 换到同一台服务器内部，「出现在 80% 的工具里」意味着它也区分不了**能力**
// ——它描述的是这台服务器的环境，不是某一项本事。
//
// 实测证据：mobile 的第一版摘要是「屏幕·设备·崩溃·app」。屏幕与设备出现在
// 15 个工具里的 10 个以上（每一句描述都写着 "on the mobile device"、
// "on the screen"），而真正值得写的 截图 / 安装 / 卸载 各只覆盖 1-2 个工具，
// 全被压到了后面。对一台手机服务器写「设备」，等于什么都没说。
//
// 公式上限要压得住环境词、又不能让专项词衰减成 0：
// install / click / swipe / type 这些各只覆盖 1 个工具（df=1），
// 它们恰恰是摘要里最该出现的招牌能力。用 sqrt 而不是 log：
// log 在 df=1、工具数=15 时给出 log(16)=2.77，而环境词 df=10 时给出
// log(2.5)=0.92，比值 3:1 不足以拉开；sqrt 给出的 4:1 才够。
function localRarity(stat, toolCount) {
  if (!toolCount || !stat.df) return 1;
  return Math.sqrt(toolCount / stat.df);
}

// 参数维度的折扣。
//
// 「参数名也是语料的一部分」是全量收集的理由：crashId 里的 crash 帮着确认
// mobile 有崩溃能力。但反向不成立——x / y / coordinate / ref / path / text
// 这一批词是**调用参数**的词汇，不是**能力**的词汇。它们几乎每个工具都带，
// 一旦按正面语料计入，就会把摘要变成一份参数清单。
//
// 判据不写词表：一个词如果**在参数里出现得和在名字里一样多或更多**，
// 它就是参数维度。crash 在 get_crash 的名字里、在 crashId 参数里各一次，
// 但它在宾语槽，名字侧的权重足够高，折扣之后仍然是能力词；
// coordinate 在名字里 1 次、在参数里若干次，折扣之后自然沉下去。
function isParameterDimension(stat) {
  if (!stat.inParam) return false;
  return stat.paramDf >= stat.nameDf;
}

// 英中两套打分口径，因为它们的证据来源根本不同。
//
// 英文词的解释权在**工具名**：`mobile_take_screenshot` 是作者对这条能力的
// 正式命名，而描述里的 "the mobile device" 只是散文。所以英文词的分数
// 由「出现在多少个工具名里」主导。
//
// 中文词恰好相反：工具名几乎清一色是英文（Screenshot、disassemble_function），
// 中文只可能出现在描述里。如果对中文词也要求「出现在名字里」，所有中文
// 特征词都会被判零分，摘要退回一整行英文——而目标读者提的是中文问题。
// 所以中文词的证据源是描述覆盖度，名字通道对它天然无意义。
//
// 这不是给两类词编不同规则，而是承认它们可得的证据本来就不同。
function isHanTerm(term) {
  return HAN_TEST.test(term);
}

// 中文虚词已经把词边界切好了，但段内 2-gram 仍会产出跨词的碎片
// （「默认值」→「默认」「认值」）。区分真词与碎片不需要词表：
// 真能力词会在同一台服务器的多条描述里复现，「反汇编」「崩溃」都是如此，
// 而碎片通常只在一条描述里出现一次。
//
// 词位权重（bestPos）取「该词在工具名里出现过的最强槽位」而不是累加：
// crash 既出现在 get_crash 的宾语槽、也出现在 crashId 参数里，
// 累加会让它靠重复刷分，而我们要的是「它至少有哪一处强命中」。
function featureScore(stat, serverCount, toolCount) {
  const spread = Math.max(1, stat.servers.size);
  // 跨服务器稀有度：只在 1 台服务器里出现 → log(1 + N)，出现在全部 → 趋近 0。
  // 这就是互信息里那半截「这个词能区分出这台服务器」的量化。
  const cross = Math.log(1 + serverCount / spread);
  const local = localRarity(stat, toolCount);

  if (isHanTerm(stat.term)) {
    // 中文词直接来自描述，没有名字与描述的证据差，只有覆盖度。
    if (!stat.df) return 0;
    return stat.df * local * cross;
  }
  // 英文词在归并阶段会被翻成中文标签，所以这里**不乘桥接加权**：
  // 加权发生在标签层（见 buildCapabilityIndex），否则一个既是桥接词、
  // 又刚好多出现一次的英文词会被算两遍，把 日志 顶到 安装 上面去。
  //
  // 工具名的贡献分两段看，两段方向相反，必须分别对待：
  //   slot  —— 词在命名结构里的位置：宾语槽是能力本身，最重。
  //   spread —— 这个词被多少个工具名复用：复用越多越像语法词，最轻。
  // 一个因子写 (1 + log nameDf)、另一个写 1/nameDf，会互相抵消成常数，
  // 这正是之前 install / click 怎么调都上不来的原因。
  let base;
  if (stat.nameDf > 0) {
    const slot = stat.bestPos === 2 ? HEAD_WEIGHT : stat.bestPos === 1 ? MIDDLE_WEIGHT : VERB_WEIGHT;
    // 独占性：只服务一个工具的词拿满，被 N 个工具复用只剩 1/sqrt(N)。
    // 用 sqrt 而不是 1/N：list 在 12 个工具名里出现时 1/12 会把「列表」
    // 这一整个能力族抹平，而 1/sqrt(12) 仍留下位置。
    const exclusivity = 1 / Math.sqrt(stat.nameDf);
    base = slot * exclusivity;
  } else {
    // 从没进过工具名的英文词，只能来自描述或参数。给一个很低但不为零的
    // 底分：logcat 这类真能力词确实只在描述里出现，归零会把整条丢掉。
    base = 0.3;
  }
  let score = base * local * cross;
  // 参数维度再折一半：这类词描述「调用时怎么传」，不是「能干什么」。
  if (isParameterDimension(stat)) score *= 0.5;
  // 没有中文说法的英文词再折一次。
  //
  // 摘要的读者在提中文问题，一行里混进 key / location / recording 这类
  // 裸英文词，对「想起这台服务器能干什么」几乎没有帮助——它们要么是
  // 参数名（key、location），要么是某个工具的实现细节（recording、
  // preview、procedure）。桥接表就是这个模块的「可读性白名单」：
  // 有中文说法的词才有资格占据摘要里最贵的那几个位置。
  //
  // 不归零，因为新服务器总会出现桥接表还没收录的新能力词（这正是
  // 「新 server 一接进来摘要自动出现」必须成立的部分）；折到三分之一，
  // 让它只在真没有更好选择时才会露面。
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
    // 必须带点：「also」「destroy」里的 so 不是共享库。
    // 结尾用 lookahead 限死，而不是 \b——`libfoo.so` 的 so 后面是行尾，
    // `libfoo.so.1` 的后面是点，两种都得认。
    const re = new RegExp("\\." + word + "(?:$|[^A-Za-z0-9])", "m");
    if (re.test(lower)) {
      out.push("." + word);
      seen.add(word);
    }
  }
  return out;
}

// triggers 的保底补齐。
//
// 信号词表是人工维护的封闭清单，遇到工具名很「干净」的服务器就会一个都
// 匹配不上——实测 openchatcut 的 add_clip_to_timeline / render_preview
// 在旧表下 triggers 是空数组。空 triggers 的后果不是「少一条提示」，
// 而是这台服务器在 JIT 触发环节**永久不可达**：部件三靠 triggers 匹配
// 用户原话，一个都没有就永远不会被提出来。
//
// 所以这里用已经挑出来的特征词兜底。它们是语料里最有区分度的词，
// 拿来做信号词虽然不如人工信号词准，但「可能多提一次」远比「永远不提」
// 好。仍受 MAX_TRIGGERS 封顶，不会把摘要撑爆。
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

// 纯计算：给 servers 元数据，产出能力索引。不读不写任何文件。
function buildCapabilityIndex(servers, options) {
  const opts = options && typeof options === "object" ? options : {};
  const builtAt = Number.isFinite(opts.now) ? opts.now : Date.now();
  const list = Array.isArray(servers) ? servers : [];

  // 第一遍：把每台服务器的语料压成「词 → 出现该词的工具数」。同时记下
  // 每个词跨多少台服务器出现，这是通用词判据和稀有度加权的共同输入。
  const prepared = [];
  const globalSpread = new Map();
  for (const s of list) {
    const name = String((s && s.server) || "");
    const tools = Array.isArray(s && s.tools) ? s.tools : [];
    // 服务器名自己拆出来的词要整台剔除。它已经写在摘要行首了，
    // 再当成特征就是「mobile：mobile·手机…」这种复读。
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
          // -1 = 未在名字里出现，0 = 动词槽（首词），1 = 修饰槽，2 = 宾语槽（末词）。
          // 取最大值，让「至少在宾语槽出现过一次」压过「曾经出现在动词槽」。
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
        // df 按工具文档算，同一个工具里出现十次仍然只算一次：
        // 我们关心的是「这个词能代表多少种能力」，不是它有多啰嗦。
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

  // 第二遍：逐台挑特征。
  const out = [];
  for (const p of prepared) {
    // 先按「标签」归并分数，再做排序。
    //
    // 这一步是整个算法的收口，也是我踩过的一个坑：screenshot、screen 两个
    // 英文词都桥接到「屏幕」，log / logcat 都桥接到「日志」。如果先排序再
    // 逐个翻译，同一块能力的证据会被拆成好几份，每份都不够靠前，结果
    // 「截图」「日志」双双落选，摘要里冒出 app、preview 这类散词。
    //
    // 归并之后，一个中文标签的分数是它**所有英文同义词的证据之和**——
    // 这正是「这块能力在这台服务器里有多重」的正确度量。
    const merged = new Map();
    for (const stat of p.stats.values()) {
      const spread = (globalSpread.get(stat.term) || new Set()).size;
      // 通用词判据：覆盖率超阈值的词描述不了任何一台服务器，直接丢。
      // 用 >= 而不是 >，因为「所有 server 都有」正是不该留下的极端情形。
      //
      // 但只在有对照时才成立。只连了一台服务器时，每个词都出现在 100%
      // 的 server 里，一刀切会把这台服务器的摘要整个清空——而那往往是
      // 用户最需要看「这台能干什么」的时刻（第一次接入、或其它服务器都
      // 连不上）。所以单台时跳过这条判据，改由服务器内部的稀有度
      // （localRarity）负责过滤环境词。
      if (serverCount > 1 && spread / serverCount >= COMMON_COVERAGE) continue;
      const score = featureScore(stat, serverCount, p.tools.length);
      if (score <= 0) continue;
      const label = BRIDGE.get(stat.term) || stat.term;
      const prev = merged.get(label);
      if (prev) {
        // 同一个标签可能有多个来源词（screenshot 与 screen 都指向「屏幕」），
        // 分数相加——「这块能力在这台服务器里有多重」应当把所有同义证据加总。
        prev.score += score;
      } else {
        // 桥接加权在这里加，且只加一次：它表达的是「这个标签有稳定的中文
        // 说法，正是要展示给用户看的东西」，属于标签属性而不是词属性。
        // 放在 featureScore 里会让 screenshot（桥接词、且出现两次）被重复计分。
        const boost = BRIDGE.has(stat.term) ? BRIDGE_BOOST : 1;
        merged.set(label, { term: label, score: score * boost, source: stat.term });
      }
    }

    const scored = Array.from(merged.values());
    // 排序必须全序：分数相同时按词本身排，否则 Map 的插入顺序会漏进
    // 输出，而插入顺序取决于服务器返回工具的顺序——那就是不确定的。
    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.term < b.term ? -1 : a.term > b.term ? 1 : 0));

    const picked = scored.slice(0, MAX_FEATURES);

    out.push({
      server: p.server,
      toolCount: p.tools.length,
      features: picked.map((x) => x.term),
      triggers: padTriggers(triggersOf(p.raw.join(" "), new Set()), picked.map((x) => x.term))
    });
  }

  // 服务器顺序按名字定序，与 catalogText() 的排序方式逐字对齐
  // （用 < / > 比较而不是 localeCompare：localeCompare 的结果依赖进程
  // 所在的 locale，同一份配置在不同机器上会排成不同顺序，摘要就不可复现）。
  out.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));

  return { version: INDEX_VERSION, signature: signatureOf(list), builtAt, servers: out };
}

// ── 渲染 ─────────────────────────────────────────────────────

// 注入提示词的那一段。
//
// 默认每台服务器一行：`mobile（33 工具）：设备·截图·安装·日志`
// 单个 server 的渲染宽度压到 15-20 token：摘要的作用是让模型「想起来还有
// 这么一台服务器」，不是把它的能力完整讲一遍。讲全了就不叫目录了，
// 那叫把 catalogText() 换了个位置继续烧前缀。
//
// 服务器超过 8 台时不再逐个列——8 行展开已经和「全部 schema 常驻」
// 的体量在同一个量级了，这违背了按需投放的初衷。改成报总数 + 按首字母
// 分组，再给一句检索指引；真有需要，模型会自己调 mcp_hub_tools。
function summaryText(index, options) {
  const opts = options && typeof options === "object" ? options : {};
  const servers = Array.isArray(index && index.servers) ? index.servers : [];
  if (!servers.length) return "";

  const maxFeatures = Number.isFinite(opts.maxFeatures) ? opts.maxFeatures : MAX_RENDER_FEATURES;
  const maxServers = Number.isFinite(opts.maxServers) ? opts.maxServers : MAX_INLINE_SERVERS;

  // 在渲染层再排一次序，而不是信任 index.servers 的顺序。磁盘缓存可能是
  // 旧版本写下的，或者被手工改过；渲染顺序是提示词前缀的一部分，
  // 不能把「上游有没有排好」当成前提。
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
    // 没有特征时退到信号词：一行「mobile（33 工具）」总比「mobile（33 工具）：」
    // 好——后者会让模型以为摘要被截断了。
    const shown = (features.length ? features : triggers).slice(0, Math.max(0, maxFeatures));
    lines.push(name + "（" + count + " 工具）" + (shown.length ? "：" + shown.join("·") : ""));
  }
  return lines.join("\n");
}

// 超量时的压缩视图：报总量、按首字母分组，再留一句入口。
// 首字母是服务器名的首字符；非 ASCII 名字归到「其它」，不猜拼音。
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
  // Map 按插入顺序遍历，插入顺序即 sorted 的顺序，已经确定；这里再排一次
  // 只是为了把可读性交给「字母在前、# 在后」这个明确规则，而不是靠运气。
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

// ── 缓存 ─────────────────────────────────────────────────────

// 磁盘上那份索引到底能不能用。逐项校验而不是只看 version：
// 半截 JSON 能 parse 成功但缺字段（写盘进程被 kill 在 rename 之前），
// 这种索引进了提示词会渲染出 undefined，比没有索引糟得多。
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

// 读缓存。任何异常（文件不存在、权限不足、编码坏、JSON 坏、结构不对）
// 都归到 null，由调用方重算——绝不向上抛。
//
// 这是「旧索引能用就不阻塞启动」的第一道闸。启动路径上任何一次抛出都会
// 让整个插件装配失败，用户看到的是「MCP 面板打不开」，而真正的原因只是
// 一个缓存文件被别的东西写坏了。
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

// 写缓存：先写临时文件、再 rename。
//
// 直接 writeFileSync 覆盖原文件时，进程在中间被 kill（DSH 重启、用户关窗口）
// 会留下半截 JSON。下次启动读到它就是「坏缓存」，虽然会回落重算，
// 但每重启一次都要重新统计一遍全部工具。rename 在同一目录下是原子的，
// 要么看到旧文件、要么看到完整的新文件，没有中间态。
function writeIndexFile(cacheFile, index) {
  if (!cacheFile) return false;
  const tmp = cacheFile + ".tmp";
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(tmp, JSON.stringify(index), "utf8");
    renameSync(tmp, cacheFile);
    return true;
  } catch {
    // 目录只读、磁盘满、被杀软锁住——都不该让摘要消失。
    // 落盘失败只是下次启动还要再算一遍，内存里这份照样能用。
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件可能压根没建出来；删不掉也不影响主流程。
    }
    return false;
  }
}

// 带缓存的入口。
//
//   options.cacheFile  缓存文件路径，由调用方决定。这里不拼 storages 路径，
//                      因为缓存位置是宿主的约定，不该藏在库内部。
//   options.servers    服务器元数据。**可以不传**：启动早期工具还没连上，
//                      这时磁盘上那份旧索引就是唯一可用的摘要。
//   options.force      忽略缓存强制重建。
//   options.now        固定 builtAt，测试用来锁逐字节确定性。
//
// 语义分三种，逐一对应真实启动路径：
//   1) 没传 servers（还没连上）—— 磁盘有能用的就直接用，没有就返回空索引。
//      这一条就是「旧索引能用就不阻塞启动」：宁可展示上一版的能力摘要，
//      也不要在连接完成前让提示词里一片空白。
//   2) 传了 servers 且 signature 命中 —— 直接用磁盘那份。注意用磁盘的而不是
//      重算，这样 builtAt 也保持不变，整段输出逐字节稳定。
//   3) 传了 servers 但未命中 —— 重建并尝试写盘。写盘失败只影响下次启动。
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
  // 空服务器列表不写盘：启动早期「一台都没连上」是常态，拿它覆盖掉一份
  // 好不容易攒出来的索引，下次连上时又得全量重算，而且这段时间提示词里
  // 是空的。等真的连上再说。
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
