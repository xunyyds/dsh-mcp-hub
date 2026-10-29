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

// 不引入分词器：MCP 工具名本身是 snake_case，模型也是按这些词找东西。
// 打分只看「名字命中 > 摘要命中」，并让完整命中的词权重更高，
// 这样 "capture" 不会因为某条摘要里顺带出现就被排到 capture_* 前面。
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function scoreEntry(entry, terms) {
  const name = entry.name.toLowerCase();
  const hay = (name + " " + String(entry.summary || "").toLowerCase()).replace(/[^a-z0-9]+/g, " ");
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    if (name.includes(term)) score += 6;
    else if (hay.includes(term)) score += 2;
    else if (term.length > 3 && name.includes(term.slice(0, 4))) score += 1;
  }
  return score;
}

function rankEntries(entries, query, limit) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const scored = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, terms);
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit || 8).map((s) => s.entry);
}

export { TIERS, normalizeTier, firstSentence, splitToolName, rankEntries, tokenize, isMetaTool };
