// 能力摘要：签名、通用词剔除、渲染确定性、缓存回落。
//
// 这组测试对应的是几条「错了也不会报错」的失效模式，所以每条断言都
// 指向一个具体的现场后果，而不是泛泛的覆盖：
//   · 签名不稳 → 每次重连都重建并写盘，缓存等于没有；
//   · 通用词没剔干净 → 摘要变成「工具·返回·服务器·列表」，一行废话；
//   · 渲染不确定 → 系统提示词前缀每轮都变，KV 缓存全部失效；
//   · 缓存坏就抛错 → 启动路径炸掉，用户看到的是「MCP 面板打不开」。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INDEX_VERSION,
  buildCapabilityIndex,
  loadOrBuildIndex,
  signatureOf,
  summaryText
} from "./capability-index.js";

// 真实工具名与真实描述。mobile 的那批名字实测取自本机 MCP，
// 不是编出来的——摘要算法要是在真实语料上都挑不出「截图」「崩溃」，
// 在别的地方也不会。
function mobileServer() {
  return {
    server: "mobile",
    tools: [
      { name: "mobile_get_crash", description: "Get the full content of a crash report by its ID.", parameters: { type: "object", properties: { crashId: { type: "string" } } } },
      { name: "mobile_list_crashes", description: "List crash reports available on the device.", parameters: { type: "object", properties: {} } },
      { name: "mobile_get_device_logs", description: "Collect live device logs (logcat on Android, unified log on iOS) as one JSON object per line." },
      { name: "mobile_take_screenshot", description: "Take a screenshot of the mobile device." },
      { name: "mobile_install_app", description: "Install an app on mobile device.", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "mobile_uninstall_app", description: "Uninstall an app from mobile device.", parameters: { type: "object", properties: { bundleId: { type: "string" } } } },
      { name: "mobile_click_on_screen_at_coordinates", description: "Click on the screen, either at x,y coordinates or on an element by its ref.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } } },
      { name: "mobile_swipe_on_screen", description: "Swipe on the screen" },
      { name: "mobile_type_keys", description: "Type text into the focused element", parameters: { type: "object", properties: { text: { type: "string" } } } },
      { name: "mobile_list_elements_on_screen", description: "List elements on screen with their ref, coordinates, and display text." },
      { name: "mobile_launch_app", description: "Launch an app on mobile device." },
      { name: "mobile_clipboard", description: "Read or replace the device clipboard." }
    ]
  };
}

function reaServer() {
  return {
    server: "rea",
    tools: [
      { name: "open_binary", description: "Open a native binary for inspection.", parameters: { type: "object", properties: { path: { type: "string" } } } },
      { name: "disassemble_function", description: "Disassemble one function into pseudo code.", parameters: { type: "object", properties: { address: { type: "string" }, symbol: { type: "string" } } } },
      { name: "list_symbols", description: "List symbols exported by the binary.", parameters: { type: "object", properties: { filter: { type: "string" } } } },
      { name: "resolve_containing_procedure", description: "Resolve which procedure contains an address.", parameters: { type: "object", properties: { address: { type: "string" } } } },
      { name: "compare_source_to_bundle", description: "Compare a source tree against the shipped bundle to see what changed." }
    ]
  };
}

function windowsServer() {
  return {
    server: "windows",
    tools: [
      { name: "Screenshot", description: "Take a screenshot of the desktop." },
      { name: "FileSystem", description: "Read and write files.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
      { name: "Click", description: "Click at screen coordinates.", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } } },
      { name: "Type", description: "Type text into the focused window.", parameters: { type: "object", properties: { text: { type: "string" } } } }
    ]
  };
}

function openchatcutServer() {
  return {
    server: "openchatcut",
    tools: [
      { name: "open_project", description: "Open an existing video editing project.", parameters: { type: "object", properties: { projectPath: { type: "string" } } } },
      { name: "add_clip_to_timeline", description: "Add a video clip onto the timeline.", parameters: { type: "object", properties: { clipPath: { type: "string" }, track: { type: "number" } } } },
      { name: "render_preview", description: "Render a low resolution preview of the timeline." },
      { name: "export_video", description: "Export the finished video to a file.", parameters: { type: "object", properties: { outputPath: { type: "string" } } } }
    ]
  };
}

function realServers() {
  return [mobileServer(), reaServer(), windowsServer(), openchatcutServer()];
}

function featuresOf(index, server) {
  const row = index.servers.find((s) => s.server === server);
  return row ? row.features : [];
}

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-hub-capability-"));
  return fn(dir);
}

// ── 签名 ─────────────────────────────────────────────────────

test("签名稳定：同一份输入两次算出同一个 hash", () => {
  const a = signatureOf(realServers());
  const b = signatureOf(realServers());
  assert.equal(a, b);
});

test("签名与服务器顺序无关", () => {
  const forward = signatureOf(realServers());
  const reversed = signatureOf(realServers().reverse());
  assert.equal(forward, reversed, "顺序变化不该触发重建，否则每次重连都要重算");
});

test("签名与服务器返回工具的顺序无关", () => {
  const s1 = mobileServer();
  const s2 = mobileServer();
  s2.tools.reverse();
  assert.equal(signatureOf([s1]), signatureOf([s2]));
});

test("签名与参数对象的键序无关", () => {
  const a = {
    server: "s",
    tools: [{ name: "t", description: "d", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } } }]
  };
  const b = {
    server: "s",
    tools: [{ name: "t", description: "d", parameters: { properties: { y: { type: "number" }, x: { type: "number" } }, type: "object" } }]
  };
  assert.equal(signatureOf([a]), signatureOf([b]));
});

test("签名对新增工具敏感", () => {
  const before = signatureOf([mobileServer()]);
  const after = mobileServer();
  after.tools.push({ name: "mobile_new_thing", description: "Brand new capability." });
  assert.notEqual(before, signatureOf([after]), "工具变了索引必须重建，否则摘要描述的是上一版能力");
});

test("签名对描述变化敏感", () => {
  const before = signatureOf([mobileServer()]);
  const after = mobileServer();
  after.tools[0].description = "Get the full content of a crash report by its ID, or nothing.";
  assert.notEqual(before, signatureOf([after]));
});

test("签名对参数变化敏感", () => {
  const before = signatureOf([mobileServer()]);
  const after = mobileServer();
  after.tools[4].parameters = { type: "object", properties: { path: { type: "string" }, flags: { type: "array" } } };
  assert.notEqual(before, signatureOf([after]));
});

test("签名对空输入不抛错", () => {
  assert.equal(typeof signatureOf([]), "string");
  assert.equal(typeof signatureOf(undefined), "string");
});

// ── 索引结构与特征 ────────────────────────────────────────────

test("索引形状符合约定", () => {
  const index = buildCapabilityIndex(realServers(), { now: 1234 });
  assert.equal(index.version, INDEX_VERSION);
  assert.equal(typeof index.signature, "string");
  assert.equal(index.builtAt, 1234, "now 可注入，测试要能锁住 builtAt");
  assert.equal(index.servers.length, 4);
  for (const row of index.servers) {
    assert.equal(typeof row.server, "string");
    assert.equal(typeof row.toolCount, "number");
    assert.ok(Array.isArray(row.features));
    assert.ok(Array.isArray(row.triggers));
    assert.ok(row.features.length > 0, row.server + " 应该挑得出特征词");
    assert.ok(row.features.length <= 8, row.server + " 特征词不该超过 8 个");
  }
});

test("特征词能反映真实能力：mobile 挑出截图/崩溃/日志这一类", () => {
  const index = buildCapabilityIndex(realServers());
  const features = featuresOf(index, "mobile").join(" ");
  // 不锁具体顺序（那会变成对算法的快照测试），只要求这些能力确实在场。
  assert.ok(/截图|崩溃|日志|剪贴板/.test(features), "mobile 的特征里应出现真实能力词，实际：" + features);
});

test("特征词能反映真实能力：rea 挑出二进制/反汇编/符号这一类", () => {
  const index = buildCapabilityIndex(realServers());
  const features = featuresOf(index, "rea").join(" ");
  assert.ok(/二进制|符号|反汇编|函数/.test(features), "rea 的特征里应出现逆向能力词，实际：" + features);
});

test("两台能力不同的服务器不会长出同一行摘要", () => {
  const index = buildCapabilityIndex(realServers());
  const mobile = featuresOf(index, "mobile").join("·");
  const rea = featuresOf(index, "rea").join("·");
  assert.notEqual(mobile, rea, "摘要雷同就失去了「告诉模型该调哪台」的意义");
});

test("工具数如实反映", () => {
  const index = buildCapabilityIndex(realServers());
  for (const s of realServers()) {
    const row = index.servers.find((x) => x.server === s.server);
    assert.equal(row.toolCount, s.tools.length);
  }
});

// ── 通用词剔除 ───────────────────────────────────────────────

test("通用词剔除：所有 server 都有的词不得进特征", () => {
  // 造三台 server，语料里都塞进 get / list / return / tool 这类词。
  // 它们是「任何一台服务器都会说的话」，留下就是每行都带一句废话。
  const mk = (name, extra) => ({
    server: name,
    tools: [
      { name: name + "_get_thing", description: "Get the thing and return a tool result. List of items." },
      { name: name + "_list_things", description: "List things. Return the tool result." },
      { name: name + "_run_job", description: "Run a job and return the tool result. " + extra }
    ]
  });
  const index = buildCapabilityIndex([mk("alpha", "Alpha specializes in encryption."), mk("beta", "Beta specializes in rendering."), mk("gamma", "Gamma specializes in networking.")]);
  for (const row of index.servers) {
    for (const bad of ["get", "list", "run", "tool", "return", "thing"]) {
      assert.ok(!row.features.includes(bad), row.server + " 的特征里不该出现通用词 " + bad + "，实际：" + row.features.join("·"));
    }
  }
});

test("通用词剔除用的是覆盖率判据而不是固定黑名单", () => {
  // 只出现在 4 台里 1 台的词必须保留，哪怕它长得像通用词。
  // 如果实现写死了黑名单，这个断言会失败。
  const servers = [
    { server: "a", tools: [{ name: "a_probe", description: "Probe the quantum flux capacitor." }] },
    { server: "b", tools: [{ name: "b_probe", description: "Probe the ordinary flux gate." }] },
    { server: "c", tools: [{ name: "c_probe", description: "Probe the standard flux gate." }] },
    { server: "d", tools: [{ name: "d_probe", description: "Probe the baseline flux gate." }] }
  ];
  const index = buildCapabilityIndex(servers);
  const a = featuresOf(index, "a").join(" ");
  assert.ok(/quantum|capacitor/.test(a), "只在一台出现的能力词必须留下，实际：" + a);
});

test("单一 server 时不会把所有词都判成通用词", () => {
  // 覆盖率判据只在有对照时才成立。只有一台 server 时，
  // 每个词都「出现在 100% 的 server 里」，一刀切会把摘要清空。
  const index = buildCapabilityIndex([mobileServer()]);
  assert.ok(featuresOf(index, "mobile").length > 0, "单台服务器也必须能长出摘要");
});

// ── 触发词 ───────────────────────────────────────────────────

test("triggers 每个 server 给 3-8 个", () => {
  const index = buildCapabilityIndex(realServers());
  for (const row of index.servers) {
    assert.ok(row.triggers.length >= 3, row.server + " 的 triggers 太少（" + row.triggers.length + "），JIT 触发会够不着它");
    assert.ok(row.triggers.length <= 8, row.server + " 的 triggers 超过 8 个");
  }
});

test("triggers 收得到真信号词：mobile 有 logcat / crash / screenshot", () => {
  const index = buildCapabilityIndex(realServers());
  const t = featuresOf(index, "mobile") && index.servers.find((s) => s.server === "mobile").triggers;
  assert.ok(t.includes("logcat"), "实际：" + t.join(","));
  assert.ok(t.includes("crash"), "实际：" + t.join(","));
  assert.ok(t.includes("screenshot"), "实际：" + t.join(","));
});

test("triggers 不把 also 里的 so 当成共享库", () => {
  const index = buildCapabilityIndex([
    { server: "src", tools: [{ name: "src_read", description: "Read a file. This also works for archives." }] },
    { server: "other", tools: [{ name: "other_thing", description: "Something else entirely." }] }
  ]);
  const row = index.servers.find((s) => s.server === "src");
  assert.ok(!row.triggers.includes(".so"), "also 不是共享库，实际：" + row.triggers.join(","));
});

test("triggers 认 .so 扩展名形态", () => {
  const index = buildCapabilityIndex([
    { server: "bin", tools: [{ name: "open_binary", description: "Open libtarget.so for inspection." }] },
    { server: "other", tools: [{ name: "other_thing", description: "Something else entirely." }] }
  ]);
  const row = index.servers.find((s) => s.server === "bin");
  assert.ok(row.triggers.includes(".so"), "带点的扩展名要认成信号，实际：" + row.triggers.join(","));
});

// ── 渲染 ─────────────────────────────────────────────────────

test("渲染格式：服务器名（N 工具）：特征1·特征2", () => {
  const index = buildCapabilityIndex(realServers());
  const text = summaryText(index);
  const lines = text.split("\n");
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.match(line, /^\w+（\d+ 工具）：[^·]+(·[^·]+)*$/u, "不符合渲染约定：" + line);
  }
});

test("渲染确定性：同一份 index 两次调用逐字节一致", () => {
  const index = buildCapabilityIndex(realServers());
  const a = summaryText(index);
  const b = summaryText(index);
  assert.equal(a, b, "不稳定会让每一轮请求的提示词前缀都失效");
});

test("渲染确定性：两次独立构建后渲染仍逐字节一致（builtAt 固定）", () => {
  const a = summaryText(buildCapabilityIndex(realServers(), { now: 0 }));
  const b = summaryText(buildCapabilityIndex(realServers(), { now: 0 }));
  assert.equal(a, b);
});

test("渲染顺序按服务器名定序，与目录文本一致", () => {
  const index = buildCapabilityIndex(realServers());
  const names = summaryText(index).split("\n").map((l) => l.slice(0, l.indexOf("（")));
  assert.deepEqual(names, ["mobile", "openchatcut", "rea", "windows"]);
});

test("渲染即便乱序输入也按名字定序", () => {
  const index = buildCapabilityIndex(realServers());
  const shuffled = { ...index, servers: index.servers.slice().reverse() };
  assert.equal(summaryText(shuffled), summaryText(index), "渲染层不能依赖上游排好序");
});

test("超过 8 台服务器时压缩成分组摘要，不逐个列", () => {
  const many = [];
  for (let i = 0; i < 12; i += 1) {
    many.push({ server: "srv" + String(i).padStart(2, "0"), tools: [{ name: "srv" + i + "_capability", description: "Do capability number " + i }] });
  }
  const text = summaryText(buildCapabilityIndex(many));
  assert.ok(text.includes("12 台服务器"), "要报总数，实际：" + text);
  assert.ok(text.includes("mcp_hub_tools"), "要给一句检索指引");
  assert.ok(!text.includes("srv00（"), "12 台时不该再逐个列：" + text);
});

test("正好 8 台时仍然逐个列（边界）", () => {
  const eight = [];
  for (let i = 0; i < 8; i += 1) {
    eight.push({ server: "srv" + i, tools: [{ name: "srv" + i + "_capability", description: "Do capability number " + i }] });
  }
  const text = summaryText(buildCapabilityIndex(eight));
  assert.equal(text.split("\n").length, 8, "8 台是逐个列的上界，实际：" + text);
});

test("空索引渲染成空串，不抛错", () => {
  assert.equal(summaryText(buildCapabilityIndex([])), "");
  assert.equal(summaryText(undefined), "");
  assert.equal(summaryText({}), "");
});

test("特征不足时退到 triggers，不留悬空冒号", () => {
  const index = { servers: [{ server: "x", toolCount: 3, features: [], triggers: ["adb", "logcat"] }] };
  const text = summaryText(index);
  assert.equal(text, "x（3 工具）：adb·logcat", "应退到 triggers");
  // 两者都空时，冒号必须整个不出现——「x（3 工具）：」会被模型当成被截断。
  const bare = summaryText({ servers: [{ server: "y", toolCount: 3, features: [], triggers: [] }] });
  assert.equal(bare, "y（3 工具）");
  assert.ok(!bare.includes("："));
});

test("maxFeatures 可调，且不改变默认渲染", () => {
  const index = buildCapabilityIndex(realServers());
  const five = summaryText(index);
  const two = summaryText(index, { maxFeatures: 2 });
  for (const line of two.split("\n")) {
    const body = line.slice(line.indexOf("：") + 1);
    assert.ok(body.split("·").length <= 2, "maxFeatures=2 时应最多两个词：" + line);
  }
  assert.notEqual(five, two);
});

test("渲染体积可控：4 台服务器在 1200 字节内", () => {
  const text = summaryText(buildCapabilityIndex(realServers()));
  assert.ok(Buffer.byteLength(text) < 1200, "摘要应保持在一千字节量级，实际 " + Buffer.byteLength(text));
});

// ── 缓存 ─────────────────────────────────────────────────────

test("loadOrBuildIndex：未命中时建好并落盘", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "capability.json");
    const index = loadOrBuildIndex({ servers: realServers(), cacheFile, now: 7 });
    assert.equal(index.builtAt, 7);
    const onDisk = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.equal(onDisk.signature, index.signature);
    assert.equal(onDisk.version, INDEX_VERSION);
    assert.deepEqual(onDisk.servers, index.servers);
  });
});

test("loadOrBuildIndex：签名命中时直接读磁盘，不重建", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "capability.json");
    const first = loadOrBuildIndex({ servers: realServers(), cacheFile, now: 100 });
    // 第二次换一个 now：如果它返回了 200，说明重建了而不是读盘。
    const second = loadOrBuildIndex({ servers: realServers(), cacheFile, now: 200 });
    assert.equal(second.builtAt, 100, "命中缓存时必须沿用磁盘上那份，builtAt 也要保持");
    assert.equal(second.signature, first.signature);
  });
});

test("loadOrBuildIndex：未命中时重建并覆盖", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "capability.json");
    loadOrBuildIndex({ servers: realServers(), cacheFile, now: 1 });
    const changed = realServers();
    changed[0].tools.push({ name: "mobile_new_thing", description: "Brand new capability for testing." });
    const second = loadOrBuildIndex({ servers: changed, cacheFile, now: 2 });
    assert.equal(second.builtAt, 2);
    const onDisk = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.equal(onDisk.signature, second.signature);
  });
});

test("loadOrBuildIndex：坏 JSON 回落到重算，不抛错", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "capability.json");
    writeFileSync(cacheFile, "{ this is not json", "utf8");
    const index = loadOrBuildIndex({ servers: realServers(), cacheFile, now: 5 });
    assert.equal(index.builtAt, 5, "坏缓存必须重算");
    assert.deepEqual(index.servers, buildCapabilityIndex(realServers(), { now: 5 }).servers);
  });
});

test("loadOrBuildIndex：版本不符回落到重算", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "capability.json");
    const stale = buildCapabilityIndex(realServers(), { now: 1 });
    stale.version = INDEX_VERSION + 1;
    writeFileSync(cacheFile, JSON.stringify(stale), "utf8");
    const index = loadOrBuildIndex({ servers: realServers(), cacheFile, now: 9 });
    assert.equal(index.builtAt, 9, "版本不符必须重算，否则旧算法结果会被当成新结果");
    assert.equal(index.version, INDEX_VERSION);
  });
});

test("loadOrBuildIndex：字段残缺的索引回落到重算", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "capability.json");
    // 写盘进程被 kill 在 rename 之前会留下这种「能 parse 但不可用」的 JSON。
    writeFileSync(cacheFile, JSON.stringify({ version: INDEX_VERSION, signature: "x", servers: [{ server: "mobile" }] }), "utf8");
    const index = loadOrBuildIndex({ servers: realServers(), cacheFile, now: 3 });
    assert.equal(index.builtAt, 3);
    assert.ok(index.servers[0].features.length > 0);
  });
});

test("loadOrBuildIndex：缓存目录不可写时不抛错，仍返回内存结果", async () => {
  await withTmpDir((dir) => {
    // 把缓存路径指到一个「父级是文件」的位置，mkdir 必失败。
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const cacheFile = join(blocker, "sub", "capability.json");
    const index = loadOrBuildIndex({ servers: realServers(), cacheFile, now: 11 });
    assert.equal(index.builtAt, 11, "写盘失败只影响下次启动，这一次照样能用");
    assert.ok(index.servers.length === 4);
  });
});

test("loadOrBuildIndex：cacheFile 缺省时纯内存运行", () => {
  const index = loadOrBuildIndex({ servers: realServers(), now: 42 });
  assert.equal(index.builtAt, 42);
  assert.equal(index.servers.length, 4);
});

test("loadOrBuildIndex：没有 servers 时用磁盘旧索引兜底（启动早期）", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "capability.json");
    const built = loadOrBuildIndex({ servers: realServers(), cacheFile, now: 1 });
    // 启动早期工具还没连上：这次调用没有 servers，但摘要不能是空的。
    const early = loadOrBuildIndex({ cacheFile });
    assert.equal(early.signature, built.signature, "旧索引能用就不阻塞启动");
    assert.equal(summaryText(early), summaryText(built));
  });
});

test("loadOrBuildIndex：没有 servers 也没有缓存时返回空索引，不抛错", () => {
  const index = loadOrBuildIndex({ cacheFile: join(tmpdir(), "definitely-not-here-" + Date.now() + ".json") });
  assert.deepEqual(index.servers, []);
  assert.equal(summaryText(index), "");
});

test("loadOrBuildIndex：空服务器列表不覆盖已有缓存", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "capability.json");
    const built = loadOrBuildIndex({ servers: realServers(), cacheFile, now: 1 });
    loadOrBuildIndex({ servers: [], cacheFile, now: 2 });
    const onDisk = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.equal(onDisk.signature, built.signature, "启动早期「一台都没连上」不该把好索引冲掉");
  });
});

test("loadOrBuildIndex：force 忽略命中缓存", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "capability.json");
    loadOrBuildIndex({ servers: realServers(), cacheFile, now: 1 });
    const forced = loadOrBuildIndex({ servers: realServers(), cacheFile, now: 2, force: true });
    assert.equal(forced.builtAt, 2);
  });
});

test("loadOrBuildIndex：写盘后不留临时文件", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "capability.json");
    loadOrBuildIndex({ servers: realServers(), cacheFile, now: 1 });
    assert.throws(() => readFileSync(cacheFile + ".tmp", "utf8"), "临时文件应已 rename 掉");
    assert.ok(readFileSync(cacheFile, "utf8").length > 0);
  });
});

test("loadOrBuildIndex：缓存目录不存在时自动创建", async () => {
  await withTmpDir((dir) => {
    const cacheFile = join(dir, "nested", "deeper", "capability.json");
    loadOrBuildIndex({ servers: realServers(), cacheFile, now: 1 });
    assert.ok(readFileSync(cacheFile, "utf8").length > 0, "父目录应被递归创建");
  });
});
