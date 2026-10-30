// 三部件接进 index.js 之后的端到端回归。
//
// 前面三个测试文件各自锁住一个纯模块（capability-index / context-budget /
// jit-hint）。但那三个模块单独都对、接错了也照样全绿——本文件锁的是「接上以后」：
//   1) 能力摘要真的出现在系统提示词里，且不含工具名（那会白烧前缀）；
//   2) 关掉开关就真的消失，不是「开关存在但没人读」；
//   3) JIT 提示走的是官方 systemPrompt.context()，节流按会话生效；
//   4) 提示里的信号文本不能把上一轮自己的提示读回来——否则它自我续命。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "mcp-hub-cap-"));
process.env.DSH_HOME = home;

const REGISTERED = [
  { name: "mcp__mobile__mobile_get_crash", description: "Get the full content of a crash report by its ID.", parameters: { type: "object", properties: { crashId: { type: "string" } }, required: ["crashId"] } },
  { name: "mcp__mobile__mobile_list_crashes", description: "List crash reports available on the device", parameters: { type: "object", properties: {} } },
  { name: "mcp__mobile__mobile_get_device_logs", description: "Collect live device logs (logcat on Android).", parameters: { type: "object", properties: {} } },
  { name: "mcp__mobile__mobile_take_screenshot", description: "Take a screenshot of the mobile device.", parameters: { type: "object", properties: {} } },
  { name: "mcp__mobile__mobile_install_app", description: "Install an app on mobile device", parameters: { type: "object", properties: { appPath: { type: "string" } } } },
  { name: "mcp__rea__disassemble_function", description: "Disassemble a function at an address.", parameters: { type: "object", properties: { address: { type: "string" } } } },
  { name: "mcp__rea__list_symbols", description: "List symbols in a module.", parameters: { type: "object", properties: {} } },
  { name: "mcp__rea__open_binary", description: "Open a binary for analysis.", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "read", description: "builtin", parameters: { type: "object", properties: {} } }
];

function makeCtx(registered) {
  const sections = [];
  const contexts = [];
  const schemas = registered || REGISTERED;
  const tools = {
    guard: () => () => {},
    schemas: () => schemas,
    execute: async () => ({ content: [] }),
    register: () => () => {}
  };
  const ctx = {
    get(name) {
      if (name === "tools") return tools;
      if (name === "approval") return { config: { policy: "never" }, overrideOf: () => undefined, request: async () => "allowed-once" };
      if (name === "sessions") return { list: () => [] };
      return undefined;
    },
    on: () => () => {},
    inject(deps, fn) {
      if (deps.includes("systemPrompt")) {
        fn({
          systemPrompt: {
            section(spec) {
              sections.push(spec);
              return () => {};
            },
            context(spec) {
              contexts.push(spec);
              return () => {};
            }
          }
        });
      }
    },
    effect(fn) {
      const off = fn();
      return typeof off === "function" ? off : () => {};
    },
    tools,
    webServer: { register: () => () => {} },
    logger: { warn() {}, info() {} }
  };
  return { ctx, sections, contexts };
}

function seed(extra, servers) {
  const dir = join(home, "storages", "mcp-hub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    profile: "",
    approval: { followDsh: true },
    servers: servers || [
      { id: "s1", name: "mobile", transport: "stdio", command: "x", enabled: true, tools: {} },
      { id: "s2", name: "rea", transport: "stdio", command: "y", enabled: true, tools: {} }
    ],
    ...(extra || {})
  }, null, 2));
}

let gen = 0;
async function load(extra, servers, registered) {
  seed(extra, servers);
  gen += 1;
  const url = new URL("./index.js", import.meta.url).href + "?t=" + gen;
  const mod = await import(url);
  const h = makeCtx(registered);
  mod.apply(h.ctx);
  return { mod, ...h };
}

const catalogOf = (sections) => sections.find((s) => s.name === "mcp-hub:tool-catalog");

// ── 部件一：能力摘要进提示词 ─────────────────────────────────
test("能力摘要自动出现在目录里，且不带任何工具名", async () => {
  const { sections } = await load({ catalog: { capabilities: true } });
  const cat = catalogOf(sections);
  assert.ok(cat, "目录 section 必须注册");
  const text = cat.text();
  assert.ok(text.includes("mobile（5 个工具）"), "服务器与工具数要在：" + text);
  // 特征词是「：」后面那串，用「·」连接。至少要有一个中文能力词，
  // 否则说明摘要根本没接上，只是目录原样渲染。
  assert.ok(/mobile（5 个工具）：[^、]*·/.test(text), "必须挂上特征词：" + text);
  assert.ok(/崩溃|截图|日志|安装/.test(text), "特征词里应该有能一眼认出的能力词：" + text);
  // 工具名一旦进提示词，省下来的前缀就白省了。
  assert.ok(!text.includes("mcp__"), "不能出现完整工具名：" + text);
  assert.ok(!text.includes("get_crash"), "不能出现裸工具名：" + text);
});

test("关掉能力摘要开关后特征词消失，只剩服务器名与工具数", async () => {
  const { sections } = await load({ catalog: { capabilities: false } });
  const text = catalogOf(sections).text();
  assert.ok(text.includes("mobile（5 个工具）"), "目录本身照旧：" + text);
  // 只看「服务器：」那一行：说明文字里本来就有冒号与括号，整段匹配会误判。
  const line = text.split("\n").find((l) => l.startsWith("服务器："));
  assert.ok(line, "目录里必须有服务器行：" + text);
  // 关掉后每一台的形态必须精确回到「名字（N 个工具）」，不多一个字符。
  assert.equal(line, "服务器：mobile（5 个工具）、rea（3 个工具）", "关掉后不该留任何特征词：" + line);
});

test("能力摘要不随工具总数膨胀：目录体积仍在一千字节量级", async () => {
  const { sections } = await load({ catalog: { capabilities: true } });
  const text = catalogOf(sections).text();
  assert.ok(Buffer.byteLength(text) < 1200, "目录应保持在一千字节量级，实际 " + Buffer.byteLength(text));
});

test("同一份配置两次装配逐字节一致（前缀不能每一步都变）", async () => {
  const { sections } = await load({ catalog: { capabilities: true } });
  const cat = catalogOf(sections);
  assert.equal(cat.text(), cat.text());
});

test("工具很少的服务器不拿低频词凑数：宁可不挂摘要，也不用噪音填满", async () => {
  // 补一台只有 1 个工具的服务器：它凑不出 3 个有意义的能力词，
  // 尾部那些排不进正文的低频词（take / module / available）就是在凑数。
  // 注意工具名必须真的存在于注册表里——目录只列「现在真的能调用」的。
  const withTiny = [
    ...REGISTERED,
    { name: "mcp__tiny__ping", description: "Ping the service.", parameters: { type: "object", properties: {} } }
  ];
  const { sections } = await load({ catalog: { capabilities: true } },
    [
      { id: "s1", name: "mobile", transport: "stdio", command: "x", enabled: true, tools: {} },
      { id: "s2", name: "rea", transport: "stdio", command: "y", enabled: true, tools: {} },
      { id: "s3", name: "tiny", transport: "stdio", command: "z", enabled: true, tools: {} }
    ], withTiny);
  const line = catalogOf(sections).text().split("\n").find((l) => l.startsWith("服务器："));
  assert.ok(line, "目录必须有服务器行：" + line);
  // 1 个工具的服务器：没有冒号那一段，直接止于「）」。
  assert.ok(line.includes("tiny（1 个工具）"), "服务器本身要在：" + line);
  assert.ok(!line.includes("tiny（1 个工具）："), "凑不出有意义特征词时不该硬挂：" + line);
  // 而工具够多的那两台仍然要有摘要。
  assert.ok(/mobile（\d+ 个工具）：\S+·/.test(line), "mobile 必须有特征词：" + line);
  assert.ok(/rea（\d+ 个工具）：\S+·/.test(line), "rea 必须有特征词：" + line);
});

// ── 部件三：JIT 提示 ─────────────────────────────────────────
const agentWith = (id, texts) => ({
  session: {
    id,
    snapshotEvents: () => texts.map((t, i) => ({
      seq: i,
      type: "user/message",
      data: { source: { kind: i === 0 ? "user" : "tool" }, content: [{ type: "text", text: t }] }
    }))
  }
});

test("JIT 提示默认关闭：开关没打开时一条都不出", async () => {
  const { contexts } = await load({});
  const hint = contexts.find((c) => c.name === "mcp-hub:jit-hint");
  assert.ok(hint, "context 必须注册（注册了但不出词 = 关闭）");
  const out = hint.text({ agent: agentWith("s-off", ["push libil2cpp.so 然后 adb logcat"]) });
  assert.equal(out, "", "默认关闭时不该出提示，实际：" + out);
});

test("打开后：信号命中出提示，同一会话第二次被节流", async () => {
  const { contexts } = await load({ hint: { enabled: true } });
  const hint = contexts.find((c) => c.name === "mcp-hub:jit-hint");
  const agent = agentWith("s-on", ["push libil2cpp.so 然后 adb logcat 看日志"]);
  const first = hint.text({ agent });
  assert.ok(first.includes("mcp_hub_tools"), "提示要指回检索入口：" + first);
  assert.ok(first.includes("mobile"), "提示要指名服务器：" + first);
  const second = hint.text({ agent });
  assert.equal(second, "", "同会话同一台服务器只提示一次");
});

test("also / so that 这类英文短语不能触发（so 只认文件扩展名）", async () => {
  const { contexts } = await load({ hint: { enabled: true } });
  const hint = contexts.find((c) => c.name === "mcp-hub:jit-hint");
  const out = hint.text({ agent: agentWith("s-also", ["also so that we can proceed with the plan"]) });
  assert.equal(out, "", "单词 so 不是信号，实际：" + out);
});

test("运行时上下文快照不能被当成信号读回来（否则提示会自我续命）", async () => {
  const { contexts } = await load({ hint: { enabled: true } });
  const hint = contexts.find((c) => c.name === "mcp-hub:jit-hint");
  // 只喂一条 runtime-context 事件：它的正文里写着 adb / .so。
  // 上一轮提示自己就是这么写进上下文的，读了它等于自己喂自己。
  const agent = {
    session: {
      id: "s-self",
      snapshotEvents: () => [{
        seq: 0,
        type: "user/message",
        data: { source: { kind: "runtime-context" }, content: [{ type: "text", text: "当前运行时上下文：adb logcat libil2cpp.so" }] }
      }]
    }
  };
  assert.equal(hint.text({ agent }), "", "上一轮自己的提示不能成为下一轮的信号");
});

test("提示在会话之间隔离：A 会话用掉的额度不影响 B 会话", async () => {
  const { contexts } = await load({ hint: { enabled: true } });
  const hint = contexts.find((c) => c.name === "mcp-hub:jit-hint");
  const a = agentWith("sess-a", ["adb logcat"]);
  const b = agentWith("sess-b", ["adb logcat"]);
  assert.ok(hint.text({ agent: a }).length > 0, "A 会话应出提示");
  assert.equal(hint.text({ agent: a }), "", "A 会话随后被节流");
  assert.ok(hint.text({ agent: b }).length > 0, "B 会话不该受 A 影响");
});
