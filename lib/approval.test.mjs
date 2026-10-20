// 审批判定的行为测试。
// 不启动 DSH：直接构造一个假的 ctx，把 config、tools 注册表、approval seam
// 都换成本地实现，然后对 tools/pre-execute 的真实监听器施加调用。
// 断言的重点是「跟随」到底跟了什么：官方 ask 会弹、官方 never 不弹也不拒、
// 读不到策略时 fail closed、以及一次授权只对同服务器同会话生效。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// DSH_HOME 必须指向临时目录，否则会读写用户真实配置。
const home = mkdtempSync(join(tmpdir(), "mcp-hub-approval-"));
process.env.DSH_HOME = home;

// 用假 session 承载 id：宿主只需要 id 与会话生命周期。
function makeSession(id) {
  return { id, seq: 0, append() {}, eventAt() { return undefined; } };
}

const sessions = new Map();

function makeCtx({ policy, approvalMissing = false, sessionsList = [] } = {}) {
  const handlers = { pre: [], post: [], disposed: [] };
  const approval = {
    config: { policy: policy || "ask" },
    // overrideOf 与官方一致：返回会话上的 override，或 undefined 用默认值。
    overrideOf(session) {
      return session && session.__override;
    },
    calls: [],
    async request(req) {
      approval.calls.push(req);
      approval.lastOutcome = approval.nextOutcome || "allowed-once";
      return approval.lastOutcome;
    }
  };
  const ctx = {
    __approval: approval,
    get(name) {
      if (name === "approval") return approvalMissing ? undefined : approval;
      if (name === "sessions") return { list: () => sessionsList };
      if (name === "tools") return { guard: () => () => {}, schemas: () => [], execute: async () => ({ content: [] }) };
      return undefined;
    },
    on(event, fn) {
      if (event === "tools/pre-execute") handlers.pre.push(fn);
      if (event === "tools/post-execute") handlers.post.push(fn);
      if (event === "session/disposed") handlers.disposed.push(fn);
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
      register() {
        return () => {};
      }
    },
    logger: { warn() {}, info() {} }
  };
  return { ctx, handlers, approval };
}

// 每次测试都重新 import：模块顶层的 cfg 是单例，重载才能拿到干净状态。
let generation = 0;
async function loadPlugin(opts) {
  generation += 1;
  const moduleUrl = new URL("./index.js", import.meta.url).href + "?g=" + generation;
  const mod = await import(moduleUrl);
  const harness = makeCtx(opts);
  mod.apply(harness.ctx);
  return { mod, ...harness };
}

// 写一份配置，让服务器处于受控的 approvalMode。
function seedConfig({ followDsh = true, serverMode = "inherit", tools = {} } = {}) {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify(
      {
        profile: "",
        approval: { followDsh },
        servers: [
          {
            id: "srv_test",
            name: "qfun",
            transport: "streamable-http",
            url: "http://127.0.0.1:1/mcp",
            enabled: true,
            approvalMode: serverMode,
            tools
          }
        ]
      },
      null,
      2
    )
  );
}

function ensureDir() {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
}

async function preFor(handlers, exec) {
  // 只跑本插件的监听器；next() 表示「放行到管线下一环」。
  let passed = false;
  const next = async () => {
    passed = true;
    return { kind: "allow" };
  };
  const decision = await handlers.pre[0](exec, next);
  return { decision, passed };
}

function execFor(name = "mcp__qfun__send_msg", session) {
  return {
    name,
    callId: "call_1",
    arguments: { to: 10001, text: "hi" },
    agent: { session },
    signal: { aborted: false }
  };
}

test("总开关关闭 + 逐工具未勾选：放行且不问", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: false });
  const { handlers, approval } = await loadPlugin();
  const { decision, passed } = await preFor(handlers, execFor(undefined, makeSession("s1")));
  assert.equal(passed, true);
  assert.equal(decision.kind, "allow");
  assert.equal(approval.calls.length, 0);
});

test("总开关关闭 + 逐工具勾选：走官方 seam 询问", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: false, tools: { send_msg: { approval: true } } });
  const { handlers, approval } = await loadPlugin();
  const { decision, passed } = await preFor(handlers, execFor(undefined, makeSession("s1")));
  assert.equal(approval.calls.length, 1, "manual 勾选必须真的问一次");
  assert.equal(passed, true);
  assert.equal(decision.kind, "allow");
});

test("跟随 + ask：弹一次官方审批，批准后放行", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  const { decision, passed } = await preFor(handlers, execFor(undefined, makeSession("s1")));
  assert.equal(approval.calls.length, 1);
  assert.equal(passed, true);
  assert.equal(decision.kind, "allow");
  // 请求必须带官方要求的字段，否则客户端面板拿不到可展示的原因。
  const req = approval.calls[0];
  assert.equal(req.toolName, "mcp__qfun__send_msg");
  assert.ok(typeof req.reason === "string" && req.reason.length > 0);
  assert.ok(req.displayReason && req.displayReason.zh && req.displayReason.en);
});

test("跟随 + ask：拒绝映射成与官方一致的措辞", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  approval.nextOutcome = "rejected";
  const { decision, passed } = await preFor(handlers, execFor(undefined, makeSession("s1")));
  assert.equal(passed, false);
  assert.equal(decision.kind, "deny");
  assert.equal(decision.reason, 'the user rejected tool "mcp__qfun__send_msg"');
});

test("跟随 + ask：取消映射成 cancel，而不是 deny", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  approval.nextOutcome = "cancelled";
  const { decision } = await preFor(handlers, execFor(undefined, makeSession("s1")));
  assert.equal(decision.kind, "cancel");
});

test("跟随 + ask：没有应答者时 fail closed", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  approval.nextOutcome = "unavailable";
  const { decision } = await preFor(handlers, execFor(undefined, makeSession("s1")));
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /no approval channel is available/);
});

test("跟随 + never：不弹窗，直接放行（不是拒绝）", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers, approval } = await loadPlugin({ policy: "never" });
  const { decision, passed } = await preFor(handlers, execFor(undefined, makeSession("s1")));
  assert.equal(approval.calls.length, 0, "never 下绝不能弹窗");
  assert.equal(passed, true, "never 在 MCP 上是「别提示」，必须放行");
  assert.equal(decision.kind, "allow");
});

test("跟随 + 会话 override 优先于部署默认值", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  const session = makeSession("s-ovr");
  session.__override = "never";
  const { passed } = await preFor(handlers, execFor(undefined, session));
  assert.equal(passed, true);
  assert.equal(approval.calls.length, 0, "会话已切到 never，就不该再问");
});

test("审批服务缺失：明确拒绝并说明原因，不静默放行", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers } = await loadPlugin({ approvalMissing: true });
  const { decision, passed } = await preFor(handlers, execFor(undefined, makeSession("s1")));
  assert.equal(passed, false);
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /官方审批服务不可用/);
});

test("一次授权只在同一会话内免问；换会话重新问", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  const s1 = makeSession("session-1");
  await preFor(handlers, execFor(undefined, s1));
  assert.equal(approval.calls.length, 1);
  // 同会话第二次：不再问。
  await preFor(handlers, execFor(undefined, s1));
  assert.equal(approval.calls.length, 1, "同会话同服务器应复用授权");
  // 换会话：必须重新问。
  const s2 = makeSession("session-2");
  await preFor(handlers, execFor(undefined, s2));
  assert.equal(approval.calls.length, 2, "授权不得跨会话");
});

test("授权按服务器隔离：另一台服务器仍需自己的授权", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  const s1 = makeSession("session-1");
  await preFor(handlers, execFor(undefined, s1));
  assert.equal(approval.calls.length, 1);
  // 未配置的另一台服务器：本插件不管它，直接交给管线。
  const foreign = await preFor(handlers, execFor("mcp__other__ping", s1));
  assert.equal(foreign.passed, true);
  assert.equal(approval.calls.length, 1);
});

test("会话结束时释放授权", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  const s1 = makeSession("session-1");
  await preFor(handlers, execFor(undefined, s1));
  assert.equal(approval.calls.length, 1);
  for (const fn of handlers.disposed) fn(s1);
  await preFor(handlers, execFor(undefined, s1));
  assert.equal(approval.calls.length, 2, "会话销毁后授权必须失效");
});

test("manual 模式不受会话授权影响：每次都要问", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true, serverMode: "manual", tools: { send_msg: { approval: true } } });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  const s1 = makeSession("session-1");
  await preFor(handlers, execFor(undefined, s1));
  await preFor(handlers, execFor(undefined, s1));
  assert.equal(approval.calls.length, 2, "manual 是显式逐工具规则，不该被记住的授权绕过");
});

test("面板禁用仍然单调否决（guard 之外的第二道）", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true, tools: { send_msg: { enabled: false } } });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  const { decision, passed } = await preFor(handlers, execFor(undefined, makeSession("s1")));
  assert.equal(passed, false);
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /已在面板中禁用/);
  assert.equal(approval.calls.length, 0);
});

test("面板调试调用（无 agent）不被审批挡住", async () => {
  ensureDir(join(home, "storages", "mcp-hub"));
  seedConfig({ followDsh: true });
  const { handlers, approval } = await loadPlugin({ policy: "ask" });
  const exec = { name: "mcp__qfun__send_msg", arguments: {}, agent: undefined, signal: { aborted: false } };
  const { passed } = await preFor(handlers, exec);
  assert.equal(passed, true, "点「运行」本身就是授权");
  assert.equal(approval.calls.length, 0);
});
