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

import { firstSentence, normalizeTier, rankEntries, splitToolName } from "./context-budget.js";

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

// 目录条目：名字 + 摘要。刻意不带 schema，也不带参数名。
function entryOf(name, description, serverName) {
  const split = splitToolName(name);
  return {
    name,
    server: serverName || (split ? split.server : ""),
    tool: split ? split.tool : name,
    summary: firstSentence(description, "")
  };
}

/**
 * Build the gateway over one plugin install.
 * @param options.hiddenReason - (fullName) => string|null, the single authority on
 *   whether a tool may appear in the prompt at all this turn.
 * @param options.servers - () => ServerRecord[], for the panel summary only.
 * @param options.registry - () => ToolRuntime|null.
 * @returns install/hook/summary helpers; all registrations are returned as disposers.
 */
export function createGateway(options) {
  const hiddenReason = options.hiddenReason;
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
      if (hiddenReason(schema.name)) continue;
      out.push(entryOf(schema.name, schema.description, ""));
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
    const hits = rankEntries(catalog, terms, Math.min(Math.max(Number(limit) || cap, 1), LIMIT_MAX));
    if (!hits.length) {
      const names = catalog.map((e) => e.name).slice(0, catalogLimit());
      return {
        text: `没有工具命中「${terms}」。下面是可检索的 ${catalog.length} 个工具名，换一个词再搜，或直接用 names 取回其中一个的完整参数。`,
        mode: "names",
        total: catalog.length,
        names
      };
    }
    return {
      text: `命中 ${hits.length} 个工具（共 ${catalog.length} 个可检索）。用 names 取回需要的那几个的完整参数。`,
      mode: "hits",
      total: catalog.length,
      tools: hits.map((e) => ({ name: e.name, summary: e.summary }))
    };
  }

  function listResult(catalog) {
    return {
      text: `当前有 ${catalog.length} 个按需工具，没有常驻提示词。用 query 检索用途，或直接用 names 取回完整参数。`,
      mode: "names",
      total: catalog.length,
      names: catalog.map((e) => e.name).slice(0, catalogLimit())
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
    const loaded = [];
    const unknown = [];
    const blocked = [];
    let omittedTotal = 0;
    let truncatedCount = 0;
    for (const name of wanted.slice(0, clampInt(settingsOf().loadBatchMax, 1, 50, 12))) {
      if (hiddenReason(name)) {
        blocked.push({ name, reason: hiddenReason(name) });
        continue;
      }
      const schema = map.get(name);
      if (!schema) {
        unknown.push(name);
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
    if (blocked.length) parts.push(`已禁用、不可调用：${blocked.map((b) => b.name).join("、")}。`);
    if (!parts.length) parts.push("没有取回任何工具。");
    // tools 恒为数组：调用方（含测试与面板）不必区分「没有取回」和「字段缺失」，
    // 少一个分支就少一次空值崩溃。
    return {
      text: parts.join(" "),
      mode: "schemas",
      tools: loaded,
      ...(unknown.length ? { unknown } : {}),
      ...(blocked.length ? { blocked: blocked.map((b) => b.name) } : {})
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
          "按需取回 MCP 工具：MCP 服务器不再常驻全部参数 schema，先用本工具检索。"
          + " query=关键词检索（命中返回名字与一句话摘要；一个都没命中则返回全部工具名）；"
          + " names=[工具名] 取回这些工具的完整参数，之后即可直接调用它们；"
          + " 两者都不给则列出全部工具名。这是唯一常驻的 MCP 工具。",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", description: "检索关键词，例如 download、capture、screenshot。" },
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
              tools: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } }
            },
            required: ["text"]
          },
          render: (_args, value) => [{ type: "text", text: String((value && value.text) || "") }]
        },
        async execute(args, exec) {
          const agent = exec && exec.agent;
          const names = Array.isArray(args && args.names) ? args.names : null;
          const query = args && typeof args.query === "string" ? args.query : "";
          const result = names && names.length
            ? loadResult(agent, names)
            : searchResult(agent, query, args && args.limit);
          // 完整 schema 走 tool-result 正文，模型下一步即可照抄参数。
          // 名单与命中也必须进正文：render 只回传 text 字段，结构化的
          // names/tools 数组到不了模型眼前——只回一句话的检索等于没检索。
          let text = result.text;
          if (result.mode === "schemas") {
            text += "\n\n" + JSON.stringify(result.tools, null, 2);
          } else if (result.mode === "hits") {
            text += "\n" + result.tools.map((t) => t.name + (t.summary ? " — " + t.summary : "")).join("\n");
          } else if (result.mode === "names" && result.names && result.names.length) {
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

  return { install, applyBudget, searchResult, loadResult, visibleCatalog, BRIDGE_TOOL_NAME, SCHEMA_RESULT_MAX_BYTES, LIMIT_MAX };
}
