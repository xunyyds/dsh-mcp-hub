// HTTP 路由测试：验证 /mcp-hub/approval 的读写、服务器三态、以及备份兼容。
// 同样不启动 DSH：webServer.register 被换成一个只记录 handler 的假实现。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
// 默认带上「本机同源浏览器」的请求头——凭证类接口要求同源 + 回环，
// 不带头的请求会拿到 403，因此测试必须模拟真实面板的调用方式。
function call(handler, { method = "GET", url = "/mcp-hub/approval", body, headers } = {}) {
  return new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
    const baseHeaders = {
      host: "127.0.0.1:58406",
      origin: "http://127.0.0.1:58406",
      "sec-fetch-site": "same-origin"
    };
    const req = {
      method,
      url,
      headers: Object.assign(baseHeaders, headers || {}),
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

test("grant：为「本次会话都允许」写入一条工具级授权", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/approval"), {
    method: "POST",
    body: { action: "grant", session: "sess-1", toolName: "mcp__qfun__send_msg" }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.granted.server, "qfun");
  assert.equal(r.json.granted.tool, "send_msg");
  const g = r.json.grants.find((x) => x.session === "sess-1");
  assert.ok(g, "授权应出现在列表里");
  assert.equal(g.tool, "send_msg", "粒度必须是工具");
});

test("grant：拒绝非本插件的工具名，不能被当成任意放行通道", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin();
  for (const toolName of ["bash", "pwsh", "mcp__unknown__x", ""]) {
    const r = await call(routes.get("/mcp-hub/approval"), {
      method: "POST",
      body: { action: "grant", session: "sess-1", toolName }
    });
    assert.equal(r.json.ok, false, "应拒绝：" + toolName);
  }
  const after = await call(routes.get("/mcp-hub/approval"));
  assert.equal(after.json.grants.length, 0, "拒绝后不该留下任何授权");
});

test("grant：缺 session 时拒绝", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/approval"), {
    method: "POST",
    body: { action: "grant", toolName: "mcp__qfun__send_msg" }
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test("pending：未知 callId 返回 ok:false，绝不猜工具名", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/pending"), { url: "/mcp-hub/pending?callId=nope" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.toolName, undefined);
});

test("pending：缺 callId 返回 400", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/pending"), { url: "/mcp-hub/pending" });
  assert.equal(r.status, 400);
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

// ── 凭证在面板与磁盘之间的往返 ────────────────────────────────
// 这几条守的是同一件事：保存一次面板不能把已存的 Token 弄丢。
// 之前 statusOf 从不返回 token，编辑器拿到空值，一保存就把它覆盖成空串。

test("GET /servers 把已保存的 Token 带回来（_token），编辑器才能填回输入框", async () => {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({
      profile: "",
      approval: { followDsh: true },
      servers: [{ id: "t1", name: "tokened", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", token: "sk-live-abc123" }]
    })
  );
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/servers"));
  assert.equal(r.json.servers.length, 1);
  assert.equal(r.json.servers[0]._token, "sk-live-abc123");
  assert.equal(r.json.servers[0].tokenConfigured, true);
});

test("GET /status 不带明文 Token：轮询响应里不该出现密码", async () => {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({
      profile: "",
      approval: { followDsh: true },
      servers: [{ id: "t2", name: "tokened", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", token: "sk-live-abc123" }]
    })
  );
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/status"));
  const s = r.json.servers[0];
  assert.equal(s._token, undefined, "status 是每 12 秒一次的轮询，不该带明文凭证");
  assert.equal(s.tokenConfigured, true, "但要能说明「已配置」，否则面板无法区分没设与已设");
});

test("保存时不传 token：保留原凭证，不能把已存的 Token 抹掉", async () => {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({
      profile: "",
      approval: { followDsh: true },
      servers: [{ id: "keep", name: "keepme", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", token: "sk-keep-me" }]
    })
  );
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/servers"), {
    method: "POST",
    body: { server: { id: "keep", name: "keepme", transport: "streamable-http", url: "http://127.0.0.1:2/mcp" } }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.server._token, "sk-keep-me", "改了 URL 也不该顺手清掉 Token");
  assert.equal(r.json.server.url, "http://127.0.0.1:2/mcp");
});

test("显式传空 token：真的把它清掉", async () => {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({
      profile: "",
      approval: { followDsh: true },
      servers: [{ id: "clr", name: "clearme", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", token: "sk-clear-me" }]
    })
  );
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/servers"), {
    method: "POST",
    body: { server: { id: "clr", name: "clearme", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", token: "" } }
  });
  assert.equal(r.json.server._token, "");
  assert.equal(r.json.server.tokenConfigured, false, "点「清除」后必须真的没有凭证");
});

test("保存时不传 tools：逐工具策略原样保留", async () => {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({
      profile: "",
      approval: { followDsh: true },
      servers: [{
        id: "pol",
        name: "pol",
        transport: "streamable-http",
        url: "http://127.0.0.1:1/mcp",
        tools: { send_msg: { enabled: false, approval: true } }
      }]
    })
  );
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/servers"), {
    method: "POST",
    body: { server: { id: "pol", name: "pol", transport: "streamable-http", url: "http://127.0.0.1:9/mcp" } }
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.server.tools.send_msg.enabled, false, "改 URL 不能把禁用状态清掉");
  assert.equal(r.json.server.tools.send_msg.approval, true);
});

test("改名撞上已有服务器：400，且原配置一字未改", async () => {
  seed({
    servers: [
      { id: "a", name: "alpha", transport: "streamable-http", url: "http://127.0.0.1:1/mcp" },
      { id: "b", name: "beta", transport: "streamable-http", url: "http://127.0.0.1:2/mcp" }
    ]
  });
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/servers"), {
    method: "POST",
    body: { server: { id: "b", name: "alpha", transport: "streamable-http", url: "http://127.0.0.1:2/mcp" } }
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /已存在/);
  const after = await call(routes.get("/mcp-hub/servers"));
  const names = after.json.servers.map((s) => s.serverName).sort();
  assert.deepEqual(names, ["alpha", "beta"], "被拒的写入不能留下副作用");
});

test("磁盘上的配置是密文：Token 不以明文落盘", async () => {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({ profile: "", approval: { followDsh: true }, servers: [] })
  );
  const { routes } = await loadPlugin();
  await call(routes.get("/mcp-hub/servers"), {
    method: "POST",
    body: { server: { name: "sealed", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", token: "sk-should-be-encrypted" } }
  });
  const onDisk = readFileSync(join(home, "storages", "mcp-hub", "config.json"), "utf8");
  assert.ok(!onDisk.includes("sk-should-be-encrypted"), "明文 Token 不能出现在 config.json 里");
  assert.ok(onDisk.includes("enc:v1:"), "应以 enc:v1: 前缀存放密文");
  // 但面板必须还能读回明文，否则用户看不到自己存了什么。
  const back = await call(routes.get("/mcp-hub/servers"));
  assert.equal(back.json.servers[0]._token, "sk-should-be-encrypted");
});

// ── 凭证只回给本机同源请求 ────────────────────────────────────
// webServer 绑哪个地址不由本插件决定。一旦被改绑到局域网（有专门的插件干这事），
// 任何人只要能访问端口，就能通过 /servers、/backup、/import 读走全部 Token。

test("非本机（跨源）请求读不到 Token：/servers 仍可用但不含凭证", async () => {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({
      profile: "",
      approval: { followDsh: true },
      servers: [{ id: "x1", name: "lan", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", token: "sk-lan-secret" }]
    })
  );
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/servers"), {
    headers: { host: "192.168.1.20:58406", origin: "http://192.168.1.20:58406", "sec-fetch-site": "same-origin" }
  });
  assert.equal(r.status, 200, "非本机也要能管理结构，只是看不见凭证");
  assert.equal(r.json.credentialVisible, false);
  assert.equal(r.json.servers[0]._token, undefined, "局域网访问绝不能拿到明文 Token");
  assert.equal(r.json.servers[0].tokenConfigured, true, "但仍要说明已配置");
});

test("跨站页面（异源 Origin）即便打 127.0.0.1 也拿不到凭证", async () => {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({
      profile: "",
      approval: { followDsh: true },
      servers: [{ id: "x2", name: "csrf", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", token: "sk-csrf" }]
    })
  );
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/servers"), {
    headers: { host: "127.0.0.1:58406", origin: "http://evil.example", "sec-fetch-site": "cross-site" }
  });
  assert.equal(r.json.credentialVisible, false);
  assert.equal(r.json.servers[0]._token, undefined);
});

test("无 Origin 的本机直连放行；无 Origin 的远程请求拒绝", async () => {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({ profile: "", approval: { followDsh: true }, servers: [] })
  );
  const { routes } = await loadPlugin();
  const local = await call(routes.get("/mcp-hub/servers"), { headers: { host: "127.0.0.1:58406", origin: "", "sec-fetch-site": "" } });
  assert.equal(local.json.credentialVisible, true, "本机脚本/直连等同读文件，允许");
  const remote = await call(routes.get("/mcp-hub/servers"), { headers: { host: "192.168.1.20:58406", origin: "", "sec-fetch-site": "" } });
  assert.equal(remote.json.credentialVisible, false, "远程裸连不给凭证");
});

test("备份路由对非本机请求直接 403（备份里有明文 Token 与补丁全文）", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin();
  const local = await call(routes.get("/mcp-hub/backup"));
  assert.equal(local.status, 200, "本机导出必须照常可用");
  const remote = await call(routes.get("/mcp-hub/backup"), {
    headers: { host: "192.168.1.20:58406", origin: "http://192.168.1.20:58406", "sec-fetch-site": "same-origin" }
  });
  assert.equal(remote.status, 403);
  assert.match(remote.json.error, /只接受本机同源请求/);
});

test("导入/补丁状态路由对非本机请求 403（block 里有 Authorization 表达式）", async () => {
  seed({ followDsh: true });
  const { routes } = await loadPlugin();
  const remote = await call(routes.get("/mcp-hub/import"), {
    headers: { host: "192.168.1.20:58406", origin: "http://192.168.1.20:58406", "sec-fetch-site": "same-origin" }
  });
  assert.equal(remote.status, 403);
});

// ── 加载补丁：只动自己的桥接区，别把别人的配置吃掉 ─────────────
// findBridgeInPatch 以前把 end 写死成文件末尾又不用它，两个调用点都从 start
// 一路截到结尾。用户在 cordis.patch.yml 里手工加在桥接后面的条目，下次
// 「写入加载补丁」或「移除桥接」时会静默消失。

function seedServers(list) {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({ profile: "", approval: { followDsh: true }, servers: list }, null, 2)
  );
}
function patchFile() {
  return join(process.cwd(), "cordis.patch.yml");
}

test("写入加载补丁不会删掉桥接区之后的手工条目", async () => {
  seedServers([{ id: "p1", name: "alphap", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", enabled: true }]);
  const original = readFileSync(patchFile(), "utf8");
  // 造一个「桥接之后还有别的内容」的状态。
  const withTail = original.replace(/\s*$/, "") + "\n\n# 手工追加的另一个插件条目\n- insert:\n    - id: someone-else\n      name: '@other/plugin'\n";
  writeFileSync(patchFile(), withTail);
  try {
    const { routes } = await loadPlugin();
    const r = await call(routes.get("/mcp-hub/import"), { method: "POST", body: { mode: "add" } });
    assert.equal(r.json.ok, true);
    const after = readFileSync(patchFile(), "utf8");
    assert.ok(after.includes("someone-else"), "桥接区之后的条目必须保留");
    assert.ok(after.includes("@other/plugin"));
  } finally {
    writeFileSync(patchFile(), original);
  }
});

test("移除桥接同样保留后面的手工条目", async () => {
  seedServers([{ id: "p2", name: "betap", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", enabled: true }]);
  const original = readFileSync(patchFile(), "utf8");
  const withTail = original.replace(/\s*$/, "") + "\n\n# 后面还有内容\n- insert:\n    - id: keep-me\n      name: '@other/keep'\n";
  writeFileSync(patchFile(), withTail);
  try {
    const { routes } = await loadPlugin();
    const r = await call(routes.get("/mcp-hub/import"), { method: "POST", body: { mode: "remove" } });
    assert.equal(r.json.ok, true);
    const after = readFileSync(patchFile(), "utf8");
    assert.ok(after.includes("keep-me"), "移除桥接只该删桥接，别的内容要留下");
    assert.ok(!after.includes("mcp-hub-betap"), "桥接本身应被移除");
  } finally {
    writeFileSync(patchFile(), original);
  }
});

test("一台启用的服务器都没有时，写入补丁如实失败而不是假装成功", async () => {
  seedServers([{ id: "p3", name: "disabled", transport: "streamable-http", url: "http://127.0.0.1:1/mcp", enabled: false }]);
  const { routes } = await loadPlugin();
  const r = await call(routes.get("/mcp-hub/import"), { method: "POST", body: { mode: "add" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /没有启用的服务器/);
});

test("删除服务器时连带清掉该名字下的会话授权，防止同名重建继承预批准", async () => {
  seed({
    servers: [{ id: "del1", name: "ghost", transport: "streamable-http", url: "http://127.0.0.1:1/mcp" }]
  });
  const { routes } = await loadPlugin();
  // 先给 ghost 发一条工具级授权。
  await call(routes.get("/mcp-hub/approval"), {
    method: "POST",
    body: { action: "grant", session: "sess-x", toolName: "mcp__ghost__danger" }
  });
  let after = await call(routes.get("/mcp-hub/approval"));
  assert.equal(after.json.grants.length, 1);
  // 删掉这台服务器。
  const del = await call(routes.get("/mcp-hub/servers"), { method: "DELETE", url: "/mcp-hub/servers?id=del1" });
  assert.equal(del.json.ok, true);
  after = await call(routes.get("/mcp-hub/approval"));
  assert.equal(after.json.grants.length, 0, "删服务器必须一并吊销它的授权，否则同名重建会被静默放行");
});


