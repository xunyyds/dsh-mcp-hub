// 工具目录：lazy 档位的工具名常驻进系统提示词。
//
// 危险的不是「不工作」，而是列错名单：full 台重复列是白花钱，off/禁用台
// 列出来就是「一叫就失败」的诱饵。这组测试盯的就是名单的正确性。

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mcp-hub-catalog-"));
process.env.DSH_HOME = home;

const REGISTERED = [
  { name: "mcp__heavy__search", description: "Search heavy things. Second sentence dropped.", parameters: { type: "object", properties: {} } },
  { name: "mcp__heavy__capture", description: "Capture a screenshot.", parameters: { type: "object", properties: {} } },
  { name: "mcp__light__ping", description: "Ping the light server.", parameters: { type: "object", properties: {} } }
];

function makeCtx() {
  const routes = new Map();
  const sectionCalls = [];
  const sectionDisposers = [];
  const tools = {
    registered: [],
    guard: () => () => {},
    schemas: () => REGISTERED,
    execute: async () => ({ content: [] }),
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
      if (name === "approval") return { config: { policy: "ask" }, overrideOf: () => undefined, request: async () => "allowed-once" };
      if (name === "sessions") return { list: () => [] };
      if (name === "permissionPresets") return { names: [], defaultPreset: "", current: () => "" };
      return undefined;
    },
    inject(_deps, cb) {
      cb({ systemPrompt: { section(spec) {
        sectionCalls.push(spec);
        const off = () => {
          const at = sectionDisposers.indexOf(spec);
          if (at >= 0) sectionDisposers.splice(at, 1);
        };
        sectionDisposers.push(spec);
        return off;
      } } });
    },
    on() {
      return () => {};
    },
    effect(fn) {
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
      register(spec) {
        routes.set(spec.path, spec.handler);
        return () => routes.delete(spec.path);
      }
    },
    logger: { warn() {}, info() {} }
  };
  return { ctx, routes, tools, sectionCalls, sectionDisposers, effectDisposers };
}

function seed(servers, extra) {
  const dir = join(home, "storages", "mcp-hub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(Object.assign({ profile: "", approval: { followDsh: true }, servers }, extra || {}), null, 2));
}

function readDisk() {
  return JSON.parse(readFileSync(join(home, "storages", "mcp-hub", "config.json"), "utf8"));
}

function call(handler, { method = "GET", url = "/mcp-hub/gateway", body } = {}) {
  return new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
    const req = {
      method,
      url,
      headers: { host: "127.0.0.1:58406", origin: "http://127.0.0.1:58406", "sec-fetch-site": "same-origin" },
      on(event, fn) {
        if (event === "data") chunks.forEach((c) => fn(c));
        if (event === "end") fn();
      }
    };
    const res = {
      statusCode: 0,
      body: "",
      writeHead(code) {
        res.statusCode = code;
      },
      end(t) {
        res.body = t;
        resolve({ status: res.statusCode, json: JSON.parse(t) });
      }
    };
    handler(req, res);
  });
}

let generation = 0;
async function loadPlugin(servers, extra) {
  seed(servers, extra);
  generation += 1;
  const url = new URL("./index.js", import.meta.url).href + "?tc=" + generation;
  const mod = await import(url);
  const harness = makeCtx();
  mod.apply(harness.ctx);
  return { mod, ...harness };
}

test("目录只列 lazy：full、off、整台禁用都不出现", async () => {
  const { sectionCalls } = await loadPlugin([
    { id: "a1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} },
    { id: "a2", name: "light", transport: "stdio", command: "y", budgetTier: "full", enabled: true, tools: {} },
    { id: "a3", name: "off", transport: "stdio", command: "z", budgetTier: "off", enabled: true, tools: {} },
    { id: "a4", name: "disabled", transport: "stdio", command: "w", budgetTier: "lazy", enabled: false, tools: {} }
  ]);
  assert.ok(sectionCalls.length > 0, "必须注册 section");
  const text = sectionCalls[0].text();
  assert.ok(text.includes("mcp__heavy__search"), "lazy 台的工具名必须出现");
  assert.ok(!text.includes("mcp__light__ping"), "full 台不能重复列");
  assert.ok(!text.includes("mcp__off__") && !text.includes("off："), "off 台不能出现——列出来就是诱饵");
  assert.ok(!text.includes("disabled："), "整台禁用的不出现");
});

test("逐工具禁用被跳过，同服务器其他工具保留", async () => {
  const { sectionCalls } = await loadPlugin([
    { id: "a1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: { capture: { enabled: false } } }
  ]);
  const text = sectionCalls[0].text();
  assert.ok(text.includes("mcp__heavy__search"), "启用的工具保留");
  assert.ok(!text.includes("mcp__heavy__capture"), "逐工具禁用的跳过");
});

test("未连接与连接失败的服务器不进目录", async () => {
  const { sectionCalls } = await loadPlugin([
    { id: "a1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} },
    { id: "a5", name: "offline", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", budgetTier: "lazy", enabled: true, autoReconnect: false, tools: {} }
  ]);
  const text = sectionCalls[0].text();
  assert.ok(text.includes("mcp__heavy__search"), "注册表有工具的 lazy 台照常出现");
  assert.ok(!text.includes("offline："), "拨不上号的 lazy 台不能进目录——列出来就是一叫就失败的诱饵");
});

test("拨通后的 lazy HTTP 服务器进目录", async () => {
  const { createServer } = await import("node:http");
  const mcp = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let msg = {};
      try {
        msg = JSON.parse(raw);
      } catch {}
      const result = msg.method === "tools/list"
        ? { tools: [{ name: "hello", description: "Say hello.", inputSchema: {} }] }
        : { serverInfo: { name: "test-mcp" }, protocolVersion: "2024-11-05" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }));
    });
  });
  await new Promise((resolve) => mcp.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + mcp.address().port + "/mcp";
  try {
    const { routes, sectionCalls } = await loadPlugin([
      { id: "a1", name: "web", transport: "streamable-http", url, budgetTier: "lazy", enabled: true, autoReconnect: false, tools: {} }
    ]);
    await call(routes.get("/mcp-hub/test"), { method: "POST", url: "/mcp-hub/test?server=a1" });
    const text = sectionCalls[0].text();
    assert.ok(text.includes("mcp__web__hello"), "connected 后目录里必须有它的工具");
  } finally {
    mcp.close();
  }
});

test("超 limit 时报出「另有 N 个」，N 与实际差额相等", async () => {
  const many = [];
  for (let i = 0; i < 30; i++) {
    many.push({ name: "mcp__big__t" + i, description: "tool " + i, parameters: { type: "object", properties: {} } });
  }
  const saved = REGISTERED.splice(0, REGISTERED.length, ...many);
  try {
    const { sectionCalls } = await loadPlugin([
      { id: "a1", name: "big", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} }
    ], { catalog: { enabled: true, mode: "names", limit: 10 } });
    const text = sectionCalls[0].text();
    assert.ok(text.includes("另有 20 个工具未列出"), "截断差额必须如实报出");
    assert.ok(text.includes("mcp__big__t9"), "列出的应是前 10 个");
    assert.ok(!text.includes("mcp__big__t10"), "第 11 个不能混进来");
  } finally {
    REGISTERED.splice(0, REGISTERED.length, ...saved);
  }
});

test("空目录返回空串，不留空壳标签", async () => {
  const { sectionCalls } = await loadPlugin([
    { id: "a1", name: "light", transport: "stdio", command: "y", budgetTier: "full", enabled: true, tools: {} }
  ]);
  const text = sectionCalls[0].text();
  assert.equal(text, "", "没有 lazy 工具时目录必须为空，空壳也占前缀");
});

test("summary 模式带首句、不带第二句", async () => {
  const { sectionCalls } = await loadPlugin([
    { id: "a1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} }
  ], { catalog: { enabled: true, mode: "summary", limit: 200 } });
  const text = sectionCalls[0].text();
  assert.ok(text.includes("Search heavy things."), "摘要必须带首句");
  assert.ok(!text.includes("Second sentence dropped."), "第二句不该进来");
});

test("section 注册参数：name、order、interpolate、text 是函数", async () => {
  const { sectionCalls } = await loadPlugin([
    { id: "a1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} }
  ]);
  const spec = sectionCalls[0];
  assert.equal(spec.name, "mcp-hub:tool-catalog");
  assert.equal(spec.order, 3110);
  assert.equal(spec.interpolate, false);
  assert.equal(typeof spec.text, "function");
});

test("卸载清理：ctx.effect 的 disposer 执行后 section 也被注销", async () => {
  const { sectionDisposers, effectDisposers } = await loadPlugin([
    { id: "a1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} }
  ]);
  assert.ok(sectionDisposers.length > 0, "section 必须已注册");
  for (const off of effectDisposers) off();
  assert.equal(sectionDisposers.length, 0, "卸载后 section 必须被注销，否则热更新会出现两份目录");
});

test("无 systemPrompt 服务时不炸：照常 apply 完", async () => {
  seed([{ id: "a1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} }]);
  generation += 1;
  const url = new URL("./index.js", import.meta.url).href + "?tcn=" + generation;
  const mod = await import(url);
  const harness = makeCtx();
  delete harness.ctx.inject;
  assert.doesNotThrow(() => mod.apply(harness.ctx), "systemPrompt 缺失只能跳过目录，不能让插件 failed");
});

test("预览与注入一致：GET /gateway 的 preview.text 与 section.text() 逐字节相等", async () => {
  const { routes, sectionCalls } = await loadPlugin([
    { id: "a1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} }
  ]);
  const r = await call(routes.get("/mcp-hub/gateway"));
  assert.equal(r.status, 200);
  assert.ok(r.json.catalog && r.json.catalog.preview, "GET 必须带 catalog.preview");
  const fromSection = sectionCalls[0].text();
  assert.equal(r.json.catalog.preview.text, fromSection, "面板承诺的和模型看到的必须逐字节一致");
  assert.equal(r.json.catalog.preview.bytes, Buffer.byteLength(fromSection));
});

test("持久化与钳制：POST catalog 落盘；非法 mode 回落 names；limit 越界钳到 500", async () => {
  const { routes } = await loadPlugin([
    { id: "a1", name: "heavy", transport: "stdio", command: "x", budgetTier: "lazy", enabled: true, tools: {} }
  ]);
  const r = await call(routes.get("/mcp-hub/gateway"), { method: "POST", body: { catalog: { mode: "summary" } } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.catalog.mode, "summary");
  assert.equal(readDisk().catalog.mode, "summary", "必须真的写进配置文件");

  const r2 = await call(routes.get("/mcp-hub/gateway"), { method: "POST", body: { catalog: { mode: "bogus", limit: 9999 } } });
  assert.equal(r2.json.catalog.mode, "names", "非法 mode 回落 names");
  assert.equal(r2.json.catalog.limit, 500, "越界 limit 钳到 500");
  assert.equal(readDisk().catalog.limit, 500);
});
