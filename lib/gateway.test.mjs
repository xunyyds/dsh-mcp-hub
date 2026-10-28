// 网关行为：提示词过滤、检索、取回、以及「卸载后不留痕」。
//
// 这组测试刻意用假的 ctx / registry 而不是真 DSH：网关的契约是
// 「只碰 mcp__ 前缀、只对自己注册的东西负责」，那是纯函数级的约定，
// 用真的 agent-loop 反而测不出「摘掉但仍可调用」这一条。

import assert from "node:assert/strict";
import test from "node:test";

import { createGateway } from "./gateway.js";

const TOOLS = [
  { name: "mcp__alpha__search", description: "Search things in alpha. Lots of detail.", parameters: { type: "object", properties: { q: { type: "string" } } } },
  { name: "mcp__alpha__capture", description: "Capture a screenshot from alpha.", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "mcp__beta__download", description: "Download a file.", parameters: { type: "object", properties: { url: { type: "string" } } } },
  { name: "read", description: "builtin read", parameters: { type: "object", properties: {} } }
];

function makeCtx() {
  const listeners = [];
  const registered = [];
  const ctx = {
    on(event, fn) {
      listeners.push({ event, fn });
      return () => {
        const at = listeners.findIndex((l) => l.fn === fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    tools: {
      register(def) {
        registered.push(def);
        return () => {
          const at = registered.indexOf(def);
          if (at >= 0) registered.splice(at, 1);
        };
      }
    },
    __listeners: listeners,
    __registered: registered
  };
  return ctx;
}

function makeRegistry(toolsByScope) {
  return {
    schemas(agent) {
      return (toolsByScope && toolsByScope(agent)) || TOOLS;
    }
  };
}

test("applyBudget：只摘 mcp__ 前缀，内置工具与其余字段原样保留", () => {
  const gw = createGateway({ hiddenReason: (n) => (n.startsWith("mcp__") ? "lazy" : null), registry: () => null });
  const assembly = { tools: TOOLS, sections: [{ name: "s", text: "x" }], contexts: [] };
  const out = gw.applyBudget(assembly);
  assert.deepEqual(out.tools.map((t) => t.name), ["read"], "只有内置工具留下");
  assert.deepEqual(out.sections, assembly.sections, "其他字段不能被复制丢内容");
  assert.equal(assembly.tools.length, 4, "不得原地修改调用方的数组");
});

test("applyBudget：没有可摘的就返回同一个对象，避免每步都产生新 assembly", () => {
  const gw = createGateway({ hiddenReason: () => null, registry: () => null });
  const assembly = { tools: TOOLS };
  assert.equal(gw.applyBudget(assembly), assembly);
  const noTools = {};
  assert.equal(gw.applyBudget(noTools), noTools, "缺 tools 时也返回同一引用");
});

test("install：钩子在 next() 之后才过滤，保证别人加的 schema 也被覆盖", async () => {
  const ctx = makeCtx();
  const gw = createGateway({ hiddenReason: (n) => (n.startsWith("mcp__") ? "lazy" : null), registry: () => makeRegistry() });
  const dispose = gw.install(ctx);

  const hook = ctx.__listeners.find((l) => l.event === "system-prompt/assemble");
  assert.ok(hook, "必须注册 system-prompt/assemble 钩子");
  const downstream = { tools: TOOLS };
  let calledNext = false;
  const out = await hook.fn({ tools: [] }, {}, async () => {
    calledNext = true;
    return downstream;
  });
  assert.ok(calledNext, "必须先让下游组装完");
  assert.deepEqual(out.tools.map((t) => t.name), ["read"]);
  dispose();
  assert.equal(ctx.__listeners.length, 0, "卸载后监听器必须清空");
  assert.equal(ctx.__registered.length, 0, "卸载后检索工具必须注销");
});

test("install：钩子内部抛错时退回下游结果，不能把整个请求打挂", async () => {
  const ctx = makeCtx();
  const gw = createGateway({
    hiddenReason: () => {
      throw new Error("boom");
    },
    registry: () => makeRegistry()
  });
  gw.install(ctx);
  const hook = ctx.__listeners.find((l) => l.event === "system-prompt/assemble");
  const downstream = { tools: TOOLS };
  const out = await hook.fn({ tools: [] }, {}, async () => downstream);
  assert.equal(out, downstream, "异常必须 fail open 到「不省 token 但能用」");
});

test("检索：命中返回名字+摘要，不返回参数 schema", () => {
  const ctx = makeCtx();
  const gw = createGateway({ hiddenReason: () => null, registry: () => makeRegistry() });
  gw.install(ctx);
  const res = gw.searchResult(null, "capture", 8);
  assert.equal(res.mode, "hits");
  assert.equal(res.tools.length, 1);
  assert.equal(res.tools[0].name, "mcp__alpha__capture");
  assert.ok(res.tools[0].summary.startsWith("Capture a screenshot"));
  assert.equal(res.tools[0].parameters, undefined, "命中结果不能带 schema，否则又付一次成本");
  assert.ok(!JSON.stringify(res).includes("inputSchema"));
});

test("检索：一个都没命中时退回「全部工具名」，且只有名字", () => {
  const ctx = makeCtx();
  const gw = createGateway({ hiddenReason: () => null, registry: () => makeRegistry() });
  gw.install(ctx);
  const res = gw.searchResult(null, "zzzznotfound", 8);
  assert.equal(res.mode, "names");
  assert.deepEqual(res.names, ["mcp__alpha__search", "mcp__alpha__capture", "mcp__beta__download", "read"].filter((n) => n.startsWith("mcp__")));
  assert.equal(res.tools, undefined);
});

test("检索：被 blockReason 的工具既不出现在名字列表也不可被取回", () => {
  const ctx = makeCtx();
  const gw = createGateway({
    hiddenReason: () => null,
    registry: () => makeRegistry(),
    // 模拟「禁用」：hiddenReason 为空但 blockReason 生效的情况在这里等价于
    // 直接在用 hiddenReason 之外再筛一次——网关只认 hiddenReason，
    // 所以这里用 hiddenReason 表达禁用，顺带验证它确实双过滤。
  });
  gw.install(ctx);
  const blocked = createGateway({
    hiddenReason: (n) => (n === "mcp__beta__download" ? "禁用" : null),
    registry: () => makeRegistry()
  });
  blocked.install(ctx);
  const names = blocked.searchResult(null, "zzzz", 8).names;
  assert.ok(!names.includes("mcp__beta__download"), "禁用的工具不能出现在目录里");
  const loaded = blocked.loadResult(null, ["mcp__beta__download"]);
  assert.deepEqual(loaded.tools, [], "禁用工具不能被取回");
  assert.deepEqual(loaded.blocked, ["mcp__beta__download"]);
});

test("取回：返回完整参数，可按名字直接调用", () => {
  const ctx = makeCtx();
  const gw = createGateway({ hiddenReason: () => null, registry: () => makeRegistry() });
  gw.install(ctx);
  const res = gw.loadResult(null, ["mcp__alpha__capture"]);
  assert.equal(res.mode, "schemas");
  assert.equal(res.tools.length, 1);
  assert.deepEqual(res.tools[0].parameters.properties, { path: { type: "string" } });
  assert.equal(res.tools[0].parametersTruncated, undefined);
});

test("取回：超胖 schema 降级为浅视图并明确标注", () => {
  const ctx = makeCtx();
  const fat = {
    type: "object",
    description: "big one",
    properties: { a: { type: "string", description: "must keep me" } },
    required: ["a"]
  };
  for (let i = 0; i < 400; i++) {
    fat.properties["p" + i] = {
      type: "string",
      description: "parameter number " + i + " with a very long explanation ".repeat(3),
      enum: ["x", "y"]
    };
  }
  const big = [{ name: "mcp__fat__big", description: "big", parameters: fat }];
  const gw = createGateway({ hiddenReason: () => null, registry: () => makeRegistry(() => big) });
  const res = gw.loadResult(null, ["mcp__fat__big"]);
  assert.equal(res.tools[0].parametersTruncated, true, "超限必须降级");
  assert.ok(Buffer.byteLength(JSON.stringify(res.tools[0].parameters)) < 24000, "降级后必须真的落回预算内");
  assert.deepEqual(res.tools[0].parameters.required, ["a"], "必需参数优先保留");
  assert.equal(res.tools[0].parameters.properties.a.type, "string", "必需参数的类型必须还在");
  assert.ok(
    res.tools[0].parametersOmitted > 0 || res.text.includes("压缩为类型摘要"),
    "必须如实报出省略了什么（整条属性或嵌套细节）"
  );
});

test("取回：必需参数再多也不被丢弃，丢的永远是可选参数", () => {
  const ctx = makeCtx();
  const params = { type: "object", properties: {}, required: [] };
  for (let i = 0; i < 60; i++) {
    params.properties["req" + i] = { type: "string", description: "required " + i };
    params.required.push("req" + i);
  }
  for (let i = 0; i < 400; i++) params.properties["opt" + i] = { type: "string", description: "optional padding ".repeat(4) };
  const gw = createGateway({ hiddenReason: () => null, registry: () => makeRegistry(() => [{ name: "mcp__x__y", description: "d", parameters: params }]) });
  const res = gw.loadResult(null, ["mcp__x__y"]);
  const kept = res.tools[0].parameters.properties;
  for (const name of params.required) {
    assert.ok(kept[name], "必需参数 " + name + " 被丢了，这会让调用注定失败");
  }
  assert.ok(Buffer.byteLength(JSON.stringify(res.tools[0].parameters)) < 24000);
});

test("取回：未知名字与已禁用名字分别报出，不混成一句含糊的失败", () => {
  const ctx = makeCtx();
  const gw = createGateway({ hiddenReason: (n) => (n === "mcp__alpha__search" ? "禁用" : null), registry: () => makeRegistry() });
  gw.install(ctx);
  const res = gw.loadResult(null, ["mcp__nope", "mcp__alpha__search"]);
  assert.deepEqual(res.unknown, ["mcp__nope"]);
  assert.deepEqual(res.blocked, ["mcp__alpha__search"]);
  assert.ok(res.text.includes("未找到"));
  assert.ok(res.text.includes("已禁用"));
});

test("注册的检索工具：名字稳定，参数只给 query/names/limit", () => {
  const ctx = makeCtx();
  const gw = createGateway({ hiddenReason: () => null, registry: () => makeRegistry() });
  gw.install(ctx);
  const def = ctx.__registered.find((d) => d.name === "mcp_hub_tools");
  assert.ok(def, "必须注册检索工具");
  assert.deepEqual(Object.keys(def.parameters.properties).sort(), ["limit", "names", "query"]);
  assert.equal(def.name.startsWith("mcp__"), false, "检索工具不能占用 MCP 前缀命名空间");
});

test("execute：names 优先于 query，且返回体带完整参数正文", async () => {
  const ctx = makeCtx();
  const gw = createGateway({ hiddenReason: () => null, registry: () => makeRegistry() });
  gw.install(ctx);
  const def = ctx.__registered.find((d) => d.name === "mcp_hub_tools");
  const byNames = await def.execute({ query: "capture", names: ["mcp__beta__download"] }, { agent: null });
  assert.equal(byNames.mode, "schemas");
  assert.ok(byNames.text.includes("mcp__beta__download"));
  assert.ok(byNames.text.includes("\"url\""), "正文必须带出参数，否则模型无法调用");
  const byQuery = await def.execute({ query: "capture" }, { agent: null });
  assert.equal(byQuery.mode, "hits");
});

test("registry 不可用时不崩：检索返回空目录，过滤仍可用", () => {
  const ctx = makeCtx();
  const gw = createGateway({ hiddenReason: (n) => (n.startsWith("mcp__") ? "x" : null), registry: () => null });
  gw.install(ctx);
  const res = gw.searchResult(null, "anything", 8);
  // 空目录必须是独立的 mode：落进 "names" 就等于告诉模型「换个词再搜」，
  // 而真相是没有工具可搜，换多少次词都是同一句 0。
  assert.equal(res.mode, "empty");
  assert.equal(res.total, 0);
  assert.deepEqual(res.names, []);
  assert.match(res.text, /换关键词也不会有结果/);
  assert.deepEqual(gw.applyBudget({ tools: TOOLS }).tools.map((t) => t.name), ["read"]);
});

// 空目录与「有目录但没命中」是两件事，返回体必须能分辨，否则模型会一直换词。
// 这不是措辞问题：换词是无限循环，而真相是根本没有工具。
test("空目录与未命中必须可区分：空目录给 empty，有目录未命中才给 names", () => {
  const empty = createGateway({ hiddenReason: () => null, registry: () => null });
  const a = empty.searchResult(null, "zzzznotfound", 8);
  assert.equal(a.mode, "empty");
  assert.equal(a.total, 0);

  const full = createGateway({ hiddenReason: () => null, registry: () => makeRegistry() });
  const b = full.searchResult(null, "zzzznotfound", 8);
  assert.equal(b.mode, "names", "有目录时未命中仍走旧语义");
  assert.equal(b.total, 3, "目录只认 mcp__ 前缀，内置 read 不该被算进来");
  assert.equal(b.names.length, 3, "有目录未命中必须回落成全部工具名");
  assert.match(b.text, /换一个词再搜/);
});

test("空目录时不传 query 也返回 empty，而不是「当前有 0 个按需工具」", () => {
  const gw = createGateway({ hiddenReason: () => null, registry: () => null });
  const res = gw.searchResult(null, "", 8);
  assert.equal(res.mode, "empty");
  assert.match(res.text, /没有任何可检索的 MCP 工具/);
});

test("空目录时用 names 取回：说明没有工具，而不是「名字可能不对」", () => {
  const gw = createGateway({ hiddenReason: () => null, registry: () => null });
  const res = gw.loadResult(null, ["mcp__alpha__read_file"]);
  assert.equal(res.mode, "empty");
  assert.ok(!res.text.includes("可能名字不对"), "名字没错，不能误导模型去改名");
  assert.match(res.text, /没有任何可检索的 MCP 工具/);
});

test("检索工具的 description 与实现一致：空目录不再承诺回落到全部工具名", () => {
  const ctx = makeCtx();
  const gw = createGateway({ hiddenReason: () => null, registry: () => null });
  gw.install(ctx);
  const def = ctx.__registered.find((d) => d.name === "mcp_hub_tools");
  assert.match(def.description, /目录为空时如实说明没有工具/);
  assert.ok(!/一个都没命中则返回全部工具名/.test(def.description), "旧措辞会让模型在空目录上无限换词");
});
