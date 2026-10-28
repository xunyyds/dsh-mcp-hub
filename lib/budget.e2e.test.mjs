// 端到端：在真实 apply() 里验证「禁用 = 从请求里消失」，而不是只被 guard 拦住。
//
// 这是本次改动的核心承诺，也是最容易被写反的一条：guard 只否决执行，
// schema 早在注册时就进了提示词。所以这里断言的是 assembly.tools ——
// 也就是真正交给 adapter 的那个数组 —— 而不是「调用会不会失败」。

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mcp-hub-budget-"));
process.env.DSH_HOME = home;

const REGISTERED = [
  { name: "mcp__heavy__search", description: "Search. Second sentence.", parameters: { type: "object", properties: {} } },
  { name: "mcp__heavy__capture", description: "Capture a screenshot.", parameters: { type: "object", properties: {} } },
  { name: "mcp__light__ping", description: "Ping the light server.", parameters: { type: "object", properties: {} } },
  { name: "read", description: "builtin", parameters: { type: "object", properties: {} } }
];

function makeCtx(servers) {
  const listeners = [];
  const tools = {
    registered: [],
    guard() {
      return () => {};
    },
    schemas() {
      return REGISTERED;
    },
    async execute() {
      return { content: [] };
    },
    register(def) {
      tools.registered.push(def);
      return () => {
        const at = tools.registered.indexOf(def);
        if (at >= 0) tools.registered.splice(at, 1);
      };
    }
  };
  const effectDisposers = [];
  const ctx = {
    get(name) {
      if (name === "tools") return tools;
      if (name === "approval") return { config: { policy: "never" }, overrideOf: () => undefined, request: async () => "allowed-once" };
      if (name === "sessions") return { list: () => [] };
      return undefined;
    },
    on(event, fn) {
      listeners.push({ event, fn });
      return () => {
        const at = listeners.findIndex((l) => l.fn === fn);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    effect(fn) {
      // 记录 effect 返回的 disposer，这样测试才能真的模拟「卸载」。
      // 只是执行一次的假实现会让卸载路径永远测不到——那恰恰是本插件
      // 最容易留下残留的一处（定时器、监听器、注册表条目）。
      try {
        const off = fn();
        if (typeof off === "function") effectDisposers.push(off);
        return typeof off === "function" ? off : () => {};
      } catch {
        return () => {};
      }
    },
    tools,
    webServer: {
      register() {
        return () => {};
      }
    },
    logger: { warn() {}, info() {} },
    __effectDisposers: effectDisposers
  };
  return { ctx, listeners, tools, servers, effectDisposers };
}

let generation = 0;
async function loadPlugin(servers) {
  generation += 1;
  const url = new URL("./index.js", import.meta.url).href + "?b=" + generation;
  const mod = await import(url);
  const harness = makeCtx(servers);
  mod.apply(harness.ctx);
  return { mod, ...harness };
}

// 直接把服务器写进配置文件，再让插件读它——比走 HTTP 路由少一层，
// 但走的是同一条 readConfig → normalizeServer 路径。
function seed(servers) {
  const { mkdirSync, writeFileSync } = require("node:fs");
  const dir = join(home, "storages", "mcp-hub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profile: "", approval: { followDsh: true }, servers }, null, 2));
}

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

async function assembleWith(listeners) {
  const hook = listeners.find((l) => l.event === "system-prompt/assemble");
  assert.ok(hook, "插件必须注册 system-prompt/assemble 钩子");
  const downstream = { tools: REGISTERED.map((t) => ({ ...t })) };
  return hook.fn({ tools: [] }, {}, async () => downstream);
}

test("full 档位：schema 全量留在提示词里（默认行为不能被悄悄改变）", async () => {
  seed([{ id: "s1", name: "heavy", transport: "stdio", command: "x", budgetTier: "full", enabled: true, tools: {} }]);
  const { listeners } = await loadPlugin();
  const out = await assembleWith(listeners);
  assert.equal(out.tools.length, REGISTERED.length, "full 档位不能摘任何东西");
});

test("lazy 档位：这台的 schema 从请求里消失，其他服务器与内置工具不受影响", async () => {
  seed([
    { id: "s1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} },
    { id: "s2", name: "light", transport: "stdio", command: "y", budgetTier: "full", enabled: true, tools: {} }
  ]);
  const { listeners } = await loadPlugin();
  const out = await assembleWith(listeners);
  const names = out.tools.map((t) => t.name);
  assert.ok(!names.includes("mcp__heavy__search"), "lazy 服务器的 schema 必须消失");
  assert.ok(!names.includes("mcp__heavy__capture"), "lazy 服务器的 schema 必须消失");
  assert.ok(names.includes("mcp__light__ping"), "其他服务器不受影响");
  assert.ok(names.includes("read"), "内置工具不受影响");
});

test("面板禁用服务器：schema 同样消失（这才是「禁用」该有的成本）", async () => {
  seed([{ id: "s1", name: "heavy", transport: "stdio", command: "x", budgetTier: "full", enabled: false, tools: {} }]);
  const { listeners } = await loadPlugin();
  const out = await assembleWith(listeners);
  const names = out.tools.map((t) => t.name);
  assert.ok(!names.includes("mcp__heavy__search"), "整台禁用的服务器不能继续付 token");
  assert.ok(!names.includes("mcp__heavy__capture"));
  assert.ok(names.includes("read"));
});

test("逐工具禁用：只消失那一个，同服务器其他工具还在", async () => {
  seed([{ id: "s1", name: "heavy", transport: "stdio", command: "x", budgetTier: "full", enabled: true, tools: { capture: { enabled: false } } }]);
  const { listeners } = await loadPlugin();
  const out = await assembleWith(listeners);
  const names = out.tools.map((t) => t.name);
  assert.ok(!names.includes("mcp__heavy__capture"), "被禁用的那一个必须消失");
  assert.ok(names.includes("mcp__heavy__search"), "同服务器其他工具不能跟着掉");
});

test("off 档位：schema 消失，且检索工具也不能把它取回来", async () => {
  seed([{ id: "s1", name: "heavy", transport: "stdio", command: "x", budgetTier: "off", enabled: true, tools: {} }]);
  const { listeners, tools } = await loadPlugin();
  const out = await assembleWith(listeners);
  assert.ok(!out.tools.map((t) => t.name).includes("mcp__heavy__search"));
  const bridge = tools.registered.find((d) => d.name === "mcp_hub_tools");
  assert.ok(bridge, "检索工具必须注册");
  const res = await bridge.execute({ names: ["mcp__heavy__search"] }, { agent: null });
  assert.deepEqual(res.tools, [], "off 档位的工具不能被取回");
  assert.deepEqual(res.blocked, ["mcp__heavy__search"]);
});

test("卸载后不留痕：钩子与检索工具都撤掉，恢复未装插件的请求形状", async () => {
  seed([{ id: "s1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} }]);
  const { ctx, listeners, tools } = await loadPlugin();
  const out0 = await assembleWith(listeners);
  assert.ok(!out0.tools.map((t) => t.name).includes("mcp__heavy__search"));
  assert.ok(tools.registered.length > 0, "卸载前检索工具应当在位");

  // 触发插件注册进 ctx.effect 的全部清理动作（真机上卸载时 Cordis 做的同一件事）。
  assert.ok(ctx.__effectDisposers.length > 0, "插件必须把清理交给 ctx.effect，否则卸载会留残留");
  for (const off of ctx.__effectDisposers) off();

  // 直接验证：监听器表与工具注册表都必须干净。
  assert.equal(listeners.length, 0, "卸载后不能残留 system-prompt/assemble 钩子");
  assert.equal(tools.registered.length, 0, "卸载后不能残留检索工具");

  // 且真正重新装一次要还能工作——残留状态会让第二次 install 撞同名。
  const again = await loadPlugin();
  const out1 = await assembleWith(again.listeners);
  assert.ok(!out1.tools.map((t) => t.name).includes("mcp__heavy__search"), "重装后行为必须与首次一致");
});
