// /mcp-hub/budget 的读写：档位要能持久化、能整体设置、旧配置不能被动。
//
// 这条路由是本次改动的对外入口。它最危险的失败不是报错，而是「看起来保存了、
// 实际没落盘」——那会让用户以为省了 token，重启却全部回来。

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mcp-hub-budget-route-"));
process.env.DSH_HOME = home;
// POST /servers 会触发 syncBridgeIfPresent()。这条缝不接管，测试就会去改写
// 插件真实的 cordis.patch.yml ——本文件确实这么把线上补丁写成过只剩 dead-end
// 的形态，而 patchFilePath() 当时只认 DSH_MCP_HUB_PATCH_FILE。
process.env.DSH_MCP_HUB_PATCH_FILE = join(home, "cordis.patch.yml");

function makeCtx() {
  const routes = new Map();
  const tools = { guard: () => () => {}, schemas: () => [], execute: async () => ({ content: [] }), register: () => () => {} };
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
  return { ctx, routes };
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

function call(handler, { method = "GET", url = "/mcp-hub/budget", body } = {}) {
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
  const url = new URL("./index.js", import.meta.url).href + "?br=" + generation;
  const mod = await import(url);
  const harness = makeCtx();
  mod.apply(harness.ctx);
  return { mod, ...harness };
}

test("旧配置没有 budgetTier：读出来是 full，绝不因为缺字段就降级", async () => {
  const { routes } = await loadPlugin([{ id: "a1", name: "old", transport: "stdio", command: "x", enabled: true, tools: {} }]);
  const r = await call(routes.get("/mcp-hub/budget"));
  assert.equal(r.status, 200);
  assert.equal(r.json.servers[0].tier, "full");
});

test("单个服务器改成 lazy：落盘可见，重读仍是 lazy", async () => {
  const { routes } = await loadPlugin([
    { id: "a1", name: "alpha", transport: "stdio", command: "x", enabled: true, tools: {} },
    { id: "a2", name: "beta", transport: "stdio", command: "y", enabled: true, tools: {} }
  ]);
  const r = await call(routes.get("/mcp-hub/budget"), { method: "POST", body: { server: "a1", tier: "lazy" } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.tier, "lazy");

  const disk = readDisk();
  const saved = disk.servers.find((s) => s.id === "a1");
  assert.equal(saved.budgetTier, "lazy", "必须真的写进配置文件，不能只改内存");
  // 未被设置的那台会以规范化后的显式 full 落盘：写入是整体重写，未设置的键
  // 统一补成默认值，这样文件里不存在「有的写了有的没写」两种形态。
  assert.equal(disk.servers.find((s) => s.id === "a2").budgetTier, "full", "其他服务器的档位不能被改成 lazy");
});

test("不带 server 的 POST 是「全部一起设」，与审批页的语义一致", async () => {
  const { routes } = await loadPlugin([
    { id: "a1", name: "alpha", transport: "stdio", command: "x", enabled: true, tools: {} },
    { id: "a2", name: "beta", transport: "stdio", command: "y", enabled: true, tools: {} }
  ]);
  await call(routes.get("/mcp-hub/budget"), { method: "POST", body: { tier: "lazy" } });
  const disk = readDisk();
  assert.deepEqual(disk.servers.map((s) => s.budgetTier), ["lazy", "lazy"]);
});

test("非法 tier 被拒且不落盘（拼错不能静默变成 full 或 off）", async () => {
  const { routes } = await loadPlugin([{ id: "a1", name: "alpha", transport: "stdio", command: "x", enabled: true, tools: {} }]);
  const r = await call(routes.get("/mcp-hub/budget"), { method: "POST", body: { server: "a1", tier: "lazzy" } });
  assert.equal(r.status, 400);
  assert.equal(readDisk().servers[0].budgetTier, undefined, "被拒的请求不能留下任何写入");
});

test("不存在的 server 返回 404，不静默作用到全部", async () => {
  const { routes } = await loadPlugin([{ id: "a1", name: "alpha", transport: "stdio", command: "x", enabled: true, tools: {} }]);
  const r = await call(routes.get("/mcp-hub/budget"), { method: "POST", body: { server: "nope", tier: "off" } });
  assert.equal(r.status, 404);
  assert.equal(readDisk().servers[0].budgetTier, undefined);
});

test("GET 报出 bridgeTool 名字，面板才能告诉模型该调什么", async () => {
  const { routes } = await loadPlugin([{ id: "a1", name: "alpha", transport: "stdio", command: "x", enabled: true, tools: {} }]);
  const r = await call(routes.get("/mcp-hub/budget"));
  assert.equal(r.json.bridgeTool, "mcp_hub_tools");
  assert.deepEqual(r.json.tiers, ["full", "lazy", "off"]);
});

test("改 URL 不会把档位打回 full（与 token / tools 的保留规则一致）", async () => {
  const { routes } = await loadPlugin([{ id: "a1", name: "alpha", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", enabled: true, budgetTier: "lazy", tools: {} }]);
  const r = await call(routes.get("/mcp-hub/servers"), {
    method: "POST",
    url: "/mcp-hub/servers",
    body: { server: { id: "a1", name: "alpha", transport: "streamable-http", url: "http://127.0.0.1:2/mcp" } }
  });
  assert.equal(r.json.ok, true);
  assert.equal(readDisk().servers[0].budgetTier, "lazy", "只改 URL 不能顺手把按需档位清掉");
});
