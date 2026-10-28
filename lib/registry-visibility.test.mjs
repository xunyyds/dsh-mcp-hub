// 「模型看得见」与「面板拨得通」必须分开报，且禁用服务器要真的从加载补丁里消失。
//
// 这两条都是真机踩出来的：qfun 面板显示已连接 38 工具，而注册表里 0 个
// ——模型一个都调不了；rea 在面板里禁用后，DSH 仍为它起进程、提示词里仍在
// 宣传它存在。前者靠 statusOf 的口径分开修，后者靠保存/删除时同步补丁修。

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mcp-hub-visibility-"));
process.env.DSH_HOME = home;
// 补丁文件重定向到临时目录：否则保存/删除路径会改写插件真实的
// cordis.patch.yml，测试就变成了对工作区的破坏。
const patchFile = join(home, "cordis.patch.yml");
process.env.DSH_MCP_HUB_PATCH_FILE = patchFile;
mkdirSync(join(home, "plugins", "dsh-mcp-hub"), { recursive: true });

function makeCtx(registeredNames) {
  const routes = new Map();
  const tools = {
    guard: () => () => {},
    // 只有注册表里这批，才「模型可见」——这是事实源。
    schemas: () => (registeredNames || []).map((n) => ({ name: n, description: "d", parameters: { type: "object", properties: {} } })),
    execute: async () => ({ content: [] }),
    register: () => () => {}
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

function call(handler, { method = "GET", url = "/", body } = {}) {
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
async function loadPlugin(servers, registeredNames) {
  seed(servers);
  generation += 1;
  const url = new URL("./index.js", import.meta.url).href + "?vis=" + generation;
  const mod = await import(url);
  const harness = makeCtx(registeredNames);
  mod.apply(harness.ctx);
  return { mod, ...harness };
}

function makeMcpServer() {
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let msg = {};
      try {
        msg = JSON.parse(raw);
      } catch {}
      const result = msg.method === "tools/list"
        ? { tools: [{ name: "a", description: "A", inputSchema: {} }, { name: "b", description: "B", inputSchema: {} }] }
        : { serverInfo: { name: "fake" }, protocolVersion: "2024-11-05" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id ?? null, result }));
    });
  });
  return srv;
}

function pluginPatchPath() {
  return patchFile;
}

test("面板拨得通但注册表为空：visibleToolCount=0 且 registryMissing=true", async () => {
  const srv = makeMcpServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + srv.address().port + "/mcp";
  try {
    // 注册表里没有这台服务器的任何工具 —— 正是 qfun 的真实处境。
    const { routes } = await loadPlugin(
      [{ id: "a1", name: "qfun", transport: "streamable-http", url, budgetTier: "full", enabled: true, autoReconnect: false, tools: {} }],
      []
    );
    await call(routes.get("/mcp-hub/test"), { method: "POST", url: "/mcp-hub/test?server=a1" });
    const r = await call(routes.get("/mcp-hub/status"));
    const s = r.json.servers[0];
    assert.equal(s.dialToolCount, 2, "面板确实拨通并拿到 2 个工具");
    assert.equal(s.visibleToolCount, 0, "注册表里 0 个 —— 模型一个都看不到");
    assert.equal(s.registryMissing, true, "必须明确报出这个落差，否则面板会显示成健康");
  } finally {
    srv.close();
  }
});

test("注册表有工具时不误报：registryMissing=false", async () => {
  const { routes } = await loadPlugin(
    [{ id: "a1", name: "windows", transport: "stdio", command: "x", budgetTier: "full", enabled: true, tools: {} }],
    ["mcp__windows__read", "mcp__windows__click"]
  );
  const r = await call(routes.get("/mcp-hub/status"));
  const s = r.json.servers[0];
  assert.equal(s.visibleToolCount, 2);
  assert.equal(s.registryMissing, false);
});

test("禁用服务器时同步摘掉加载补丁里的桥接条目", async () => {
  const patchFile = pluginPatchPath();
  mkdirSync(join(process.env.DSH_HOME, "plugins", "dsh-mcp-hub"), { recursive: true });
  writeFileSync(patchFile, [
    "- insert:",
    "    - id: mcp-hub",
    "      name: '@dsh-external/dsh-mcp-hub'",
    "    - id: mcp-hub-rea",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: rea",
    "        transport: stdio"
  ].join("\n") + "\n");

  const { routes } = await loadPlugin(
    [{ id: "a1", name: "rea", transport: "stdio", command: "x", budgetTier: "full", enabled: true, tools: {} }],
    ["mcp__rea__x"]
  );
  // 面板里把它禁用。
  const r = await call(routes.get("/mcp-hub/servers"), {
    method: "POST",
    url: "/mcp-hub/servers",
    body: { server: { id: "a1", name: "rea", transport: "stdio", command: "x", enabled: false } }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.patch.changed, true, "禁用后必须真的重写补丁");
  const text = readFileSync(patchFile, "utf8");
  assert.ok(!text.includes("mcp-hub-rea"), "禁用服务器的桥接条目必须消失——否则 DSH 仍会为它起进程并在提示词里宣传它");
  assert.ok(text.includes("dsh-mcp-hub"), "插件自身的条目不能被一起删掉");
});

test("删除服务器时同样清理补丁", async () => {
  const patchFile = pluginPatchPath();
  mkdirSync(join(process.env.DSH_HOME, "plugins", "dsh-mcp-hub"), { recursive: true });
  writeFileSync(patchFile, [
    "- insert:",
    "    - id: mcp-hub",
    "      name: '@dsh-external/dsh-mcp-hub'",
    "    - id: mcp-hub-gone",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: gone",
    "        transport: stdio"
  ].join("\n") + "\n");

  const { routes } = await loadPlugin(
    [{ id: "a1", name: "gone", transport: "stdio", command: "x", budgetTier: "full", enabled: true, tools: {} }],
    ["mcp__gone__x"]
  );
  const r = await call(routes.get("/mcp-hub/servers"), { method: "DELETE", url: "/mcp-hub/servers?id=a1" });
  assert.equal(r.json.ok, true);
  const text = readFileSync(patchFile, "utf8");
  assert.ok(!text.includes("mcp-hub-gone"), "删除后桥接条目必须消失");
});

test("从未写过补丁的机器：禁用不会凭空造出一份补丁", async () => {
  const patchFile = pluginPatchPath();
  try {
    writeFileSync(patchFile, ""); // 空文件，但没有桥接区
  } catch {
    mkdirSync(join(process.env.DSH_HOME, "plugins", "dsh-mcp-hub"), { recursive: true });
    writeFileSync(patchFile, "");
  }
  const { routes } = await loadPlugin(
    [{ id: "a1", name: "solo", transport: "stdio", command: "x", budgetTier: "full", enabled: true, tools: {} }],
    ["mcp__solo__x"]
  );
  const r = await call(routes.get("/mcp-hub/servers"), {
    method: "POST",
    url: "/mcp-hub/servers",
    body: { server: { id: "a1", name: "solo", transport: "stdio", command: "x", enabled: false } }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.patch.changed, false, "没有桥接区时不该改动文件");
  assert.equal(readFileSync(patchFile, "utf8").trim(), "", "更不能凭空生成桥接条目");
});
