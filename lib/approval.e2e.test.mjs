// 端到端：本插件的 pre-execute 监听器 与 真实的官方 ApprovalService 对接。
// 验证四件事，任何一项都不能靠「看起来很对」蒙混过去：
//   1. ask 时真的走到官方 answerer waterfall，而不是本插件自己决定；
//   2. 官方在请求前后各写一条审计事件（approval/asked + approval/decided），
//      这证明我们消费的是官方 seam，不是绕过去自己弹窗；
//   3. 应答者返回 allowed-once 后本插件放行并记住会话授权；
//   4. 官方策略是 never 时，本插件连 request() 都不该调。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DSH_PKGS = "D:\\nodejs\\node_global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai";
const home = mkdtempSync(join(tmpdir(), "mcp-hub-e2e-"));
process.env.DSH_HOME = home;

const cordis = await import("file:///" + join(DSH_PKGS, "cordis", "lib", "index.js").replace(/\\/g, "/"));
const approvalMod = await import("file:///" + join(DSH_PKGS, "dsh-user-approval", "lib", "index.js").replace(/\\/g, "/"));
const Context = cordis.Context || cordis.default;

// 官方 request() 要求调用发生在未结束的轮次内（turn/start 已写、turn/end 未写），
// 否则会在审计前抛异常。替身必须如实模拟这个前置条件，否则测试会轻松通过而线上崩。
function makeTurnSession(id) {
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
    __events: events,
    __beginTurn() {
      events.push({ type: "turn/start", data: {} });
    },
    __endTurn() {
      events.push({ type: "turn/end", data: {} });
    }
  };
}

function seed() {
  mkdirSync(join(home, "storages", "mcp-hub"), { recursive: true });
  writeFileSync(
    join(home, "storages", "mcp-hub", "config.json"),
    JSON.stringify({
      profile: "",
      approval: { followDsh: true },
      servers: [
        {
          id: "srv_qfun",
          name: "qfun",
          transport: "streamable-http",
          url: "http://127.0.0.1:1/mcp",
          enabled: true,
          approvalMode: "inherit",
          tools: {}
        }
      ]
    })
  );
}

// 造一个真实 ApprovalService，并注册一个「人类应答者」监听 approval/request。
function buildWorld({ policy = "ask", answer = "allowed-once" } = {}) {
  const app = new Context();
  const svc = new approvalMod.ApprovalService(app, { policy });
  const asked = [];
  app.on("approval/request", async (req) => {
    asked.push(req);
    return answer;
  });
  return { app, svc, asked };
}

async function loadPlugin({ svc, sessions }) {
  const url = new URL("./index.js", import.meta.url).href + "?e2e=" + Math.random();
  const plugin = await import(url);
  const handlers = { pre: [], post: [] };
  // 插件拿到的是一个包装对象，而不是真实的 Cordis App。
  // 在真实 App 上覆写 get/on 会破坏 Cordis 自己的服务解析，
  // 让官方 waterfall 静默退化成 unavailable——那样测的就不是官方的行为了。
  const ctx = {
    get(name) {
      if (name === "approval") return svc;
      if (name === "sessions") return { list: () => sessions };
      if (name === "tools") return { guard: () => () => {}, schemas: () => [], execute: async () => ({ content: [] }) };
      return undefined;
    },
    on(event, fn) {
      if (event === "tools/pre-execute") handlers.pre.push(fn);
      if (event === "tools/post-execute") handlers.post.push(fn);
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
  return { plugin, handlers };
}

async function runPre(handlers, exec) {
  let passed = false;
  const next = async () => {
    passed = true;
    return { kind: "allow" };
  };
  const decision = await handlers.pre[0](exec, next);
  return { decision, passed };
}

// 真实的 exec.signal 是 AbortSignal：官方 decide() 会调 addEventListener / removeEventListener。
// 用假的 plain object 会让官方在 signal.addEventListener 上抛异常，
// 然后被本插件按 fail closed 折成 unavailable——测出来的是替身的缺陷，不是插件的行为。
function abortSignal() {
  return new AbortController().signal;
}

function execFor(session) {
  return {
    name: "mcp__qfun__send_msg",
    callId: "call_e2e",
    arguments: { to: 10001, text: "hi" },
    agent: { session },
    signal: abortSignal()
  };
}

test("ask：真正经由官方 waterfall，并留下官方审计对", async () => {
  seed();
  const { app, svc, asked } = buildWorld({ policy: "ask", answer: "allowed-once" });
    const session = makeTurnSession("e2e-ask");
    const { handlers } = await loadPlugin({ svc, sessions: [session] });
  session.__beginTurn();

  const { passed, decision } = await runPre(handlers, execFor(session));
  assert.equal(asked.length, 1, "必须真的走到官方应答者");
  assert.equal(asked[0].toolName, "mcp__qfun__send_msg", "工具名必须是全限定名");
  assert.ok(asked[0].reason && asked[0].reason.includes("MCP 审批"), "原因要能被人读懂");
  assert.ok(asked[0].displayReason?.zh, "面板需要本地化文案");
  assert.equal(passed, true);
  assert.equal(decision.kind, "allow");

  // 官方 seam 的审计保证：一次 ask 必然配对 asked + decided。
  const askedEvents = session.__events.filter((e) => e.type === "approval/asked");
  const decidedEvents = session.__events.filter((e) => e.type === "approval/decided");
  assert.equal(askedEvents.length, 1, "官方应写入 approval/asked");
  assert.equal(decidedEvents.length, 1, "官方应写入配对的 approval/decided");
  assert.equal(decidedEvents[0].data.outcome, "allowed-once");
  assert.equal(askedEvents[0].data.id, decidedEvents[0].data.id, "两条审计必须同 id");
});

test("ask + 用户拒绝：官方审计记录 rejected，本插件返回官方措辞的 deny", async () => {
  seed();
  const { app, svc } = buildWorld({ policy: "ask", answer: "rejected" });
    const session = makeTurnSession("e2e-reject");
    const { handlers } = await loadPlugin({ svc, sessions: [session] });
  session.__beginTurn();

  const { passed, decision } = await runPre(handlers, execFor(session));
  assert.equal(passed, false);
  assert.equal(decision.kind, "deny");
  assert.equal(decision.reason, 'the user rejected tool "mcp__qfun__send_msg"');
  const decided = session.__events.find((e) => e.type === "approval/decided");
  assert.equal(decided.data.outcome, "rejected");
});

test("never：连官方 request() 都不调，也不写任何审批审计", async () => {
  seed();
  const { app, svc, asked } = buildWorld({ policy: "never", answer: "allowed-once" });
    const session = makeTurnSession("e2e-never");
    const { handlers } = await loadPlugin({ svc, sessions: [session] });
  session.__beginTurn();

  const { passed } = await runPre(handlers, execFor(session));
  assert.equal(asked.length, 0, "never 下不该询问");
  assert.equal(passed, true, "never 在 MCP 上是「别提示」，应放行");
  assert.equal(session.__events.filter((e) => e.type === "approval/asked").length, 0);
});

test("会话级授权：第二次调用不再产生新的官方审计对", async () => {
  seed();
  const { app, svc, asked } = buildWorld({ policy: "ask", answer: "allowed-once" });
    const session = makeTurnSession("e2e-grant");
    const { handlers } = await loadPlugin({ svc, sessions: [session] });
  session.__beginTurn();

  await runPre(handlers, execFor(session));
  assert.equal(asked.length, 1);
  await runPre(handlers, execFor(session));
  assert.equal(asked.length, 1, "同会话同服务器复用授权，不再问");
  assert.equal(session.__events.filter((e) => e.type === "approval/asked").length, 1);
});

test("官方策略从 ask 切到 never 后，同一会话立刻不再询问", async () => {
  seed();
  const { app, svc, asked } = buildWorld({ policy: "ask", answer: "allowed-once" });
    const session = makeTurnSession("e2e-switch");
    const { handlers } = await loadPlugin({ svc, sessions: [session] });
  session.__beginTurn();

  await runPre(handlers, execFor(session));
  assert.equal(asked.length, 1);

  // 另一个会话（没有历史授权），用 /permission danger-full-access 之后应直接放行。
  const s2 = makeTurnSession("e2e-switch-2");
  s2.__beginTurn();
  approvalMod.setApprovalPolicy(s2, "never");
  const { passed } = await runPre(handlers, execFor(s2));
  assert.equal(passed, true);
  assert.equal(asked.length, 1, "切到 never 后不应再问");
});


