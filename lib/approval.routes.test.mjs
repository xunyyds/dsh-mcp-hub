// HTTP 路由测试：验证 /mcp-hub/approval 的读写、服务器三态、以及备份兼容。
// 同样不启动 DSH：webServer.register 被换成一个只记录 handler 的假实现。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mcp-hub-routes-"));
process.env.DSH_HOME = home;

function makeCtx({ policy = "ask", approvalMissing = false, sessionsList = [] } = {}) {
  const routes = new Map();
  const approval = {
    config: { policy },
    calls: [],
    nextOutcome: "allowed-once",
    overrideOf() {
      return undefined;
    },
    async request(req) {
      approval.calls.push(req);
      return approval.nextOutcome;
    }
  };
  const ctx = {
    get(name) {
      if (name === "approval") return approvalMissing ? undefined : approval;
      if (name === "sessions") return { list: () => sessionsList };
      if (name === "tools") return { guard: () => () => {}, schemas: () => [], execute: async () => ({ content: [] }) };
      if (name === "permissionPresets") {
        return { names: ["workspace-write", "danger-full-access"], defaultPreset: "workspace-write", current: () => "workspace-write" };
      }
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
    tools: { guard: () => () => {}, schemas: () => [], execute: async () => ({ content: [] }) },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec.handler);
        return () => routes.delete(spec.path);
      }
    },
    logger: { warn() {}, info() {} }
  };
  return { ctx, routes, approval };
}

let generation = 0;
async function loadPlugin(opts) {
  generation += 1;
  const url = new URL("./index.js", import.meta.url).href + "?r=" + generation;
  const mod = await import(url);
  const harness = makeCtx(opts);
  mod.apply(harness.ctx);
  return { mod, ...harness };
}

// 极简 req/res：够路由读取 method/url 与解析 JSON body。
function call(handler, { method = "GET", url = "/mcp-hub/approval", body } = {}) {
  return new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
    const req = {
      method,
      url,
      on(event, fn) {
        if (event === "data") for (const c of chunks) fn(c);
        if (event === "end") fn();
      }
    };
    let status = 0;
    let payload = "";
    const res = {
      writeHead(code) {
        status = code;
      },
      end(text) {
        payload = text;
        resolve({ status, json: (() => { try { return JSON.parse(text); } catch { return null; } })() });
      }
    };
    handler(req, res);
  });
}

function seed({ followDsh = true, servers = [{ id: "a", name: "qfun", approvalMode: "inherit" }], approval } = {}) {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  const doc = { profile: "", servers };
  if (approval !== undefined) doc.approval = approval;
  else doc.approval = { followDsh };
  writeFileSync(join(home, "storages", "mcp-hub", "config.json"), JSON.stringify(doc, null, 2));
}

test("GET /approval 暴露总开关、每服务器生效策略与官方策略", async () => {
  seed({ followDsh: true });
  // 权限预设与审批策略都是会话级事实：没有活跃会话就没有「当前预设」，
  // 传一个假会话才能验证这条读取路径真的接上了官方服务。
  const fakeSession = { id: "sess-1", seq: 0, append() {}, eventAt() { return undefined; } };
  const { routes } = await loadPlugin({ policy: "ask", sessionsList: [fakeSession] });
  const r = await call(routes.get("/mcp-hub/approval"));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.approval.followDsh, true);
  assert.equal(r.json.servers.length, 1);
  assert.equal(r.json.servers[0].approvalMode, "inherit");
  assert.equal(r.json.servers[0].effective.follow, true);
  assert.equal(r.json.dsh.available, true);
  assert.equal(r.json.dsh.defaultPolicy, "ask");
  assert.equal(r.json.dsh.policy, "ask");
  assert.equal(r.json.dsh.presets.current, "workspace-write");
  assert.equal(r.json.dsh.sessions.length, 1);
  assert.equal(r.json.dsh.sessions[0].id, "sess-1");
});

test("没有活跃会话时，当前权限预设如实为空", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin({ policy: "ask" });
  const r = await call(routes.get("/mcp-hub/approval"));
  assert.equal(r.json.dsh.presets.current, "", "预设是会话级事实，无会话就不该编一个值");
  assert.equal(r.json.dsh.sessions.length, 0);
});

test("POST /approval 改总开关并落盘", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/approval"), { method: "POST", body: { followDsh: false } });
  assert.equal(r.json.approval.followDsh, false);
  assert.equal(r.json.servers[0].effective.follow, false, "inherit 必须跟着总开关变");
});

test("POST /approval 只改一台服务器的三态", async () => {
  seed({
    followDsh: false,
    servers: [
      { id: "a", name: "alpha", approvalMode: "inherit" },
      { id: "b", name: "beta", approvalMode: "inherit" }
    ]
  });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/approval"), { method: "POST", body: { server: "a", approvalMode: "follow" } });
  const byName = Object.fromEntries(r.json.servers.map((s) => [s.name, s]));
  assert.equal(byName.alpha.approvalMode, "follow");
  assert.equal(byName.alpha.effective.follow, true, "follow 覆盖总开关");
  assert.equal(byName.beta.approvalMode, "inherit", "另一台不受影响");
  assert.equal(byName.beta.effective.follow, false);
});

test("POST /approval 不带 server 的 approvalMode 视为全部设置", async () => {
  seed({
    servers: [
      { id: "a", name: "alpha", approvalMode: "inherit" },
      { id: "b", name: "beta", approvalMode: "follow" }
    ]
  });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/approval"), { method: "POST", body: { approvalMode: "manual" } });
  for (const s of r.json.servers) assert.equal(s.approvalMode, "manual");
});

test("非法 approvalMode 归一为 inherit 而不是写坏配置", async () => {
  seed({ servers: [{ id: "a", name: "alpha", approvalMode: "inherit" }] });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/approval"), { method: "POST", body: { server: "a", approvalMode: "乱写" } });
  assert.equal(r.json.servers[0].approvalMode, "inherit");
});

test("未知 server 返回 404 且不改任何东西", async () => {
  seed({ servers: [{ id: "a", name: "alpha", approvalMode: "inherit" }] });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/approval"), { method: "POST", body: { server: "nope", approvalMode: "follow" } });
  assert.equal(r.status, 404);
  assert.equal(r.json.ok, false);
});

test("审批服务缺失时如实报告不可用", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin({ approvalMissing: true });
  const r = await call(routes.get("/mcp-hub/approval"));
  assert.equal(r.json.dsh.available, false);
  assert.match(r.json.dsh.reason, /未组合/);
});

test("revoke-grants 返回清理条数", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/approval"), { method: "POST", body: { action: "revoke-grants" } });
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.removed, "number");
});

test("备份包含 approval，恢复时能读回", async () => {
  seed({ followDsh: false });
  const { routes } = await loadPlugin();
  const backup = await call(routes.get("/mcp-hub/backup"));
  assert.equal(backup.json.approval.followDsh, false, "备份必须带上审批总开关");
  // 改成 true 后再恢复，应回到 false。
  await call(routes.get("/mcp-hub/approval"), { method: "POST", body: { followDsh: true } });
  const restored = await call(routes.get("/mcp-hub/backup"), { method: "POST", body: { backup: backup.json, mode: "merge" } });
  assert.equal(restored.json.ok, true);
  const after = await call(routes.get("/mcp-hub/approval"));
  assert.equal(after.json.approval.followDsh, false);
});

test("旧备份没有 approval 字段时，合并保留本机现值", async () => {
  seed({ followDsh: false });
  const { routes } = await loadPlugin();
  const legacy = {
    kind: "dsh-mcp-hub/backup",
    version: 1,
    servers: [{ id: "a", name: "qfun", transport: "streamable-http", url: "http://127.0.0.1:1/mcp" }]
  };
  const r = await call(routes.get("/mcp-hub/backup"), { method: "POST", body: { backup: legacy, mode: "merge" } });
  assert.equal(r.json.ok, true);
  const after = await call(routes.get("/mcp-hub/approval"));
  assert.equal(after.json.approval.followDsh, false, "没写不等于关掉，也不等于打开");
});
