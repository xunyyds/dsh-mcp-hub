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

// 摘要取描述的第一句：MCP 服务器的描述常以「第一行标题 + 多段说明」开头，
// 首句通常就是用途，后面的段落是参数故事，属于取回后才该付的成本。
//
// 终止符必须按字符找而不是「句号+空白」：中文摘要里句号后面直接接下一句
// （「中文第一句。第二句。」），要求空白会把整段都当成一句，等于没截断。
function firstSentence(text, fallback) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return fallback || "";
  const at = s.search(/[.。！!?？]/);
  if (at >= 0) {
    // 英文 "e.g." "Dr." 这类缩写处的句点不该切；只在切点之前还有实词时认。
    const head = s.slice(0, at + 1);
    if (head.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "").length >= 2) return head.trim();
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

// ── 检索命中排序 ─────────────────────────────────────────────
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

export { TIERS, normalizeTier, firstSentence, splitToolName, rankEntries, tokenize };
