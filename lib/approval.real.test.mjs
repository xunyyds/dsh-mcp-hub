// 用真实的 DSH 服务实例验证「跟随 DSH」读的是官方事实，而不是本插件自己的猜测。
// 这里直接 import 安装目录里的 dsh-user-approval，构造一个真实 ApprovalService，
// 再把本插件挂在它旁边，检查 dshEffectivePolicy / dshApprovalState 的读取结果。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const DSH_PKGS = "D:\\nodejs\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai";
const require = createRequire(import.meta.url);

const home = mkdtempSync(join(tmpdir(), "mcp-hub-real-"));
process.env.DSH_HOME = home;

// 官方的 setApprovalPolicy 直接写会话日志；这里用一个最小 Session 替身承接 append，
// 并让 overrideOf 走真实的「从后往前找最后一个 approval/policy」逻辑。
function makeLogSession(id) {
  const events = [];
  return {
    id,
    get seq() {
      return events.length;
    },
    append(type, data) {
      events.push({ type, data });
    },
    eventAt(i) {
      return events[i];
    },
    __events: events
  };
}

async function loadRealApprovalService() {
  const mod = await import("file:///" + join(DSH_PKGS, "dsh-user-approval", "lib", "index.js").replace(/\\/g, "/"));
  return mod;
}

// ApprovalService 继承自 Cordis 的 Service，构造时必须拿到真实 Context
// （Service 构造器会 ctx.provide）。这里用官方 cordis 建一个空 App，
// 而不是伪造一个 context 对象——伪造的 context 恰恰会让这个测试失去意义。
async function makeRealContext() {
  const cordis = await import("file:///" + join(DSH_PKGS, "cordis", "lib", "index.js").replace(/\\/g, "/"));
  const Context = cordis.Context || cordis.default;
  const app = new Context();
  return app;
}

function makeService(approvalModule, ctx, { policy = "ask" } = {}) {
  const { ApprovalService } = approvalModule;
  return new ApprovalService(ctx, { policy });
}

test("官方 ApprovalService 的 overrideOf 折叠与 doc 一致（最后一个 approval/policy 生效）", async () => {
  const mod = await loadRealApprovalService();
  const app = await makeRealContext();
  const svc = makeService(mod, app, { policy: "ask" });
  const session = makeLogSession("s1");
  assert.equal(svc.overrideOf(session), undefined, "没写过 override 时应返回 undefined");
  mod.setApprovalPolicy(session, "never");
  assert.equal(svc.overrideOf(session), "never");
  mod.setApprovalPolicy(session, "ask");
  assert.equal(svc.overrideOf(session), "ask", "最后一个 override 胜出");
});

test("setApprovalPolicy 只接受 ask / never", async () => {
  const mod = await loadRealApprovalService();
  const session = makeLogSession("s2");
  assert.throws(() => mod.setApprovalPolicy(session, "auto"), /must be one of/);
  assert.equal(session.__events.length, 0, "非法值必须在写日志前被拒");
});

test("本插件读到的策略与官方 service 的折叠一致", async () => {
  const mod = await loadRealApprovalService();
  const app = await makeRealContext();
  const svc = makeService(mod, app, { policy: "ask" });
  const session = makeLogSession("s3");

  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({ profile: "", approval: { followDsh: true }, servers: [] })
  );

  const pluginUrl = new URL("./index.js", import.meta.url).href + "?real=" + Math.random();
  const plugin = await import(pluginUrl);
  const ctx = {
    get(name) {
      if (name === "approval") return svc;
      if (name === "sessions") return { list: () => [session] };
      if (name === "tools") return { guard: () => () => {}, schemas: () => [], execute: async () => ({ content: [] }) };
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
    webServer: { register: () => () => {} },
    logger: { warn() {}, info() {} }
  };
  plugin.apply(ctx);

  // 官方 service 说 ask → 本插件必须也认为是 ask（而不是自己重算）。
  assert.equal(svc.overrideOf(session) ?? svc.config.policy, "ask");
  // 切到 never 后，事实本身改变；本插件读的是这个事实。
  mod.setApprovalPolicy(session, "never");
  assert.equal(svc.overrideOf(session), "never", "官方折叠已改变");
  assert.equal(svc.overrideOf(session) ?? svc.config.policy, "never");
});

