// 验收回归：D1-D6。
//
// 这组测试逐条锁住「按需投放」被自己废掉的那次事故。核心是两件事：
//   1) hiddenReason（不进提示词）与 blockReason（禁止调用）是两个谓词，
//      lazy 只在第一个里为真，在第二个里必须为假；
//   2) 摘掉的 schema 必须仍然能被检索、取回、调用。
//
// 每条断言都对应一份现场证据，别把它们当成「顺手加的覆盖」。

import assert from "node:assert/strict";
import test from "node:test";

import { createGateway } from "./gateway.js";
import { firstSentence } from "./context-budget.js";

// 复刻插件里的两个谓词，语义与 lib/index.js 保持一致：
//   blockReason：整台禁用 / 逐工具禁用 / off 档位
//   hiddenReason：blockReason 为真，或「任何未被禁止的服务器」
//
// 注意 full 档位现在也走按需展开（用户决定统一配置，不为 full 单开
// 一条常驻路径），所以 hiddenReason 对 full 同样为真。这组测试随语义更新：
// 不变的是「blockReason 只到真禁用的地方」，那才是 D1-D4 的根因。
const SERVERS = {
  lazysrv: { enabled: true, tier: "lazy", tools: {} },
  fullsrv: { enabled: true, tier: "full", tools: {} },
  offsrv: { enabled: true, tier: "off", tools: {} },
  disabledsrv: { enabled: false, tier: "full", tools: {} },
  tooloff: { enabled: true, tier: "full", tools: { banned: { enabled: false } } }
};

function serverOf(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (!m) return null;
  const key = m[1];
  return Object.prototype.hasOwnProperty.call(SERVERS, key) ? { name: key, ...SERVERS[key] } : null;
}

function blockReason(fullName) {
  const server = serverOf(fullName);
  if (!server) return null;
  if (server.enabled === false) return "服务器禁用";
  if (server.tier === "off") return "档位是 off";
  const tool = fullName.slice(("mcp__" + server.name + "__").length);
  if (server.tools[tool] && server.tools[tool].enabled === false) return "工具禁用";
  return null;
}

function hiddenReason(fullName) {
  if (blockReason(fullName)) return blockReason(fullName);
  return serverOf(fullName) ? "按需展开" : null;
}

const SCHEMAS = [
  { name: "mcp__lazysrv__Screenshot", description: "Take a screenshot of the desktop.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "mcp__lazysrv__ControlStatus", description: "Report control status.", parameters: { type: "object", properties: {} } },
  { name: "mcp__fullsrv__Ping", description: "Ping.", parameters: { type: "object", properties: {} } },
  { name: "mcp__offsrv__Hidden", description: "Never callable.", parameters: { type: "object", properties: {} } },
  { name: "mcp__disabledsrv__Gone", description: "Server disabled.", parameters: { type: "object", properties: {} } },
  { name: "mcp__tooloff__banned", description: "Tool disabled.", parameters: { type: "object", properties: {} } }
];

function makeGateway() {
  return createGateway({
    hiddenReason,
    blockReason,
    registry: () => ({ schemas: () => SCHEMAS }),
    settings: () => ({})
  });
}

// ── D1：lazy 的 schema 必须取得回 ─────────────────────────────
test("D1 lazy 服务器的 schema 可以被取回，不能被报成「已禁用」", () => {
  const gw = makeGateway();
  const res = gw.loadResult(null, ["mcp__lazysrv__Screenshot"]);
  assert.equal(res.tools.length, 1, "lazy 的 schema 必须取回");
  assert.equal(res.mode, "schemas");
  assert.deepEqual(res.tools[0].parameters.properties, { path: { type: "string" } });
  assert.equal(res.blocked, undefined, "lazy 不是「已禁用」，绝不能进 blocked");
  assert.ok(!res.text.includes("已禁用"), "措辞不能说它是禁用：" + res.text);
});

test("D1 lazy 仍然不进提示词：hiddenReason 为真，摘掉行为不变", () => {
  const gw = makeGateway();
  const out = gw.applyBudget({ tools: SCHEMAS.map((s) => ({ ...s })) });
  const names = out.tools.map((t) => t.name);
  assert.ok(!names.includes("mcp__lazysrv__Screenshot"), "lazy 必须从请求里摘掉");
  // full 也走按需：统一配置后不再有服务器常驻 schema。
  assert.ok(!names.includes("mcp__fullsrv__Ping"), "full 同样摘掉，不再单开常驻路径");
});

// ── D2：目录必须覆盖 lazy，且不能留 off/禁用 ────────────────
test("D2 检索目录覆盖 lazy，排除 off / 整台禁用 / 工具禁用", () => {
  const gw = makeGateway();
  const names = gw.visibleCatalog(null).map((e) => e.name).sort();
  assert.deepEqual(names, ["mcp__fullsrv__Ping", "mcp__lazysrv__ControlStatus", "mcp__lazysrv__Screenshot"].sort());
  assert.ok(!names.some((n) => n.startsWith("mcp__offsrv__")), "off 档位不该出现在目录");
  assert.ok(!names.some((n) => n.startsWith("mcp__disabledsrv__")), "整台禁用不该出现在目录");
  assert.ok(!names.some((n) => n === "mcp__tooloff__banned"), "逐工具禁用不该出现在目录");
});

test("D2 现场证据：query=windows 这类按服务器名的检索必须能命中该服务器工具", () => {
  const gw = makeGateway();
  const byServer = gw.searchResult(null, "lazysrv", 8);
  assert.equal(byServer.mode, "hits", "按服务器名检索必须命中，不能退化成别人的名字列表");
  assert.equal(byServer.tools.length, 2);
  const byTool = gw.searchResult(null, "screenshot", 8);
  assert.equal(byTool.mode, "hits");
  assert.ok(byTool.tools.some((t) => String(t).includes("mcp__lazysrv__Screenshot")));
});

// ── D3：不存在的名字必须报「未找到」，不能说成「已禁用」 ──────
test("D3 不存在的工具名报「未找到」，不被误报为禁用", () => {
  const gw = makeGateway();
  const res = gw.loadResult(null, ["mcp__lazysrv__DefinitelyNotARealTool"]);
  assert.deepEqual(res.unknown, ["mcp__lazysrv__DefinitelyNotARealTool"]);
  assert.equal(res.blocked, undefined, "不存在的名字不能进 blocked");
  assert.ok(res.text.includes("未找到"));
  assert.ok(!res.text.includes("已禁用"));
});

test("D3 真假混合：存在的取回、不存在的报未知、真禁用的才报拦截", () => {
  const gw = makeGateway();
  const res = gw.loadResult(null, ["mcp__lazysrv__Screenshot", "mcp__nope__nope", "mcp__offsrv__Hidden"]);
  assert.equal(res.tools.length, 1, "只有真实可用的那个被取回");
  assert.deepEqual(res.unknown, ["mcp__nope__nope"]);
  assert.deepEqual(res.blocked, ["mcp__offsrv__Hidden"]);
});

// ── D4：如实转述拦截原因 ─────────────────────────────────────
test("D4 被拦截时说明真实原因，不硬编码「已禁用」", () => {
  const gw = makeGateway();
  const off = gw.loadResult(null, ["mcp__offsrv__Hidden"]);
  assert.ok(off.text.includes("档位是 off"), "必须说清是档位而非禁用：" + off.text);

  const banned = gw.loadResult(null, ["mcp__tooloff__banned"]);
  assert.ok(banned.text.includes("工具禁用"));
});

// ── D6：全失败时不能只回裸 [] ───────────────────────────────
test("D6 一个都没取到且名字没错时，附带可用目录而不是只给空数组", () => {
  const gw = makeGateway();
  const res = gw.loadResult(null, ["mcp__offsrv__Hidden", "mcp__disabledsrv__Gone"]);
  assert.equal(res.tools.length, 0);
  assert.equal(res.mode, "empty-load", "要能被渲染层识别为「需要给目录」");
  assert.ok(Array.isArray(res.names) && res.names.length > 0, "必须给出还能用什么");
  assert.ok(res.names.includes("mcp__lazysrv__Screenshot"));
});

test("D6 execute 把目录正文送进模型可见文本", async () => {
  const gw = makeGateway();
  const ctx = { tools: { register: (d) => { ctx.__def = d; return () => {}; } }, on: () => () => {} };
  gw.install(ctx);
  const out = await ctx.__def.execute({ names: ["mcp__offsrv__Hidden"] }, { agent: null });
  assert.ok(out.text.includes("mcp__lazysrv__Screenshot"), "目录必须出现在正文里，否则模型看不到");
});

test("D6 检索命中的名字也必须进正文（结构化数组到不了模型眼前）", async () => {
  const gw = makeGateway();
  const ctx = { tools: { register: (d) => { ctx.__def = d; return () => {}; } }, on: () => () => {} };
  gw.install(ctx);
  const out = await ctx.__def.execute({ query: "screenshot" }, { agent: null });
  assert.ok(out.text.includes("mcp__lazysrv__Screenshot"));
  assert.ok(out.text.includes("screenshot"), "摘要也要进正文");
});

// ── D5：e.g. 之类的缩写不能把摘要切断 ────────────────────────
test("D5 缩写处的句点不断句（现场证据：(e. 被切开）", () => {
  const real = "Click on the screen, either at x,y coordinates or on an element by its ref (e.g. \"@e5\") from the latest mobile_list_elements_on_screen result.";
  const got = firstSentence(real);
  assert.ok(!got.endsWith("(e."), "不能切在 (e. 上，实际：" + got);
  assert.ok(got.includes("e.g."), "缩写要完整保留：" + got);
});

test("D5 常见缩写 e.g. / i.e. 不断句；etc. / Dr. 按下一句起头判断", () => {
  // e.g. / i.e.：括号内或后接小写，都不该切。
  assert.ok(!firstSentence("Use the ref (e.g. the one returned). Done.").endsWith("e.g."));
  assert.equal(firstSentence("Pass any object (i.e. JSON). Done."), "Pass any object (i.e. JSON).");
  // etc. 后接大写起头的下一句 → 是句末。
  assert.equal(firstSentence("Returns names, ids, etc. Then stops."), "Returns names, ids, etc.");
  // Dr. 是头衔，后面的大写仍属同一句。
  assert.equal(firstSentence("Reported by Dr. Smith. Done."), "Reported by Dr. Smith.");
});

test("D5 正常词结尾的句点仍然断句（缩写表不能误伤 ref / min / no）", () => {
  // 把 ref / min / max / no 收进缩写表会让正常句末永远不切，摘要退回一整段。
  assert.equal(firstSentence("Click on the element by its ref. Then wait."), "Click on the element by its ref.");
  assert.equal(firstSentence("Set the value to the min. Then save."), "Set the value to the min.");
});

test("D5 正常英文句末仍然截断，中文字符串也照旧", () => {
  assert.equal(firstSentence("Analyze one function. Then do more."), "Analyze one function.");
  assert.equal(firstSentence("中文第一句。第二句。"), "中文第一句。");
  assert.equal(firstSentence(""), "");
  assert.equal(firstSentence(undefined), "");
});

// ── 防回归：两个谓词不传 blockReason 时不能静默出错 ──────────
test("未传 blockReason 时退化用 hiddenReason（旧调用方兼容），但插件本体必须显式传", () => {
  const gw = createGateway({ hiddenReason: () => "x", registry: () => ({ schemas: () => SCHEMAS }) });
  // 退化后行为等同旧版：取回被拒——这正是要被插件侧显式传入修掉的那条路径。
  const res = gw.loadResult(null, ["mcp__lazysrv__Screenshot"]);
  assert.equal(res.tools.length, 0);
  assert.deepEqual(res.blocked, ["mcp__lazysrv__Screenshot"]);
});
