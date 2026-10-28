// /mcp-hub/gateway 的读写：设置要能持久化、非法值要被钳回默认、检索正文要带出名单。
//
// 这条路由管的是 mcp_hub_tools 检索工具的参数。最危险的失败是「面板上改了、
// 网关却还在用旧值」——所以必须断言 cfg.gateway 真的落了盘。

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mcp-hub-gateway-route-"));
process.env.DSH_HOME = home;

function makeCtx() {
  const routes = new Map();
  const tools = {
    registered: [],
    guard: () => () => {},
    schemas: () => [
      { name: "mcp__alpha__search", description: "Search things in alpha.", parameters: { type: "object", properties: { q: { type: "string" } } } },
      { name: "mcp__alpha__capture", description: "Capture a screenshot from alpha.", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "mcp__beta__download", description: "Download a file.", parameters: { type: "object", properties: { url: { type: "string" } } } }
    ],
    execute: async () => ({ content: [] }),
    register(def) {
      tools.registered.push(def);
      return () => {
        const at = tools.registered.indexOf(def);
        if (at >= 0) tools.registered.splice(at, 1);
      };
    }
  };
  const ctx = {
    get(name) {
      if (name === "tools") return tools;
      if (name === "approval") return { config: { policy: "ask" }, overrideOf: () => undefined, request: async () => "allowed-once" };
      if (name === "sessions") return { list: () => [] };
      if (name === "permissionPresets") return { names: [], defaultPreset: "", current: () => "" };
      return undefined;
    },
    on() {
      return () => {};
    },
    effect(fn) {
      try {
        const off = fn();
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
  return { ctx, routes, tools };
}

function seed(servers) {
  const dir = join(home, "storages", "mcp-hub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ profile: "", approval: { followDsh: true }, servers }, null, 2));
}

function readDisk() {
  const raw = readFileSync(join(home, "storages", "mcp-hub", "config.json"), "utf8");
  return JSON.parse(raw);
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
async function loadPlugin(servers) {
  seed(servers);
  generation += 1;
  const url = new URL("./index.js", import.meta.url).href + "?gr=" + generation;
  const mod = await import(url);
  const harness = makeCtx();
  mod.apply(harness.ctx);
  return { mod, ...harness };
}

test("GET /gateway：旧配置没有 gateway 键时返回内置默认值", async () => {
  const { routes } = await loadPlugin([{ id: "a1", name: "alpha", transport: "stdio", command: "x", enabled: true, tools: {} }]);
  const r = await call(routes.get("/mcp-hub/gateway"));
  assert.equal(r.status, 200);
  assert.equal(r.json.searchLimit, 8);
  assert.equal(r.json.catalogLimit, 200);
  assert.equal(r.json.schemaMaxBytes, 16000);
  assert.equal(r.json.loadBatchMax, 12);
});

test("POST /gateway：合法值落盘，网关下一步请求即用新值", async () => {
  const { routes, tools } = await loadPlugin([{ id: "a1", name: "alpha", transport: "stdio", command: "x", enabled: true, tools: {} }]);
  const r = await call(routes.get("/mcp-hub/gateway"), { method: "POST", body: { searchLimit: 3, catalogLimit: 100, schemaMaxBytes: 8000, loadBatchMax: 5 } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.searchLimit, 3);
  assert.equal(readDisk().gateway.searchLimit, 3, "必须真的写进配置文件");
  assert.equal(readDisk().gateway.schemaMaxBytes, 8000);

  const bridge = tools.registered.find((d) => d.name === "mcp_hub_tools");
  assert.ok(bridge, "检索工具必须注册");
  const noHit = await bridge.execute({ query: "zzzz" }, { agent: null });
  assert.equal(noHit.names.length, 3, "名单必须进正文，模型才看得见");
  assert.ok(noHit.text.includes("mcp__alpha__search"), "未命中回落正文必须带全部工具名");
  const hits = await bridge.execute({ query: "capture" }, { agent: null });
  assert.ok(hits.text.includes("mcp__alpha__capture"), "命中结果必须进正文");
  assert.ok(hits.text.includes("Capture a screenshot"), "命中摘要必须进正文");
});

test("POST /gateway：非法与越界值被钳回合法范围，不是原样落盘", async () => {
  const { routes } = await loadPlugin([{ id: "a1", name: "alpha", transport: "stdio", command: "x", enabled: true, tools: {} }]);
  const r = await call(routes.get("/mcp-hub/gateway"), { method: "POST", body: { searchLimit: "abc", catalogLimit: 99999, schemaMaxBytes: -5, loadBatchMax: 500 } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.searchLimit, 8, "NaN 必须回落默认");
  assert.equal(r.json.catalogLimit, 500, "越界必须钳到上限");
  assert.equal(r.json.schemaMaxBytes, 2000, "负数必须钳到下限");
  assert.equal(r.json.loadBatchMax, 50, "越界必须钳到上限");
  const disk = readDisk().gateway;
  assert.equal(disk.searchLimit, 8);
  assert.equal(disk.catalogLimit, 500);
});

test("检索命中数遵循 searchLimit 设置", async () => {
  const { routes, tools } = await loadPlugin([{ id: "a1", name: "alpha", transport: "stdio", command: "x", enabled: true, tools: {} }]);
  await call(routes.get("/mcp-hub/gateway"), { method: "POST", body: { searchLimit: 1 } });
  const bridge = tools.registered.find((d) => d.name === "mcp_hub_tools");
  const res = await bridge.execute({ query: "alpha" }, { agent: null });
  assert.ok(res.tools.length <= 1, "searchLimit=1 时命中数不能超过 1");
});

test("取回正文带完整参数（回归：execute 的 text 必须含 schema JSON）", async () => {
  const { tools } = await loadPlugin([{ id: "a1", name: "alpha", transport: "stdio", command: "x", enabled: true, tools: {} }]);
  const bridge = tools.registered.find((d) => d.name === "mcp_hub_tools");
  const res = await bridge.execute({ names: ["mcp__alpha__search"] }, { agent: null });
  assert.equal(res.mode, "schemas");
  assert.ok(res.text.includes('"q"'), "参数必须出现在正文里，否则模型无法照抄");
});
