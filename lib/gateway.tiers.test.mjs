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
  assert.ok(res.text.includes("3 个 MCP 服务器"));
  assert.ok(res.text.includes("6 个按需工具"));
});

// ── 第二层：某服务器的工具 ────────────────────────────────────
test("第二层：server=<名> 返回该服务器的工具名与摘要，且不带 schema", () => {
  const gw = makeGateway();
  const res = gw.serverToolsResult(null, "windows");
  assert.equal(res.mode, "hits");
  assert.equal(res.server, "windows");
  assert.deepEqual(res.tools.map((t) => t.name).sort(), [
    "mcp__windows__ControlStatus",
    "mcp__windows__FileSystem",
    "mcp__windows__Screenshot"
  ]);
  assert.ok(res.tools[0].summary.length > 0, "要有摘要帮模型判断");
  assert.equal(res.tools[0].parameters, undefined, "第二层不能给 schema");
  assert.ok(!JSON.stringify(res).includes("\"properties\""), "不能夹带参数结构");
});

test("第二层：服务器名大小写不敏感", () => {
  const gw = makeGateway();
  const res = gw.serverToolsResult(null, "WINDOWS");
  assert.equal(res.mode, "hits");
  assert.equal(res.tools.length, 3);
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
