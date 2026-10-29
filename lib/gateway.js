// MCP 工具网关：把「服务器全部 schema 常驻提示词」换成「按需取回」。
//
// 为什么不能靠 guard：guard 只在执行时否决调用，schema 早在注册时就进了请求，
// 所以「面板里禁用一个 207 工具的服务器」依然白付 20 万 token。本模块走的是
// 官方 system-prompt/assemble 瀑布钩子，直接改这一轮交给 adapter 的 tools 数组，
// 因此省下的是真金白银的提示词前缀。
//
// 为什么摘掉还能调用：dsh-tools 的 execute 按名字从注册表作用域视图解析
// （tools.get(name, agent)），与提示词里的 tools 数组无关。摘掉只影响「模型看见
// 什么」，不影响「注册表认不认得」。于是模型先用 mcp_hub_tools 取回 schema，
// 再按名字直呼，调用照常走完审批与守卫。
//
// 复用当前对话的模型，不额外起一次 LLM 请求：检索与取回都是工具调用，
// 由同一条对话里的模型自己发起。这既是省 token，也是省一次往返。

import { firstSentence, isMetaTool, normalizeTier, rankEntries, splitToolName } from "./context-budget.js";

// 单次 tool 结果的上限。最胖的 MCP schema 有 166 KB，原样塞回对话等于
// 用一个 tool-result 换掉刚省下的全部预算。超过就退回「浅属性」视图：
// 保留每个参数的名称/类型/一句话说明，丢掉嵌套校验细节。
const SCHEMA_RESULT_MAX_BYTES = 16000;
const CATALOG_RESULT_MAX_ENTRIES = 200;
const SEARCH_LIMIT_DEFAULT = 8;
const LIMIT_MAX = 20;
const BRIDGE_TOOL_NAME = "mcp_hub_tools";
function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

// 面板传来的设置一律过一遍钳制：NaN/越界都回落到 fallback，而不是把
// 「输入框里敲了个字母」变成网关整个失效。
function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// 浅视图：只留根描述与每个参数的类型/枚举/一句话。校验语义仍由服务器侧保证，
// 这里丢掉的只是「写参数时看得到的细节」，属于按需再问一次就能补回的信息。
//
// 两级降级，因为「浅视图」本身也可能超预算：一个 200 属性的对象即使每个属性
// 只剩 {type} 也仍然很大。所以浅视图之后还要按属性数封顶——先丢说明、再丢
// 枚举，最后整体截断属性个数，并如实说明「还有几个没列出来」。
// 无论哪一级，都不能让取回本身把刚省下的预算再花回去。
function shrinkSchema(schema, maxBytes) {
  if (!schema || typeof schema !== "object") return { schema: schema || {}, truncated: false, omitted: 0 };
  if (jsonBytes(schema) <= maxBytes) return { schema, truncated: false, omitted: 0 };

  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  // 必需参数排在最前面：截断时先丢可选的，绝不能先丢必需的——
  // 丢一个必需参数会让模型注定调用失败，而丢一个可选参数只是少个能力。
  const names = [
    ...required.filter((n) => props[n] !== undefined),
    ...Object.keys(props).filter((n) => !required.includes(n))
  ];
  const build = (keep, withDescription, withEnum) => {
    const shallow = {};
    for (const name of names.slice(0, keep)) {
      const node = props[name];
      const item = {};
      if (!node || typeof node !== "object") {
        shallow[name] = {};
        continue;
      }
      if (typeof node.type === "string" || Array.isArray(node.type)) item.type = node.type;
      if (withDescription && typeof node.description === "string") item.description = firstSentence(node.description);
      if (withEnum && Array.isArray(node.enum) && node.enum.length <= 8) item.enum = node.enum;
      if (node.items && typeof node.items === "object" && typeof node.items.type === "string") {
        item.items = { type: node.items.type };
      }
      shallow[name] = item;
    }
    const keptRequired = required.filter((n) => shallow[n] !== undefined);
    const reduced = {
      type: schema.type || "object",
      ...(typeof schema.description === "string" ? { description: firstSentence(schema.description) } : {}),
      properties: shallow,
      ...(keptRequired.length ? { required: keptRequired } : {}),
      "x-mcp-hub-truncated": "参数细节已省略（原 schema " + jsonBytes(schema) + " 字节）；必要时用 names 只取这一个工具，或直接按必需参数调用，服务器会校验。"
    };
    return reduced;
  };

  // 逐级降级：先保说明与枚举，再保说明，再只保类型，最后按属性数二分收敛。
  for (const [withDescription, withEnum] of [[true, true], [true, false], [false, false]]) {
    const candidate = build(names.length, withDescription, withEnum);
    if (jsonBytes(candidate) <= maxBytes) return { schema: candidate, truncated: true, omitted: 0 };
  }
  let lo = 0;
  let hi = names.length;
  let best = build(0, false, false);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = build(mid, false, false);
    if (jsonBytes(candidate) <= maxBytes) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const kept = Object.keys(best.properties).length;
  return { schema: best, truncated: true, omitted: Math.max(0, names.length - kept) };
}

// 目录条目：名字 + 摘要 + 参数个数。
// argCount 只用于「零参数」这一种判断，不泄露任何参数名或 schema——
// 目的是让模型在第二层就知道某个工具不用再跑一趟 names 取参数。
function entryOf(name, description, serverName, parameters) {
  const split = splitToolName(name);
  const props = parameters && typeof parameters === "object" && parameters.properties && typeof parameters.properties === "object"
    ? Object.keys(parameters.properties).length
    : 0;
  const required = parameters && Array.isArray(parameters.required) ? parameters.required.length : 0;
  return {
    name,
    server: serverName || (split ? split.server : ""),
    tool: split ? split.tool : name,
    summary: firstSentence(description, ""),
    argCount: props,
    requiredCount: required
  };
}

// 第二层/命中行的呈现：零参数的工具直接标出来，省掉一次取参数往返。
function toolLine(entry) {
  const head = entry.name + (entry.summary ? " — " + entry.summary : "");
  if (entry.argCount === 0) return head + "（无参数，可直接调用）";
  return head;
}

// 按服务器归组，供「第二层：服务器列表」使用。
// 返回 [{ server, count, sample:[名字...] }]，按名字排序保证输出稳定——
// 同一份配置两次装配必须逐字节相同，否则请求前缀会白白失效。
function groupByServer(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = e.server || "(unknown)";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([server, list]) => ({ server, count: list.length, tools: list }));
}

/**
 * Build the gateway over one plugin install.
 *
 * 两个谓词必须分开传，这是本模块最容易写错的地方：
 *
 *   hiddenReason —— 「不进提示词」。只给 applyBudget 用。lazy 档位的工具
 *                   在这里为真，但它们**可以检索、可以取回、可以调用**。
 *   blockReason  —— 「禁止调用」。服务器禁用 / 逐工具禁用 / off 档位。
 *                   只有它为真时，检索目录才该隐藏、取回才该拒绝。
 *
 * 曾经把 hiddenReason 同时用在这三处，后果是 lazy 服务器 —— 也就是
 * 「按需投放」唯一有意义的场景 —— 被它自己废掉：schema 取不回、目录搜不到，
 * 却还能照常调用。模型于是只能靠猜参数名硬调，省下的 token 全被空转吃掉。
 *
 * @param options.hiddenReason - (fullName) => string|null, 是否从请求里摘掉。
 * @param options.blockReason - (fullName) => string|null, 是否禁止调用。
 *   缺省时退化为「用 hiddenReason」，仅为兼容旧调用方；插件本体必须显式传。
 * @param options.registry - () => ToolRuntime|null.
 * @returns install/hook/summary helpers; all registrations are returned as disposers.
 */
export function createGateway(options) {
  const hiddenReason = options.hiddenReason;
  // 没传 blockReason 时不能默默用 hiddenReason 顶替——那正是 D1 的成因。
  // 退化只保留给「调用方确实没有区分两种语义」的旧用法，并在日志里留痕。
  const blockReason = typeof options.blockReason === "function" ? options.blockReason : options.hiddenReason;
  const registry = options.registry;
  // 面板可调的网关参数。options.settings 可以是活引用（getter 或对象），
  // 每次检索/取回现读现用，改完面板下一步请求即生效；不传则用内置默认值。
  const settingsOf = () => {
    const s = options.settings;
    const v = typeof s === "function" ? s() : s;
    return v && typeof v === "object" ? v : {};
  };
  const log = (msg) => {
    try {
      options.log?.(msg);
    } catch {}
  };

  // 会话级放行集合在这里没有意义：取回 schema 是把完整结构写进 tool-result，
  // 模型下一轮就能直接照抄；再维护一份放行表只会让「谁批准了谁」多一个真相源。

  function visibleCatalog(agent) {
    const rt = registry();
    if (!rt || typeof rt.schemas !== "function") return [];
    let list = [];
    try {
      list = rt.schemas(agent) || [];
    } catch {
      return [];
    }
    const out = [];
    for (const schema of list) {
      if (!schema || typeof schema.name !== "string") continue;
      if (!schema.name.startsWith("mcp__")) continue;
      // 用 blockReason 而不是 hiddenReason：目录的职责是「列出所有还能调用的
      // 工具」，而 lazy 的工具恰恰是能调用的——它们的 schema 不在提示词里，
      // 正需要靠这个目录被找到。被禁止调用的（禁用 / off）才不该出现。
      if (blockReason(schema.name)) continue;
      // 上游的「列出更多工具」元工具不占检索位：它只是服务器内部的目录开关，
      // 列进来会让模型在「本插件的两层目录」与「服务器的元工具」之间反复横跳。
      const split = splitToolName(schema.name);
      if (split && isMetaTool(split.tool)) continue;
      out.push(entryOf(schema.name, schema.description, "", schema.parameters));
    }
    return out;
  }

  function schemasByName(agent) {
    const rt = registry();
    if (!rt || typeof rt.schemas !== "function") return new Map();
    let list = [];
    try {
      list = rt.schemas(agent) || [];
    } catch {
      return new Map();
    }
    const map = new Map();
    for (const schema of list) {
      if (schema && typeof schema.name === "string") map.set(schema.name, schema);
    }
    return map;
  }

  // ── 三层渐进披露 ──────────────────────────────────────────
  // 第一层：不带参数 → 只给服务器名列表（连工具名都不给）。
  // 第二层：传 server  → 只给该服务器的工具名与一句话摘要。
  // 第三层：传 names   → 给这几个工具的完整参数。
  //
  // 这样常驻提示词的只有一个工具名，其余全部按需展开。之所以连工具名都不
  // 常驻，是因为 200 个工具名本身就值几千 token，而绝大多数轮次用不到其中任何一个。
  // 已配置但当前没有工具的服务器。目录只列能调用的，差集要如实报出——
  // 否则模型看到「运行时上下文 5 台 / 检索池 3 台」会以为后者有问题。
  const inactiveOf = () => {
    try {
      const list = typeof options.inactiveServers === "function" ? options.inactiveServers() : [];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  function inactiveNote(list) {
    const items = Array.isArray(list) ? list : inactiveOf();
    if (!items.length) return "";
    return "（另有 " + items.map((s) => s.server + "：" + s.reason).join("；") + " 已配置但当前没有可用工具）";
  }

  function serverListResult(agent) {
    const catalog = visibleCatalog(agent);
    if (!catalog.length) return emptyCatalogResult();
    const groups = groupByServer(catalog);
    const inactive = inactiveOf();
    return {
      text:
        `当前有 ${groups.length} 个可用的 MCP 服务器、共 ${catalog.length} 个按需工具，它们的 schema 都没有常驻提示词。`
        + `用 server=<服务器名> 列出该服务器的工具，再用 names=[工具名] 取回完整参数；`
        + `也可以直接用 query 按关键词跨服务器检索。`
        + (inactive.length ? inactiveNote(inactive) : ""),
      mode: "servers",
      total: catalog.length,
      servers: groups.map((g) => ({ server: g.server, count: g.count })),
      ...(inactive.length ? { inactive } : {})
    };
  }

  function serverToolsResult(agent, serverName) {
    const catalog = visibleCatalog(agent);
    if (!catalog.length) return emptyCatalogResult();
    const groups = groupByServer(catalog);
    const wanted = String(serverName || "").trim();
    // 服务器名大小写不敏感：模型常常把 mcp__Windows__ 写成 windows。
    const hit = groups.find((g) => g.server.toLowerCase() === wanted.toLowerCase());
    if (!hit) {
      return {
        text:
          `没有名为「${wanted}」的服务器。当前可用：${groups.map((g) => g.server).join("、")}。`,
        mode: "servers",
        total: catalog.length,
        servers: groups.map((g) => ({ server: g.server, count: g.count }))
      };
    }
    return {
      text: `${hit.server} 有 ${hit.tools.length} 个工具（schema 未常驻）。用 names=[工具名] 取回需要的那几个的完整参数；标了「无参数」的可以直接调用。`,
      mode: "hits",
      total: catalog.length,
      server: hit.server,
      lines: hit.tools.map((e) => toolLine(e))
    };
  }

  // ── 检索工具的返回体 ─────────────────────────────────────
  // 三种结果形态：
  //   命中      → 命中的条目（名字 + 一句话），让模型决定取哪个；
  //   未命中    → 全部工具名（只有名字，最小成本），提示模型换个词或直接挑；
  //   点名取回  → 这几个工具的完整 schema（超限则浅视图）。
  function searchResult(agent, query, limit) {
    const catalog = visibleCatalog(agent);
    const terms = String(query || "").trim();
    const cap = clampInt(settingsOf().searchLimit, 1, LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
    if (!terms) return listResult(catalog);
    // 目录为空时要单独说清楚，不能落进「没命中」那一支：那支的措辞是
    // 「换一个词再搜」，会把模型送上无限换词的路，而真相是根本没有工具可搜。
    // 这两件事必须能从返回体本身分辨出来，不能让模型靠猜。
    if (!catalog.length) return emptyCatalogResult();
    const hits = rankEntries(catalog, terms, Math.min(Math.max(Number(limit) || cap, 1), LIMIT_MAX));
    if (!hits.length) return missResult(catalog, terms);
    return {
      text: `命中 ${hits.length} 个工具（共 ${catalog.length} 个可检索）。用 names 取回需要的那几个的完整参数；标了「无参数」的可以直接调用。`,
      mode: "hits",
      total: catalog.length,
      lines: hits.map((e) => toolLine(e))
    };
  }

  // 没命中时绝对不能倒出全量工具名。
  //
  // 实测代价：262 个工具时一次打错词会吐 200 行（约等于命中 8 条的 25 倍），
  // 而且截断点还会把整台服务器（如 windows）整段吃掉——文案却仍宣称
  // 「下面是 N 个工具名」，既不完整也误导。按需投放省下的预算被一次笔误吐回去。
  //
  // 正确做法是只给**服务器级摘要**：模型据此换用 server= 展开（二级），
  // 成本与服务器的工具数无关。
  function missResult(catalog, terms) {
    const groups = groupByServer(catalog);
    const detail = groups.map((g) => g.server + "（" + g.count + " 个工具）").join("、");
    const inactive = inactiveOf();
    return {
      text:
        `没有工具命中「${terms}」。可检索的共 ${catalog.length} 个工具，分布在 ${groups.length} 个服务器：${detail}。`
        + `换一个词再搜，或用 server=<服务器名> 展开某一台的工具名。`
        + (inactive.length ? inactiveNote(inactive) : ""),
      mode: "servers",
      total: catalog.length,
      servers: groups.map((g) => ({ server: g.server, count: g.count })),
      ...(inactive.length ? { inactive } : {})
    };
  }

  // 空目录：这是配置/连接层面的问题，不是措辞问题。告诉模型别再换词，
  // 并给出可执行的方向，否则它只会反复检索同一件事。
  function emptyCatalogResult() {
    return {
      text: "当前没有任何可检索的 MCP 工具，换关键词也不会有结果。通常意味着：没有启用中的服务器、服务器全部未连接，或 cordis.patch.yml 里的加载补丁与实际配置不一致（需要重启 DSH 生效）。请让用户检查面板的服务器列表与连接状态。",
      mode: "empty",
      total: 0,
      names: []
    };
  }

  function listResult(catalog) {
    if (!catalog.length) return emptyCatalogResult();
    // 不带参数时**只给服务器列表**，不附工具名。
    //
    // 曾经在这里附「前 200 个工具名」并标截断——那是把「第一层」直接退化成
    // 「第二层」：200 个名字仍然值几千 token，而按需投放的意义正是先让模型
    // 用 server= 把范围收窄到一台。截断标注只是弥补，不该发生。
    const groups = groupByServer(catalog);
    const inactive = inactiveOf();
    return {
      text:
        `当前有 ${groups.length} 个可用的 MCP 服务器、共 ${catalog.length} 个按需工具，它们的 schema 都没有常驻提示词。`
        + `用 server=<服务器名> 展开某一台的工具名，再按名字用 names=[工具名] 取回完整参数；`
        + `也可以直接用 query 按关键词跨服务器检索。`
        + (inactive.length ? inactiveNote(inactive) : ""),
      mode: "servers",
      total: catalog.length,
      servers: groups.map((g) => ({ server: g.server, count: g.count })),
      ...(inactive.length ? { inactive } : {})
    };
  }

  function catalogLimit() {
    return clampInt(settingsOf().catalogLimit, 1, 500, CATALOG_RESULT_MAX_ENTRIES);
  }

  function loadResult(agent, names) {
    const map = schemasByName(agent);
    const wanted = (Array.isArray(names) ? names : []).map((n) => String(n || "").trim()).filter(Boolean);
    const maxBytes = clampInt(settingsOf().schemaMaxBytes, 2000, 128000, SCHEMA_RESULT_MAX_BYTES);
    if (!wanted.length) {
      return { text: "names 为空：用 query 检索，或直接用 names 取回。", mode: "names", total: 0, names: [] };
    }
    // 目录本身为空时，报「未找到 xxx」会误导模型去纠正工具名——名字没错，
    // 是根本没有工具。这里先说清根因，再谈具体名字。
    if (!map.size) return emptyCatalogResult();
    const loaded = [];
    const unknown = [];
    const blocked = [];
    let omittedTotal = 0;
    let truncatedCount = 0;
    for (const name of wanted.slice(0, clampInt(settingsOf().loadBatchMax, 1, 50, 12))) {
      // 先查「存不存在」，再查「允不允许」。顺序反过来会把不存在的名字
      // 说成「已禁用」——模型据此以为名字是对的、只是没开，于是反复重试；
      // 而真相是名字本身错了，应该去查目录。两者给的可执行动作完全不同。
      const schema = map.get(name);
      if (!schema) {
        unknown.push(name);
        continue;
      }
      // 只有 blockReason 才拒绝取回。lazy 用的 hiddenReason 在这里必须是
      // 放行的——它的 schema 不在提示词里，正是要靠这次取回才拿得到。
      if (blockReason(name)) {
        blocked.push({ name, reason: blockReason(name) });
        continue;
      }
      const { schema: params, truncated, omitted } = shrinkSchema(schema.parameters || {}, maxBytes);
      omittedTotal += omitted || 0;
      if (truncated) truncatedCount += 1;
      loaded.push({
        name,
        description: String(schema.description || ""),
        parameters: params,
        ...(truncated ? { parametersTruncated: true } : {}),
        ...(omitted > 0 ? { parametersOmitted: omitted } : {})
      });
    }
    const parts = [];
    if (loaded.length) parts.push(`已取回 ${loaded.length} 个工具的完整参数，可以按名字直接调用。`);
    // 两种省略都如实说：属性被整条砍掉、或属性还在但嵌套细节被压平。
    // 只说一种会让模型误以为「看全了」，然后在被删掉的参数上瞎猜。
    if (omittedTotal > 0) parts.push(`其中 ${omittedTotal} 个可选属性因体积超限未列出；必需参数都在，服务器会校验。`);
    else if (truncatedCount > 0) parts.push(`其中 ${truncatedCount} 个工具的嵌套参数细节已压缩为类型摘要；顶层参数齐全，可以正常调用。`);
    if (unknown.length) parts.push(`未找到：${unknown.join("、")}（可能名字不对，用 query 检索确认）。`);
    // 如实转述被拦的原因：blocked 里存了 reason，只拼名字会让「档位是 off」
    // 与「工具被禁用」看起来是同一种失败，而它们的修复动作完全不同。
    if (blocked.length) {
      const detail = blocked.map((b) => (b.reason ? b.name + "（" + b.reason + "）" : b.name)).join("、");
      parts.push(`不可调用：${detail}。`);
    }
    if (!parts.length) parts.push("没有取回任何工具。");
    // tools 恒为数组：调用方（含测试与面板）不必区分「没有取回」和「字段缺失」，
    // 少一个分支就少一次空值崩溃。
    //
    // 一个都没取到、且不是「名字错」时，附上可检索目录：只回一句「已禁用」+
    // 裸 [] 会让模型无从下手，它需要知道现在到底还有什么能用。
    const nothingUseful = !loaded.length && !unknown.length;
    return {
      text: parts.join(" "),
      mode: nothingUseful ? "empty-load" : "schemas",
      tools: loaded,
      ...(unknown.length ? { unknown } : {}),
      ...(blocked.length ? { blocked: blocked.map((b) => b.name) } : {}),
      ...(nothingUseful ? { names: visibleCatalog(agent).map((e) => e.name).slice(0, catalogLimit()) } : {})
    };
  }

  // ── 保底：这一轮交给 adapter 的 tools 数组 ────────────────
  // 只动 mcp__ 前缀的条目，内置工具与 run_code 一律原样保留。
  function applyBudget(assembly) {
    if (!assembly || !Array.isArray(assembly.tools)) return assembly;
    let removed = 0;
    const kept = [];
    for (const tool of assembly.tools) {
      if (tool && typeof tool.name === "string" && hiddenReason(tool.name)) {
        removed += 1;
        continue;
      }
      kept.push(tool);
    }
    if (!removed) return assembly;
    return { ...assembly, tools: kept };
  }

  /**
   * Register the assemble hook and the retrieval tool.
   * @param ctx - plugin context owning `tools` and the event bus.
   * @returns disposers; every one is safe to call on unload.
   */
  function install(ctx) {
    const disposers = [];
    // 注册走 ctx.tools（服务本身），读 schema 走 registry()：两者在真机上同一个
    // 对象，但契约上不同——registry() 可能因为没有 agent 作用域而暂时不可用，
    // 而注册只需要服务存在。分开读才不会因为一个失败把另一个也停掉。
    const toolsService = ctx && ctx.tools;

    // 钩子必须排在最后：先让其他监听器把 assembly 组装完（它们可能还要加 schema），
    // 再按本插件的档位做减法。返回新对象，不原地改别人的数组。
    disposers.push(
      ctx.on("system-prompt/assemble", async (assembly, context, next) => {
        const assembled = await next();
        try {
          return applyBudget(assembled);
        } catch (e) {
          log("mcp-hub: 预算钩子异常，本轮保留全量 schema：" + String((e && e.message) || e));
          return assembled;
        }
      })
    );

    if (toolsService && typeof toolsService.register === "function") {
      // 手写定义而不是 defineTool：本插件不依赖 @deepseek-ai/dsh-tools，
      // 保持「只依赖 cordis + node 内置」的可卸载边界。注册表校验的是
      // name/parameters/output 三者，这里逐项按它的契约给出。
      const definition = {
        name: BRIDGE_TOOL_NAME,
        description:
          "MCP 工具的按需入口：所有 MCP 工具都不常驻提示词，只用本工具分层展开。"
          + " 不带参数=列出服务器；server=<名>=列出该服务器的工具；"
          + " query=<关键词>=跨服务器检索；names=[工具名]=取回完整参数，随后即可直接调用。"
          + " 这是唯一常驻的 MCP 工具。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            server: {
              type: "string",
              description: "服务器名。传了就列出该服务器的工具名，例如 windows、mobile。"
            },
            query: { type: "string", description: "跨服务器检索关键词，例如 download、capture、screenshot。" },
            names: {
              type: "array",
              items: { type: "string" },
              description: "要取回完整参数的工具名（mcp__<server>__<tool>）。"
            },
            limit: { type: "integer", description: "检索最多返回多少条，默认 8。" }
          }
        },
        output: {
          schema: {
            type: "object",
            properties: {
              text: { type: "string" },
              mode: { type: "string" },
              total: { type: "integer" },
              names: { type: "array", items: { type: "string" } },
              servers: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
              // tools 只装 schema 对象，lines 只装渲染好的文本行。曾经两者共用
              // tools，命中行改成字符串后整包被 output schema 判为非法，
              // server= 与 query= 两条路径全废——按需目录只剩点名可用。
              tools: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
              lines: { type: "array", items: { type: "string" } }
            },
            required: ["text"]
          },
          render: (_args, value) => [{ type: "text", text: String((value && value.text) || "") }]
        },
        async execute(args, exec) {
          const agent = exec && exec.agent;
          const names = Array.isArray(args && args.names) ? args.names : null;
          const query = args && typeof args.query === "string" ? args.query : "";
          const serverArg = args && typeof args.server === "string" ? args.server : "";
          // 优先级：names（最具体）> server（按服务器展开）> query（关键词）> 无参（服务器列表）。
          let result;
          if (names && names.length) result = loadResult(agent, names);
          else if (serverArg.trim()) result = serverToolsResult(agent, serverArg);
          else if (query.trim()) result = searchResult(agent, query, args && args.limit);
          else result = serverListResult(agent);
          // 完整 schema 走 tool-result 正文，模型下一步即可照抄参数。
          // 名单与命中也必须进正文：render 只回传 text 字段，结构化的
          // names/lines/servers 数组到不了模型眼前——只回一句话的检索等于没检索。
          let text = result.text;
          if (result.mode === "schemas") {
            text += "\n\n" + JSON.stringify(result.tools, null, 2);
          } else if (result.mode === "servers" && result.servers) {
            text += "\n" + result.servers.map((s) => s.server + "（" + s.count + " 个工具）").join("\n");
          } else if (result.mode === "hits") {
            // lines 已是渲染好的行（含「无参数」标注），这里直接拼接。
            text += "\n" + result.lines.join("\n");
          } else if (result.names && result.names.length) {
            // names-truncated / empty-load 两支要列出工具名：
            // 前者是「结果被截断，这些是前 N 个」，后者是「一个都没取到，还能用什么」。
            text += "\n" + result.names.join("\n");
          }
          return { ...result, text };
        }
      };
      try {
        disposers.push(toolsService.register(definition));
      } catch (e) {
        // 注册失败（比如同名冲突）不该拖垮整个插件：面板与审批仍然可用。
        log("mcp-hub: 检索工具注册失败：" + String((e && e.message) || e));
      }
    }

    return () => {
      for (const off of disposers) {
        try {
          off && off();
        } catch {}
      }
    };
  }

  return {
    install,
    applyBudget,
    searchResult,
    loadResult,
    serverListResult,
    serverToolsResult,
    visibleCatalog,
    BRIDGE_TOOL_NAME,
    SCHEMA_RESULT_MAX_BYTES,
    LIMIT_MAX
  };
}
