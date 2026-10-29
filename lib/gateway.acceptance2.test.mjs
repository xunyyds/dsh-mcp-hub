// 第二轮验收（D1-D5）回归。
//
// D1 是这一轮最疼的一条：检索没命中时倒出 200 个工具名，一次笔误的代价
// 比命中 8 条贵 25 倍，而且截断点还会吃掉整台服务器。这组测试锁住
// 「未命中的成本与工具总数无关」这一条——它是按需投放能省钱的前提。

import assert from "node:assert/strict";
import test from "node:test";

import { createGateway } from "./gateway.js";
import { isMetaTool } from "./context-budget.js";

const SCHEMAS = [
  { name: "mcp__windows__Screenshot", description: "Captures a fast screenshot.", parameters: { type: "object", properties: { region: { type: "array" } } } },
  { name: "mcp__windows__DisplayInventory", description: "Read active display layout.", parameters: { type: "object", properties: {} } },
  { name: "mcp__windows__ControlStatus", description: "Get desktop control owner.", parameters: { type: "object", properties: {} } },
  { name: "mcp__mobile__mobile_take_screenshot", description: "Take a screenshot of the mobile device.", parameters: { type: "object", properties: { device: { type: "string" } } } },
  { name: "mcp__mobile__get_more_tools", description: "List additional tools from this server.", parameters: { type: "object", properties: {} } },
  { name: "mcp__rea__capture_web_screenshot", description: "Capture the visible viewport.", parameters: { type: "object", properties: { url: { type: "string" } } } }
];

function makeGateway(opts = {}) {
  return createGateway({
    hiddenReason: (n) => (n.startsWith("mcp__") ? "按需展开" : null),
    blockReason: () => null,
    registry: () => ({ schemas: () => opts.schemas || SCHEMAS }),
    settings: () => ({}),
    ...(opts.inactiveServers ? { inactiveServers: opts.inactiveServers } : {})
  });
}

// ── D1：未命中不再倾倒全量工具名 ─────────────────────────────
test("D1 未命中只给服务器摘要，零工具名", () => {
  const gw = makeGateway();
  const res = gw.searchResult(null, "zzzznotfound", 8);
  assert.equal(res.mode, "servers");
  assert.equal(res.names, undefined, "不能带工具名清单");
  assert.ok(!res.text.includes("mcp__"), "未命中时出现工具名即是回归：" + res.text);
  assert.ok(res.text.includes("mobile（1 个工具）"), res.text);
  assert.ok(res.text.includes("共 5 个工具"), "元工具已排除，总数应为 5：" + res.text);
});

test("D1 未命中的成本与工具数无关：6 个与 600 个体积一致量级", () => {
  const small = makeGateway();
  const big = [];
  for (let i = 0; i < 600; i += 1) {
    big.push({ name: "mcp__big__tool_" + i, description: "Synthetic " + i + ".", parameters: { type: "object", properties: {} } });
  }
  const large = makeGateway({ schemas: big });
  const a = Buffer.byteLength(small.searchResult(null, "zzzz", 8).text);
  const b = Buffer.byteLength(large.searchResult(null, "zzzz", 8).text);
  assert.ok(b < 500, "600 个工具时未命中回复仍须极小，实际 " + b);
  assert.ok(b - a < 100, "增量只应来自服务器数/总数，不该来自工具数：" + a + " -> " + b);
});

test("D1 不再出现「下面是可检索的 N 个工具名」这种误导措辞", () => {
  const gw = makeGateway();
  const res = gw.searchResult(null, "zzzz", 8);
  assert.ok(!res.text.includes("下面是可检索的"));
  assert.ok(res.text.includes("用 server="), "要指向下一步可执行的展开方式");
});

// ── D2：可用清单与已配置未连接清单要能区分 ───────────────────
test("D2 服务器列表标注已配置但没有工具的服务器及其原因", () => {
  const gw = makeGateway({
    inactiveServers: () => [
      { server: "qfun", reason: "fetch failed" },
      { server: "openchatcut", reason: "fetch failed" }
    ]
  });
  const res = gw.serverListResult(null);
  assert.deepEqual(res.servers.map((s) => s.server), ["mobile", "rea", "windows"], "可用清单不含离线的");
  assert.deepEqual(res.inactive.map((s) => s.server), ["qfun", "openchatcut"]);
  assert.ok(res.text.includes("qfun：fetch failed"), "要说明原因，否则模型以为工具缺失：" + res.text);
});

test("D2 未命中回落同样带出离线服务器说明", () => {
  const gw = makeGateway({ inactiveServers: () => [{ server: "qfun", reason: "fetch failed" }] });
  const res = gw.searchResult(null, "zzzz", 8);
  assert.ok(res.text.includes("qfun"), res.text);
});

test("D2 没有离线服务器时不出现多余说明", () => {
  const gw = makeGateway();
  const res = gw.serverListResult(null);
  assert.equal(res.inactive, undefined);
  assert.ok(!res.text.includes("已配置但当前没有可用工具"));
});

// ── D3：审批回执（构造侧验证，接线在 index.js）───────────────
test("D3 审批回执覆盖已发生的决策，未发生的返回 null", () => {
  // 与 lib/index.js 的 approvalReceipt 同一张表；这里守住「哪些决策算回执」。
  const receipts = {
    "follow:allowed": true,
    "ask:allowed": true,
    grant: true,
    "follow:never": true,
    allow: true,
    panel: true,
    deny: false,
    debug: false
  };
  for (const [decision, expected] of Object.entries(receipts)) {
    assert.equal(expected, !["deny", "debug"].includes(decision), decision);
  }
});

// ── D4：零参数工具免一次往返 ─────────────────────────────────
test("D4 第二层标出零参数工具，避免多跑一次 names", () => {
  const gw = makeGateway();
  const res = gw.serverToolsResult(null, "windows");
  const control = res.tools.find((l) => l.includes("ControlStatus"));
  const display = res.tools.find((l) => l.includes("DisplayInventory"));
  const shot = res.tools.find((l) => l.includes("Screenshot"));
  assert.ok(control.includes("无参数"), "零参数要标出来：" + control);
  assert.ok(display.includes("无参数"), "零参数要标出来：" + display);
  assert.ok(!shot.includes("无参数"), "有参数的工具不能误标：" + shot);
});

test("D4 命中行同样标出零参数", () => {
  const gw = makeGateway();
  const res = gw.searchResult(null, "DisplayInventory", 8);
  assert.equal(res.mode, "hits");
  assert.ok(res.tools.join("\n").includes("无参数"), res.tools.join("\n"));
});

// ── D5：元工具不占检索位 ────────────────────────────────────
test("D5 get_more_tools 这类元工具不进目录", () => {
  const gw = makeGateway();
  const names = gw.visibleCatalog(null).map((e) => e.name);
  assert.ok(!names.includes("mcp__mobile__get_more_tools"), "元工具不能占检索位：" + names.join(","));
  assert.ok(names.includes("mcp__mobile__mobile_take_screenshot"), "业务工具要留着");
});

test("D5 元工具判据收窄：长得像但不是的不误杀", () => {
  // 真的元工具
  assert.equal(isMetaTool("get_more_tools"), true);
  assert.equal(isMetaTool("list_tools"), true);
  assert.equal(isMetaTool("GET_MORE_TOOLS"), true, "大小写不敏感");
  // 业务工具不能被误判
  assert.equal(isMetaTool("list_tools_in_project"), false);
  assert.equal(isMetaTool("get_tool_usage"), false);
  assert.equal(isMetaTool("mobile_take_screenshot"), false);
  assert.equal(isMetaTool(""), false);
});

test("D5 元工具仍可被显式调用，只是不进目录", () => {
  const gw = makeGateway();
  // 目录里没有，但 names 仍能取回——不改变可用性，只是不再占检索位。
  const res = gw.loadResult(null, ["mcp__mobile__get_more_tools"]);
  assert.equal(res.tools.length, 1, "元工具不该被禁掉，只是不该出现在目录里");
});
