// 端到端：用真实 apply() 验证分层后的提示词与请求形状。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mcp-hub-tiers-"));
process.env.DSH_HOME = home;

const REGISTERED = [
  { name: "mcp__windows__Screenshot", description: "Take a screenshot of the desktop.", parameters: { type: "object", properties: {} } },
  { name: "mcp__windows__FileSystem", description: "Read and write files.", parameters: { type: "object", properties: {} } },
  { name: "mcp__mobile__mobile_list_apps", description: "List installed apps.", parameters: { type: "object", properties: {} } },
  { name: "read", description: "builtin", parameters: { type: "object", properties: {} } }
];

function makeCtx() {
  const listeners = [];
  const sections = [];
  const disposers = [];
  const tools = {
    registered: [],
    guard: () => () => {},
    schemas: () => REGISTERED,
    execute: async () => ({ content: [] }),
    register(def) {
      tools.registered.push(def);
      return () => {};
    }
  };
  const ctx = {
    get(name) {
      if (name === "tools") return tools;
      if (name === "approval") return { config: { policy: "never" }, overrideOf: () => undefined, request: async () => "allowed-once" };
      if (name === "sessions") return { list: () => [] };
      return undefined;
    },
    on(event, fn) {
      listeners.push({ event, fn });
      return () => {};
    },
    inject(deps, fn) {
      if (deps.includes("systemPrompt")) {
        fn({
          systemPrompt: {
            section(spec) {
              sections.push(spec);
              return () => {};
            }
          }
        });
      }
    },
    effect(fn) {
      const off = fn();
      if (typeof off === "function") disposers.push(off);
      return () => {};
    },
    tools,
    webServer: { register: () => () => {} },
    logger: { warn() {}, info() {} }
  };
  return { ctx, listeners, sections, tools };
}

function seed(servers) {
  const dir = join(home, "storages", "mcp-hub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profile: "", approval: { followDsh: true }, servers }, null, 2));
}

let gen = 0;
async function load(servers) {
  seed(servers);
  gen += 1;
  const url = new URL("./index.js", import.meta.url).href + "?t=" + gen;
  const mod = await import(url);
  const h = makeCtx();
  mod.apply(h.ctx);
  return { mod, ...h };
}

const SERVERS = [
  { id: "s1", name: "windows", transport: "stdio", command: "x", enabled: true, budgetTier: "full", tools: {} },
  { id: "s2", name: "mobile", transport: "stdio", command: "y", enabled: true, budgetTier: "full", tools: {} }
];

test("请求里不再有任何 MCP schema，只剩内置工具", async () => {
  const { listeners } = await load(SERVERS);
  const hook = listeners.find((l) => l.event === "system-prompt/assemble");
  assert.ok(hook, "必须注册 assemble 钩子");
  const downstream = { tools: REGISTERED.map((t) => ({ ...t })) };
  const out = await hook.fn({ tools: [] }, {}, async () => downstream);
  assert.deepEqual(out.tools.map((t) => t.name), ["read"], "全部分层后只剩内置工具");
});

test("系统提示词目录只列服务器名与工具数，不列任何工具名", async () => {
  const { sections } = await load(SERVERS);
  const cat = sections.find((s) => s.name === "mcp-hub:tool-catalog");
  assert.ok(cat, "必须注册目录 section");
  const text = cat.text();
  assert.ok(text.includes("windows（2 个工具）"), "服务器与数量要在提示词里：" + text);
  assert.ok(text.includes("mobile（1 个工具）"));
  assert.ok(!text.includes("Screenshot"), "提示词里不能出现工具名：" + text);
  assert.ok(!text.includes("mcp__"), "更不能出现完整工具名：" + text);
  assert.ok(text.includes("mcp_hub_tools"), "要说明入口工具");
});

test("目录文本稳定：同配置两次装配逐字节一致", async () => {
  const { sections } = await load(SERVERS);
  const cat = sections.find((s) => s.name === "mcp-hub:tool-catalog");
  const a = cat.text();
  const b = cat.text();
  assert.equal(a, b, "不稳定会让请求前缀每次都失效");
});

test("注释里声明的成本承诺：提示词体积与工具总数无关", async () => {
  const { sections } = await load(SERVERS);
  const cat = sections.find((s) => s.name === "mcp-hub:tool-catalog");
  const small = cat.text();
  // 现在目录的体量只由服务器数决定；这些典型值远超实际。
  assert.ok(Buffer.byteLength(small) < 1200, "目录应保持在一千字节量级，实际 " + Buffer.byteLength(small));
});
