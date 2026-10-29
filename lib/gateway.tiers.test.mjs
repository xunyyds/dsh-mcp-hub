// 三段式渐进披露：服务器 → 工具 → 参数。
//
// 这组测试守的是「常驻成本与工具总数无关」这条承诺：
//   系统提示词里只有 mcp_hub_tools 一个工具名（外加服务器列表）；
//   工具名要 server= 才展开；
//   schema 要 names= 才展开。
//
// 任何一层回到「一次给全」都会让 token 成本重新变成 O(工具数)，
// 而那正是这次改造要消掉的东西。

import assert from "node:assert/strict";
import test from "node:test";

import { createGateway } from "./gateway.js";

const SCHEMAS = [
  { name: "mcp__windows__Screenshot", description: "Take a screenshot of the desktop.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "mcp__windows__ControlStatus", description: "Report control status.", parameters: { type: "object", properties: {} } },
  { name: "mcp__windows__FileSystem", description: "Read and write files.", parameters: { type: "object", properties: { mode: { type: "string" }, path: { type: "string" } } } },
  { name: "mcp__mobile__mobile_take_screenshot", description: "Take a screenshot of the mobile device.", parameters: { type: "object", properties: { device: { type: "string" } } } },
  { name: "mcp__mobile__mobile_list_apps", description: "List installed apps.", parameters: { type: "object", properties: {} } },
  { name: "mcp__rea__analyze_function", description: "Analyze one function.", parameters: { type: "object", properties: {} } }
];

function makeGateway(overrides = {}) {
  return createGateway({
    hiddenReason: (n) => (n.startsWith("mcp__") ? "按需展开" : null),
    blockReason: () => null,
    registry: () => ({ schemas: () => overrides.schemas || SCHEMAS }),
    settings: () => ({}),
    ...overrides.options
  });
}

// ── 第一层：服务器列表 ────────────────────────────────────────
test("第一层：不带参数只返回服务器名与数量，不返回任何工具名", () => {
  const gw = makeGateway();
  const res = gw.serverListResult(null);
  assert.equal(res.mode, "servers");
  assert.deepEqual(res.servers.map((s) => s.server), ["mobile", "rea", "windows"], "服务器列表按名排序");
  assert.equal(res.servers.find((s) => s.server === "windows").count, 3);
  assert.equal(res.servers.find((s) => s.server === "mobile").count, 2);
  // 关键：正文里不能出现任何工具名，否则第一层就退化成第二层了。
  assert.ok(!res.text.includes("mcp__windows__Screenshot"), "第一层不能泄露工具名");
  assert.ok(!res.text.includes("Screenshot"));
});

test("第一层：服务器数量与工具总数分别报出", () => {
  const gw = makeGateway();
  const res = gw.serverListResult(null);
  assert.equal(res.servers.length, 3);
  assert.equal(res.total, 6, "total 是工具总数而非服务器数");
  assert.ok(res.text.includes("3 个可用的 MCP 服务器"), res.text);
  assert.ok(res.text.includes("6 个按需工具"));
});

// ── D1：未命中绝不能倾倒全量工具名 ────────────────────────────
test("D1 未命中只给服务器级摘要，不吐任何工具名", () => {
  const gw = makeGateway();
  const res = gw.searchResult(null, "zzzznotfound", 8);
  assert.equal(res.mode, "servers", "未命中应降级为服务器摘要");
  assert.deepEqual(res.servers.map((s) => s.server), ["mobile", "rea", "windows"]);
  // 关键：正文里不能出现任何具体工具名。
  assert.ok(!res.text.includes("mcp__"), "未命中时出现工具名就是 D1 回归：" + res.text);
  assert.equal(res.names, undefined, "不能带工具名清单");
  assert.ok(res.text.includes("windows（3 个工具）"), "要给出服务器与数量");
});

test("D1 未命中的成本与工具总数无关：262 个工具也不膨胀", () => {
  // 造 262 个工具，验证未命中回复的体积不随工具数增长。
  const many = [];
  for (let i = 0; i < 262; i += 1) {
    many.push({
      name: "mcp__big__tool_" + i,
      description: "Synthetic tool number " + i + ".",
      parameters: { type: "object", properties: { a: { type: "string" } } }
    });
  }
  const gw = makeGateway({ schemas: many });
  const res = gw.searchResult(null, "zzzznotfound", 8);
  const bytes = Buffer.byteLength(res.text);
  assert.ok(bytes < 500, "未命中回复必须保持极小，实际 " + bytes + " 字节");
  assert.ok(!res.text.includes("mcp__big__tool_"), "不能列出任何工具名");
});

test("D1 未命中要如实报出「共 N 个工具、分布在 M 台」，不谎称列了多少", () => {
  const gw = makeGateway();
  const res = gw.searchResult(null, "zzzznotfound", 8);
  assert.ok(res.text.includes("共 6 个工具"));
  assert.ok(res.text.includes("3 个服务器"));
  // 老文案「下面是可检索的 N 个工具名」是误导的根因，不能再出现。
  assert.ok(!res.text.includes("下面是可检索的"), "不能暗示后面跟着全量清单");
});

// ── 无参调用与截断提示 ───────────────────────────────────────
test("无参调用给服务器级摘要，且在未截断时不附工具名", () => {
  const gw = makeGateway();
  const res = gw.listResult ? gw.listResult(gw.visibleCatalog(null)) : null;
  // listResult 不是导出方法，走公共入口验证。
  const viaSearch = gw.searchResult(null, "", 8);
  assert.equal(viaSearch.mode, "servers");
  assert.deepEqual(viaSearch.servers.map((s) => s.server), ["mobile", "rea", "windows"]);
  assert.ok(!viaSearch.text.includes("mcp__"), "未截断时不该附工具名");
});


test("第二层：server=<名> 返回该服务器的工具名与摘要，且不带 schema", () => {
  const gw = makeGateway();
  const res = gw.serverToolsResult(null, "windows");
  assert.equal(res.mode, "hits");
  assert.equal(res.server, "windows");
  // lines 是渲染好的文本行：名字 + 摘要（+ 零参数标注）。
  const lines = res.lines.join("\n");
  for (const name of ["mcp__windows__ControlStatus", "mcp__windows__FileSystem", "mcp__windows__Screenshot"]) {
    assert.ok(lines.includes(name), "缺工具名 " + name);
  }
  assert.equal(res.lines.length, 3);
  assert.ok(lines.includes(" — "), "要有摘要帮模型判断");
  assert.ok(!JSON.stringify(res).includes("\"properties\""), "不能夹带参数结构");
});

test("D4 第二层对零参数工具标注「无参数」，允许跳过 names 往返", () => {
  const gw = makeGateway();
  const res = gw.serverToolsResult(null, "windows");
  const lines = res.lines.join("\n");
  // ControlStatus 的 properties 是 {} —— 零参数，应被标注。
  const controlLine = res.lines.find((l) => l.includes("ControlStatus"));
  assert.ok(controlLine.includes("无参数"), "零参数工具要标出来：" + controlLine);
  // Screenshot 有一个 path 参数，不能被误标。
  const shotLine = res.lines.find((l) => l.includes("Screenshot"));
  assert.ok(!shotLine.includes("无参数"), "有参数的工具不能被标成无参数：" + shotLine);
  assert.ok(res.text.includes("无参数"), "说明文字要告诉模型这个标注的含义：" + res.text);
});

test("第二层：服务器名大小写不敏感", () => {
  const gw = makeGateway();
  const res = gw.serverToolsResult(null, "WINDOWS");
  assert.equal(res.mode, "hits");
  assert.equal(res.lines.length, 3);
});

test("第二层：未知服务器如实说没有，并给出可用列表", () => {
  const gw = makeGateway();
  const res = gw.serverToolsResult(null, "nope");
  assert.ok(res.text.includes("没有名为「nope」的服务器"));
  assert.ok(res.text.includes("windows"), "要告诉模型有哪些可选");
  assert.equal(res.servers.length, 3);
});

// ── 第三层：完整参数 ─────────────────────────────────────────
test("第三层：names 返回完整参数，可按名字直接调用", () => {
  const gw = makeGateway();
  const res = gw.loadResult(null, ["mcp__windows__Screenshot"]);
  assert.equal(res.mode, "schemas");
  assert.equal(res.tools.length, 1);
  assert.deepEqual(res.tools[0].parameters.properties, { path: { type: "string" } });
  assert.deepEqual(res.tools[0].parameters.required, ["path"]);
});

// ── 调度优先级与正文渲染 ─────────────────────────────────────
async function callBridge(gw, args) {
  const ctx = {
    on: () => () => {},
    tools: {
      register(def) {
        ctx.__def = def;
        return () => {};
      }
    }
  };
  gw.install(ctx);
  return ctx.__def.execute(args, { agent: null });
}

test("调度：names > server > query > 无参", async () => {
  const gw = makeGateway();
  const byNames = await callBridge(gw, { names: ["mcp__windows__Screenshot"], server: "mobile", query: "zzz" });
  assert.equal(byNames.mode, "schemas", "names 最具体，优先");
  const byServer = await callBridge(gw, { server: "mobile", query: "zzz" });
  assert.equal(byServer.mode, "hits");
  assert.equal(byServer.server, "mobile");
  const byQuery = await callBridge(gw, { query: "screenshot" });
  assert.equal(byQuery.mode, "hits");
  const byNone = await callBridge(gw, {});
  assert.equal(byNone.mode, "servers");
});

test("正文渲染：服务器列表与工具名都要进 text（结构化数组到不了模型眼前）", async () => {
  const gw = makeGateway();
  const servers = await callBridge(gw, {});
  assert.ok(servers.text.includes("windows"), "服务器名要在正文里");
  assert.ok(servers.text.includes("（3 个工具）"), "数量也要在正文里");
  const tools = await callBridge(gw, { server: "windows" });
  assert.ok(tools.text.includes("mcp__windows__Screenshot"), "工具名要在正文里");
  assert.ok(tools.text.includes("Take a screenshot"), "摘要也要在正文里");
  const schema = await callBridge(gw, { names: ["mcp__windows__FileSystem"] });
  assert.ok(schema.text.includes("\"mode\""), "参数要进正文");
});

test("mcp_hub_tools 的参数表包含 server，且只有这四个", () => {
  const gw = makeGateway();
  const ctx = {
    on: () => () => {},
    tools: {
      register(def) {
        ctx.__def = def;
        return () => {};
      }
    }
  };
  gw.install(ctx);
  assert.deepEqual(Object.keys(ctx.__def.parameters.properties).sort(), ["limit", "names", "query", "server"]);
  assert.equal(ctx.__def.name, "mcp_hub_tools");
});

// ── D8：返回值必须通过注册时声明的 output schema ──────────────
// 这组测试存在的原因：D7 那次回归里，28 个用例全绿，线上却全崩。
// 因为测试只断言 serverToolsResult / searchResult 的返回值本身，从不拿
// definition.output.schema 去校验它。命中行由对象改成字符串后，schema 仍声明
// items:{type:"object"}，harness 按声明校验，整包判非法并丢弃——server= 与
// query= 两条路径同时失效，而没有任何一个测试变红。
// 补上这道守卫：schema 与实现不一致，就必须在这里红。
function jsonType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function checkOutput(schema, value, path) {
  const problems = [];
  if (!schema || schema.type !== "object" || !value || typeof value !== "object") return problems;
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    if (value[key] === undefined) continue;
    const v = value[key];
    const at = path + key;
    if (spec.type === "string" && typeof v !== "string") problems.push(at + ": 期望 string，实得 " + jsonType(v));
    if (spec.type === "integer" && !Number.isInteger(v)) problems.push(at + ": 期望 integer，实得 " + jsonType(v));
    if (spec.type === "array") {
      if (!Array.isArray(v)) {
        problems.push(at + ": 期望 array，实得 " + jsonType(v));
        continue;
      }
      const want = spec.items && spec.items.type;
      v.forEach((el, i) => {
        const got = jsonType(el);
        if (want === "string" && got !== "string") problems.push(at + "[" + i + "]: 期望 string，实得 " + got);
        if (want === "object" && got !== "object") problems.push(at + "[" + i + "]: 期望 object，实得 " + got);
      });
    }
  }
  return problems;
}

test("D8 四种模式的真实返回值都要通过 output schema", async () => {
  const gw = makeGateway();
  const ctx = {
    on: () => () => {},
    tools: {
      register(def) {
        ctx.__def = def;
        return () => {};
      }
    }
  };
  gw.install(ctx);
  const schema = ctx.__def.output.schema;
  const cases = [
    ["servers", {}],
    ["hits/server=", { server: "windows" }],
    ["hits/query=", { query: "screenshot" }],
    ["schemas", { names: ["mcp__windows__Screenshot"] }]
  ];
  for (const [label, args] of cases) {
    const value = await ctx.__def.execute(args, { agent: null });
    assert.deepEqual(checkOutput(schema, value, "value."), [], label + " 的返回体不符合 output schema");
  }
});

test("D8 命中行放 lines 而非 tools：两者类型不同，不能共用字段", async () => {
  const gw = makeGateway();
  const hits = gw.serverToolsResult(null, "windows");
  assert.ok(Array.isArray(hits.lines) && hits.lines.length === 3, "命中行要在 lines：" + JSON.stringify(hits.lines));
  assert.equal(hits.tools, undefined, "hits 不能再往 tools 塞字符串，那会被 schema 判非法");
  const schemas = gw.loadResult(null, ["mcp__windows__Screenshot"]);
  assert.equal(schemas.lines, undefined, "tools 与 lines 各走各的模式");
  assert.equal(jsonType(schemas.tools[0]), "object", "schemas 模式的 tools 必须是对象数组");
});

// ── 空目录不能落进任何误导性分支 ─────────────────────────────
test("空目录：三层都给「没有工具」，而不是「换个词」", async () => {
  const gw = makeGateway({ schemas: [] });
  for (const args of [{}, { server: "windows" }, { query: "x" }]) {
    const res = await callBridge(gw, args);
    assert.equal(res.mode, "empty", "空目录必须能与其他分支区分：" + JSON.stringify(args));
    assert.ok(res.text.includes("换关键词也不会有结果"));
  }
});

// ── 分层不能破坏「摘掉仍可调用」 ──────────────────────────────
test("分层后 lazy 依旧可调用：blockReason 不因分层而变真", () => {
  const gw = makeGateway();
  const out = gw.applyBudget({ tools: SCHEMAS.map((s) => ({ ...s })).concat([{ name: "read", description: "builtin", parameters: {} }]) });
  assert.deepEqual(out.tools.map((t) => t.name), ["read"], "全部 MCP schema 都被摘掉，内置工具保留");
  // 但取回路径必须仍然通。
  assert.equal(gw.loadResult(null, ["mcp__windows__Screenshot"]).tools.length, 1);
});
