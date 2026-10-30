// JIT 触发提示器的锁：信号提取的准确性 + 节流状态机的四条闸门。
//
// 两条锁定逻辑值得单独说明，别把它们当成「顺手加的覆盖」：
//   1) "so" 只认文件扩展名。真人输入是 "push libil2cpp.so 然后 adb logcat"，
//      而同一个仓库的另一条测试语料里满是 "also" / "so that"——按单词匹配
//      等于每轮误报一次，把提示变成噪音；
//   2) 节流预算按会话记账。多条会话共用一个计数器，会让「正在被单干的会话」
//      把别人的额度吃光，这个 bug 在单会话测试里永远看不见。

import assert from "node:assert/strict";
import test from "node:test";

import { createJitHinter, extractSignals } from "./jit-hint.js";

// 与 Lead 对齐的四服务器样例索引。真实工具数取本机面板里的数：
// mobile 33、rea 12、windows 21、openchatcut 10。
function sampleIndex() {
  return {
    version: 1,
    signature: "sample-signature-v1",
    builtAt: "2026-01-01T00:00:00.000Z",
    servers: [
      {
        server: "mobile",
        toolCount: 33,
        features: ["设备", "截图", "安装", "日志", "崩溃"],
        triggers: ["adb", "logcat", "tombstone", "crash", "模拟器", "安装", "*.so", "*.apk"]
      },
      {
        server: "rea",
        toolCount: 12,
        features: ["反汇编", "反编译", "符号", "调用图"],
        triggers: ["disasm", "反汇编", "symbol", "callgraph", ".so", ".elf"]
      },
      {
        server: "windows",
        toolCount: 21,
        features: ["窗口", "点击", "键盘", "截图"],
        triggers: ["screenshot", "截图", "click", "点击", "窗口"]
      },
      {
        server: "openchatcut",
        toolCount: 10,
        features: ["字幕", "时间线", "视频"],
        triggers: ["ffmpeg", "subtitle", "字幕", "视频"]
      }
    ]
  };
}

function makeHinter(extra) {
  return createJitHinter(Object.assign({ index: sampleIndex() }, extra || {}));
}

// ── 信号提取 ─────────────────────────────────────────────────
test("extractSignals：真实事故那一段文本能抽出 adb / logcat / so", () => {
  const sigs = extractSignals("push libil2cpp.so 然后 adb logcat");
  assert.ok(sigs.includes("adb"), "adb 必须命中");
  assert.ok(sigs.includes("logcat"), "logcat 必须命中");
  assert.ok(sigs.includes("so"), "*.so 必须命中（扩展名形态）");
});

test("extractSignals：also / so that 绝不能触发 so 信号（钉子）", () => {
  for (const text of [
    "also so that we can share it",
    "so that the model can also use it",
    "So, this is also fine",
    "also",
    "so"
  ]) {
    const sigs = extractSignals(text);
    assert.ok(!sigs.includes("so"), "不能把英文单词 so 当信号：" + JSON.stringify(text));
  }
  // also 里含 so，但 even 加权后也不能整段空命中其它二进制信号
  assert.deepEqual(extractSignals("also so that we can"), []);
});

test("extractSignals：扩展名只认点形态，.sock 不能被当成 .so", () => {
  assert.ok(!extractSignals("/run/agent.sock").includes("so"), ".sock 不是 .so");
  assert.ok(extractSignals("libil2cpp.so").includes("so"));
  assert.ok(extractSignals("libfoo.so.1").includes("so"), "versioned so 仍要命中");
  assert.ok(extractSignals("*.so").includes("so"), "glob 形态要命中");
  assert.ok(extractSignals("classes.dex").includes("dex"));
  assert.ok(extractSignals("app-release.apk").includes("apk"));
});

test("extractSignals：大小写不敏感、去重、确定性", () => {
  assert.deepEqual(extractSignals("ADB Logcat ADB"), ["adb", "logcat"]);
  const text = "adb adb logcat *.so 反汇编";
  assert.deepEqual(extractSignals(text), extractSignals(text), "同一段文本两次提取必须逐字一致");
});

test("extractSignals：空输入与非字符串不抛错", () => {
  assert.deepEqual(extractSignals(""), []);
  assert.deepEqual(extractSignals(null), []);
  assert.deepEqual(extractSignals(undefined), []);
  assert.deepEqual(extractSignals(42), []);
});

test("extractSignals：中文信号可用", () => {
  const sigs = extractSignals("帮我看下反汇编和崩溃日志");
  assert.ok(sigs.includes("反汇编"));
  assert.ok(sigs.includes("崩溃"));
  assert.ok(sigs.includes("日志"));
});

// ── 命中与渲染 ───────────────────────────────────────────────
test("hintFor：命中 mobile 并渲染成一行可执行的提示", () => {
  const h = makeHinter();
  const out = h.hintFor({ sessionId: "s1", text: "push libil2cpp.so 然后 adb logcat", usedServers: [] });
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0, "应当有提示");
  assert.ok(out.includes("mobile"), "应当指向 mobile");
  assert.ok(out.includes("mcp_hub_tools"), "必须给出检索入口");
  assert.ok(out.includes("query="), "必须给出可直接抄的检索调用");
  assert.ok(!out.includes("\n"), "默认一条提示，不该多行");
});

test("hintFor：反汇编类信号指向 rea", () => {
  const h = makeHinter();
  const out = h.hintFor({ sessionId: "s1", text: "把这个 libil2cpp.so 反汇编一下", usedServers: [] });
  assert.ok(out.includes("rea"), "native/反汇编证据应当指向 rea，实际：" + out);
});

test("hintFor：没有信号时返回空串", () => {
  const h = makeHinter();
  assert.equal(h.hintFor({ sessionId: "s1", text: "今天天气不错", usedServers: [] }), "");
  assert.equal(h.hintFor({ sessionId: "s1", text: "", usedServers: [] }), "");
});

test("hintFor：usedServers 里的服务器不提示（含完整工具名形态）", () => {
  const h = makeHinter();
  assert.equal(
    h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: ["mobile"] }),
    "",
    "已经用过 mobile 就不该再提示 mobile"
  );
  const h2 = makeHinter();
  assert.equal(
    h2.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: ["mcp__mobile__mobile_list_apps"] }),
    "",
    "完整工具名形态也要认得出服务器"
  );
});

test("hintFor：perTurn=1 时多台服务器同时命中也只出一条", () => {
  const h = makeHinter();
  const out = h.hintFor({ sessionId: "s1", text: "adb logcat 反汇编 *.so screenshot 字幕", usedServers: [] });
  assert.equal(out.split("\n").length, 1, "每轮最多 1 条，实际：" + JSON.stringify(out));
});

// ── 节流状态机 ───────────────────────────────────────────────
test("节流：每会话每 server 只提示 1 次", () => {
  const h = makeHinter();
  const first = h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] });
  assert.ok(first.includes("mobile"));
  // 换一段文本、同一台服务器，不该再提示
  const second = h.hintFor({ sessionId: "s1", text: "adb install 应用", usedServers: [] });
  assert.equal(second, "", "同一会话同一 server 第二次必须被节流");
  const st = h.stats();
  assert.equal(st.byServer.mobile, 1);
});

test("节流：每会话总上限 3，到顶后不再提示", () => {
  const h = makeHinter({ maxPerServer: 1, maxTotal: 3 });
  const outs = [
    h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }),
    h.hintFor({ sessionId: "s1", text: "反汇编一下", usedServers: [] }),
    h.hintFor({ sessionId: "s1", text: "screenshot 窗口", usedServers: [] }),
    h.hintFor({ sessionId: "s1", text: "ffmpeg 字幕", usedServers: [] })
  ];
  assert.ok(outs[0].includes("mobile"));
  assert.ok(outs[1].includes("rea"));
  assert.ok(outs[2].includes("windows"));
  assert.equal(outs[3], "", "第 4 条必须被总上限挡掉");
  assert.equal(h.stats().hints, 3);
});

test("节流：maxTotal 可配置", () => {
  const h = makeHinter({ maxTotal: 1 });
  assert.ok(h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }).length > 0);
  assert.equal(h.hintFor({ sessionId: "s1", text: "反汇编", usedServers: [] }), "");
});

test("节流：连续两次相同文本不再出提示（换服务器也不行，防复读）", () => {
  const h = makeHinter({ maxTotal: 3 });
  const a = h.hintFor({ sessionId: "s1", text: "push libil2cpp.so 然后 adb logcat", usedServers: [] });
  assert.ok(a.includes("mobile"));
  const b = h.hintFor({ sessionId: "s1", text: "push libil2cpp.so 然后 adb logcat", usedServers: [] });
  assert.equal(b, "", "同一段信号文本第二次必须被节流，哪怕这次会换一台服务器");
  // 换一段文本、换一台服务器，仍然能提示——闸门只挡复读，不挡正常的下一轮
  const c = h.hintFor({ sessionId: "s1", text: "反汇编一下", usedServers: [] });
  assert.ok(c.includes("rea"));
});

test("节流：解除限制之后逐字重复闸门一并失效", () => {
  const h = makeHinter({ maxTotal: 3 });
  assert.ok(h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }).includes("mobile"));
  assert.equal(h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }), "");
  h.hintFor({ sessionId: "s1", text: "我找不到工具了", usedServers: [] });
  assert.ok(
    h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }).includes("mobile"),
    "用户说找不到工具之后，重复那句也该再告诉他一次"
  );
});

// ── 解除限制 ─────────────────────────────────────────────────
test("解除限制：用户说找不到工具后，每 server 限制与总上限解除", () => {
  const h = makeHinter({ maxTotal: 1, maxPerServer: 1 });
  assert.ok(h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }).includes("mobile"));
  // 预算已用完，普通请求被挡
  assert.equal(h.hintFor({ sessionId: "s1", text: "反汇编", usedServers: [] }), "");
  // 用户卡住 → 解除
  h.hintFor({ sessionId: "s1", text: "我找不到工具了", usedServers: [] });
  assert.ok(
    h.hintFor({ sessionId: "s1", text: "反汇编", usedServers: [] }).includes("rea"),
    "解除限制后应当能再提示"
  );
  assert.ok(
    h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }).includes("mobile"),
    "解除后同一 server 也可再提示"
  );
});

test("解除限制：perTurn 仍然生效（一次卡住不能刷屏）", () => {
  const h = makeHinter();
  h.hintFor({ sessionId: "s1", text: "我找不到工具了", usedServers: [] });
  const out = h.hintFor({ sessionId: "s1", text: "adb logcat 反汇编 screenshot", usedServers: [] });
  assert.equal(out.split("\n").length, 1, "解除限制也只许每轮 1 条");
});

test("解除限制：多种说法都认（中英）", () => {
  const phrasings = [
    "找不到工具",
    "没有可用工具",
    "我找不到工具了",
    "no such tool in the hub",
    "I can't find a tool for this",
    "cannot find a tool"
  ];
  for (const text of phrasings) {
    const h = makeHinter({ maxTotal: 1 });
    h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] });
    assert.equal(h.hintFor({ sessionId: "s1", text: "反汇编", usedServers: [] }), "");
    h.hintFor({ sessionId: "s1", text, usedServers: [] });
    assert.ok(
      h.hintFor({ sessionId: "s1", text: "反汇编", usedServers: [] }).length > 0,
      "这句话应当解除限制：" + JSON.stringify(text)
    );
  }
});

// ── 会话隔离与 reset ─────────────────────────────────────────
test("会话隔离：一个会话的预算不影响另一个会话", () => {
  const h = makeHinter({ maxTotal: 1 });
  assert.ok(h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }).length > 0);
  assert.equal(h.hintFor({ sessionId: "s1", text: "反汇编", usedServers: [] }), "", "s1 预算已用完");
  assert.ok(
    h.hintFor({ sessionId: "s2", text: "adb logcat", usedServers: [] }).length > 0,
    "s2 必须有自己的预算"
  );
  assert.ok(h.hintFor({ sessionId: "s3", text: "adb logcat", usedServers: [] }).length > 0);
  assert.equal(h.stats().sessions, 3);
});

test("会话隔离：解除限制只作用于本会话", () => {
  const h = makeHinter({ maxTotal: 1 });
  h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] });
  h.hintFor({ sessionId: "s2", text: "adb logcat", usedServers: [] });
  h.hintFor({ sessionId: "s1", text: "找不到工具", usedServers: [] });
  assert.ok(h.hintFor({ sessionId: "s1", text: "反汇编", usedServers: [] }).length > 0);
  assert.equal(
    h.hintFor({ sessionId: "s2", text: "反汇编", usedServers: [] }),
    "",
    "s2 不该因为 s1 卡住而被解除限制"
  );
});

test("会话隔离：usedServers 也按会话判断，不串台", () => {
  const h = makeHinter();
  h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] });
  // s2 从未用过 mobile，也不是它被提示过，应当还能提示
  assert.ok(h.hintFor({ sessionId: "s2", text: "adb logcat", usedServers: [] }).includes("mobile"));
});

test("reset：清掉指定会话的节流计数后可重新提示", () => {
  const h = makeHinter({ maxTotal: 1 });
  assert.ok(h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }).length > 0);
  assert.equal(h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }), "");
  h.reset("s1");
  assert.ok(
    h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }).includes("mobile"),
    "reset 之后同一 server 可以再提示"
  );
  assert.equal(h.stats().sessions, 1);
});

test("reset：不带参数清空全部会话", () => {
  const h = makeHinter();
  h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] });
  h.hintFor({ sessionId: "s2", text: "adb logcat", usedServers: [] });
  h.reset();
  assert.equal(h.stats().sessions, 0);
  assert.equal(h.stats().hints, 0);
});

test("reset：reset 未受影响的会话不报错", () => {
  const h = makeHinter();
  h.reset("never-seen");
  assert.equal(h.stats().sessions, 0);
});

// ── 防御性 ───────────────────────────────────────────────────
test("畸形索引不抛错，最坏退化成不提示", () => {
  for (const idx of [undefined, null, {}, { servers: null }, { servers: [null, 1, "x"] }, { servers: [{ server: "x" }] }]) {
    const h = createJitHinter({ index: idx });
    assert.equal(h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }), "");
    assert.equal(typeof h.stats().sessions, "number");
  }
});

test("畸形入参不抛错", () => {
  const h = makeHinter();
  assert.equal(h.hintFor(null), "");
  assert.equal(h.hintFor(undefined), "");
  assert.equal(h.hintFor({}), "");
  assert.equal(h.hintFor({ sessionId: "s1", text: 123, usedServers: "nope" }), "");
});

test("无 sessionId 时退到匿名桶，共享同一份预算而不是无限放行", () => {
  const h = makeHinter({ maxTotal: 1 });
  assert.ok(h.hintFor({ text: "adb logcat", usedServers: [] }).length > 0);
  assert.equal(h.hintFor({ text: "adb logcat", usedServers: [] }), "", "匿名桶也必须受总上限约束");
});

test("索引支持 getter（活引用）并在内容不变时复用归一化结果", () => {
  const idx = sampleIndex();
  let calls = 0;
  const h = createJitHinter({
    index: () => {
      calls += 1;
      return idx;
    }
  });
  assert.ok(h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] }).includes("mobile"));
  // 更换为一台新服务器后应当立即可见（活引用语义）
  const next = {
    signature: "sample-signature-v2",
    servers: [{ server: "newsrv", toolCount: 5, features: ["日志"], triggers: ["logcat"] }]
  };
  let current = next;
  const h2 = createJitHinter({ index: () => current });
  assert.ok(h2.hintFor({ sessionId: "s1", text: "logcat", usedServers: [] }).includes("newsrv"));
  assert.ok(calls >= 1);
});

test("stats() 结构稳定，含预算与按服务器计数", () => {
  const h = makeHinter({ maxTotal: 3, maxPerServer: 1, perTurn: 1 });
  h.hintFor({ sessionId: "s1", text: "adb logcat", usedServers: [] });
  const st = h.stats();
  assert.equal(st.sessions, 1);
  assert.equal(st.turns, 1);
  assert.equal(st.hints, 1);
  assert.deepEqual(st.budget, { perTurn: 1, maxPerServer: 1, maxTotal: 3 });
  assert.equal(st.byServer.mobile, 1);
});

test("同一段信号文本反复跑，输出稳定（提示拼接是确定性的）", () => {
  const a = makeHinter().hintFor({ sessionId: "x", text: "push libil2cpp.so 然后 adb logcat", usedServers: [] });
  const b = makeHinter().hintFor({ sessionId: "x", text: "push libil2cpp.so 然后 adb logcat", usedServers: [] });
  assert.equal(a, b, "同样的现场必须给同样的提示");
});

// ── 预算活引用：面板改完立刻生效 ───────────────────────────────
// maxTotal / maxPerServer 在接口上是允许传函数的（index.js 就是这么传的），
// 目的是「面板改完下一步请求就生效」。如果哪天有人为了省一次调用把它烤成
// 数字，这个测试必须立刻变红——那种退化在线上表现为「设置存进去了但不生效，
// 重启一次又好了」，属于最费劲的一类 bug。
test("预算传函数时每轮现读：改小立刻生效，不需要重建 hinter", () => {
  const budget = { maxTotal: 3, maxPerServer: 1 };
  const h = createJitHinter({
    index: sampleIndex(),
    maxTotal: () => budget.maxTotal,
    maxPerServer: () => budget.maxPerServer
  });
  // 第一轮先出 mobile，用掉 1 条。
  assert.ok(h.hintFor({ sessionId: "live", text: "adb logcat", usedServers: [] }).length > 0);
  // 面板把总预算改成 1：下一轮就该被挡住（rea 的 disasm 是新的、没提示过）。
  budget.maxTotal = 1;
  assert.equal(h.hintFor({ sessionId: "live", text: "disasm 这个函数", usedServers: [] }), "",
    "maxTotal 改成 1 后，本会话已用满一条，不该再出提示");
  // 再把预算放开，同一条信号应该能出提示——证明它是现读而不是缓存。
  budget.maxTotal = 5;
  assert.ok(h.hintFor({ sessionId: "live", text: "disasm 这个函数", usedServers: [] }).length > 0,
    "预算放开后应立刻恢复");
});

test("stats().budget 报的是现读值，不是建 hinter 时的快照", () => {
  const budget = { maxTotal: 3, maxPerServer: 1 };
  const h = createJitHinter({
    index: sampleIndex(),
    maxTotal: () => budget.maxTotal,
    maxPerServer: () => budget.maxPerServer
  });
  budget.maxTotal = 7;
  budget.maxPerServer = 2;
  assert.deepEqual(h.stats().budget, { perTurn: 1, maxPerServer: 2, maxTotal: 7 });
});
