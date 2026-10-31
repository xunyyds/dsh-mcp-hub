import { firstSentence, isMetaTool, normalizeTier, rankEntries, splitToolName } from "./context-budget.js";

const SCHEMA_RESULT_MAX_BYTES = 16000;
const CATALOG_RESULT_MAX_ENTRIES = 200;
const SEARCH_LIMIT_DEFAULT = 8;
const LIMIT_MAX = 20;
const REVEAL_MAX_DEFAULT = 0;
const BRIDGE_TOOL_NAME = "mcp_hub_tools";
function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function shrinkSchema(schema, maxBytes) {
  if (!schema || typeof schema !== "object") return { schema: schema || {}, truncated: false, omitted: 0 };
  if (jsonBytes(schema) <= maxBytes) return { schema, truncated: false, omitted: 0 };

  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
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

function entryOf(name, description, serverName, parameters) {
  const split = splitToolName(name);
  const hasObjectSchema = Boolean(parameters && typeof parameters === "object" && parameters.type === "object");
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
    requiredCount: required,
    hasObjectSchema,
    parameters: parameters && typeof parameters === "object" ? parameters : undefined
  };
}

function toolLine(entry) {
  const head = entry.name + (entry.summary ? " — " + entry.summary : "");
  if (entry.hasObjectSchema && entry.argCount === 0 && entry.requiredCount === 0) {
    return head + "（无参数，可直接调用）";
  }
  return head;
}

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

export function createGateway(options) {
  const hiddenReason = options.hiddenReason;
  const blockReason = typeof options.blockReason === "function" ? options.blockReason : options.hiddenReason;
  const registry = options.registry;
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
      if (blockReason(schema.name)) continue;
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

  function searchResult(agent, query, limit) {
    const catalog = visibleCatalog(agent);
    const terms = String(query || "").trim();
    const cap = clampInt(settingsOf().searchLimit, 1, LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
    if (!terms) return listResult(catalog);
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
    if (!map.size) return emptyCatalogResult();
    for (const name of [...revealed.keys()]) if (!map.has(name)) revealed.delete(name);
    const loaded = [];
    const unknown = [];
    const blocked = [];
    const corrected = [];
    const overflow = [];
    let omittedTotal = 0;
    let truncatedCount = 0;
    for (const name of wanted.slice(0, clampInt(settingsOf().loadBatchMax, 1, 50, 12))) {
      let resolved = name;
      let schema = map.get(name);
      if (!schema) {
        const guess = normalizeToolName(name);
        const hits = map.size ? [...map.keys()].filter((k) => normalizeToolName(k) === guess) : [];
        if (hits.length === 1) {
          resolved = hits[0];
          schema = map.get(resolved);
          corrected.push({ from: name, to: resolved });
        }
      }
      if (!schema) {
        unknown.push(name);
        continue;
      }
      if (blockReason(resolved)) {
        blocked.push({ name: resolved, reason: blockReason(resolved) });
        continue;
      }
      const { schema: params, truncated, omitted } = shrinkSchema(schema.parameters || {}, maxBytes);
      omittedTotal += omitted || 0;
      if (truncated) truncatedCount += 1;
      const revealedNow = reveal(resolved);
      if (revealedNow.added === false) overflow.push({ name: resolved, cap: revealedNow.cap, active: revealedNow.active });
      loaded.push({
        name: resolved,
        description: String(schema.description || ""),
        parameters: params,
        ...(truncated ? { parametersTruncated: true } : {}),
        ...(omitted > 0 ? { parametersOmitted: omitted } : {})
      });
    }
    const parts = [];
    if (loaded.length) {
      const addedCount = loaded.length - overflow.length;
      if (addedCount > 0 && !overflow.length) {
        parts.push(`已取回 ${loaded.length} 个工具的完整参数，这些工具已加入可调用列表，下一步即可直接调用。`);
      } else if (addedCount > 0) {
        parts.push(`已取回 ${loaded.length} 个工具的完整参数，其中 ${addedCount} 个已加入可调用列表。`);
      } else {
        parts.push(`已取回 ${loaded.length} 个工具的完整参数，但都没能加入可调用列表。`);
      }
    }
    if (overflow.length) {
      const { cap, active } = overflow[0];
      parts.push(
        `可调用列表已满（${active.length}/${cap}），这次没有加入：${overflow.map((o) => o.name).join("、")}。`
        + `先调用 mcp_hub_tools({ release: [不需要的工具名] }) 腾出位置，再重新取回；也可以把 revealMax 调大或设为 0（不限）。`
        + `当前列表：${active.join("、")}。`
      );
    }
    if (corrected.length) {
      parts.push(`已自动纠正名字：${corrected.map((c) => c.from + " → " + c.to).join("、")}。`);
    }
    if (omittedTotal > 0) parts.push(`其中 ${omittedTotal} 个可选属性因体积超限未列出；必需参数都在，服务器会校验。`);
    else if (truncatedCount > 0) parts.push(`其中 ${truncatedCount} 个工具的嵌套参数细节已压缩为类型摘要；顶层参数齐全，可以正常调用。`);
    if (unknown.length) {
      const catalog = visibleCatalog(agent);
      const hints = unknown.map((u) => {
        const near = nearestNames(catalog, u, 3);
        return near.length ? `${u} → 是否想取 ${near.join("、")}` : `${u}（目录里没有相近名字）`;
      });
      parts.push(`未找到：${hints.join("；")}。`);
    }
    if (blocked.length) {
      const detail = blocked.map((b) => (b.reason ? b.name + "（" + b.reason + "）" : b.name)).join("、");
      parts.push(`不可调用：${detail}。`);
    }
    if (!parts.length) parts.push("没有取回任何工具。");
    const nothingUseful = !loaded.length && !unknown.length;
    return {
      text: parts.join(" "),
      mode: nothingUseful ? "empty-load" : "schemas",
      tools: loaded,
      ...(unknown.length ? { unknown } : {}),
      ...(blocked.length ? { blocked: blocked.map((b) => b.name) } : {}),
      ...(overflow.length ? { revealSkipped: overflow.map((o) => o.name), active: overflow[0].active } : {}),
      ...(nothingUseful ? { names: visibleCatalog(agent).map((e) => e.name).slice(0, catalogLimit()) } : {})
    };
  }

  const revealed = new Map();
  function revealCap() {
    const n = Math.round(Number(settingsOf().revealMax));
    return Number.isFinite(n) && n >= 0 ? n : REVEAL_MAX_DEFAULT;
  }
  function reveal(name) {
    const cap = revealCap();
    if (!revealed.has(name) && cap > 0 && revealed.size >= cap) {
      return { added: false, cap, active: [...revealed.keys()] };
    }
    revealed.set(name, Date.now());
    return { added: true, cap, active: null };
  }

  function releaseResult(names) {
    const wanted = (Array.isArray(names) ? names : []).map((n) => String(n || "").trim()).filter(Boolean);
    const cap = revealCap();
    if (!wanted.length) {
      const active = [...revealed.keys()];
      return {
        text: active.length
          ? `当前可调用列表有 ${active.length} 个工具${cap > 0 ? `（上限 ${cap}）` : "（未设上限）"}：${active.join("、")}。用 release=[工具名] 移出不需要的。`
          : "当前可调用列表为空。取回过的工具才会进入这个列表。",
        mode: "release",
        active
      };
    }
    const removed = [];
    if (wanted.includes("*")) {
      removed.push(...revealed.keys());
      revealed.clear();
    } else {
      for (const name of wanted) if (revealed.delete(name)) removed.push(name);
    }
    const missing = wanted.includes("*") ? [] : wanted.filter((n) => !removed.includes(n));
    const active = [...revealed.keys()];
    const parts = [
      removed.length
        ? `已从可调用列表移出 ${removed.length} 个工具：${removed.join("、")}。`
        : "没有匹配的可调用工具需要移出。",
      missing.length ? `本就不在列表里：${missing.join("、")}。` : "",
      cap > 0
        ? `当前列表 ${active.length}/${cap}，可以继续用 names 取回了。`
        : `当前列表 ${active.length} 个（未设上限）。`
    ];
    return { text: parts.filter(Boolean).join(" "), mode: "release", active, ...(missing.length ? { unknown: missing } : {}) };
  }

  function normalizeToolName(name) {
    return String(name || "").toLowerCase().replace(/_/g, "");
  }

  function nearestNames(entries, wanted, cap) {
    const norm = normalizeToolName;
    const target = norm(wanted);
    if (!target) return [];
    const grams = (s) => {
      const g = new Set();
      for (let i = 0; i + 1 < s.length; i += 1) g.add(s.slice(i, i + 2));
      return g;
    };
    const targetGrams = grams(target);
    const scored = [];
    for (const e of entries) {
      const n = norm(e.name);
      let score = 0;
      if (n === target) score = 3;
      else if (n.includes(target) || target.includes(n)) score = 2;
      else {
        const b = grams(n);
        let inter = 0;
        for (const g of targetGrams) if (b.has(g)) inter += 1;
        const dice = targetGrams.size + b.size ? (2 * inter) / (targetGrams.size + b.size) : 0;
        if (dice >= 0.6) score = 1;
      }
      if (score) scored.push({ name: e.name, score });
    }
    scored.sort((x, y) => y.score - x.score || (x.name < y.name ? -1 : 1));
    return scored.slice(0, cap || 3).map((s) => s.name);
  }

  function applyBudget(assembly) {
    if (!assembly || !Array.isArray(assembly.tools)) return assembly;
    let removed = 0;
    const kept = [];
    for (const tool of assembly.tools) {
      if (tool && typeof tool.name === "string" && hiddenReason(tool.name) && !revealed.has(tool.name)) {
        removed += 1;
        continue;
      }
      kept.push(tool);
    }
    if (!removed) return assembly;
    return { ...assembly, tools: kept };
  }

  function install(ctx) {
    const disposers = [];
    const toolsService = ctx && ctx.tools;

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
      const definition = {
        name: BRIDGE_TOOL_NAME,
        description:
          "MCP 工具的按需入口：所有 MCP 工具都不常驻提示词，只用本工具分层展开。"
          + " 不带参数=列出服务器；server=<名>=列出该服务器的工具；"
          + " query=<关键词>=跨服务器检索；names=[工具名]=取回完整参数，随后即可直接调用；"
          + " release=[工具名]=把工具移出可调用列表（取回过的工具默认一直保留，想省上下文时再用）。"
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
            release: {
              type: "array",
              items: { type: "string" },
              description: "要从可调用列表移出的工具名；空数组=列出当前列表，[\"*\"]=清空。取回过的工具默认一直保留，列表不设上限。"
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
              tools: { type: "array", items: { type: "object", additionalProperties: true, properties: {} } },
              lines: { type: "array", items: { type: "string" } },
              active: { type: "array", items: { type: "string" } },
              revealSkipped: { type: "array", items: { type: "string" } }
            },
            required: ["text"]
          },
          render: (_args, value) => [{ type: "text", text: String((value && value.text) || "") }]
        },
        async execute(args, exec) {
          const agent = exec && exec.agent;
          const names = Array.isArray(args && args.names) ? args.names : null;
          const release = Array.isArray(args && args.release) ? args.release : null;
          const query = args && typeof args.query === "string" ? args.query : "";
          const serverArg = args && typeof args.server === "string" ? args.server : "";
          let result;
          if (release) result = releaseResult(release);
          else if (names && names.length) result = loadResult(agent, names);
          else if (serverArg.trim()) result = serverToolsResult(agent, serverArg);
          else if (query.trim()) result = searchResult(agent, query, args && args.limit);
          else result = serverListResult(agent);
          let text = result.text;
          if (result.mode === "schemas") {
            text += "\n\n" + JSON.stringify(result.tools, null, 2);
          } else if (result.mode === "servers" && result.servers) {
            text += "\n" + result.servers.map((s) => s.server + "（" + s.count + " 个工具）").join("\n");
          } else if (result.mode === "hits") {
            text += "\n" + result.lines.join("\n");
          } else if (result.names && result.names.length) {
            text += "\n" + result.names.join("\n");
          }
          return { ...result, text };
        }
      };
      try {
        disposers.push(toolsService.register(definition));
      } catch (e) {
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
