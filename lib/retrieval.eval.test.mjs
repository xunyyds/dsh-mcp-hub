// 检索内核的离线评测门禁：recall@3。
//
// 这个文件的职责只有一个——让「中文搜不到工具」这类退步在某次改打分时立刻变红，
// 而不是等用户报障。为什么单独落一个离线评测，而不是在 gateway 测试里顺手加几条：
// gateway 的测试断言的是「返回体形状对不对」，它对排序质量是不敏的。旧实现
// 29 条用例全绿、线上中文全瞎，正是因为没有一个测试在测**排序质量**。
//
// 门禁取 recall@3 而不是 recall@1：第一名该是谁在存在多个合理候选时（手机上截图
// vs 桌面上截图、截屏 vs 保存截图）本来就有争议，锁名次会在无害抖动上乱红；
// top-3 锁住的才是真正要紧的东西——模型看得见正确的那个工具。
//
// 失败时逐条打印 miss，包含「期望工具的实际名次」与「实际 top-3 是谁」：
// 只说「recall 掉了」等于把下一次排查又推给别人。

import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG, CORPUS, CORPUS_MAX, CORPUS_MIN } from "./retrieval.corpus.mjs";
import { rankEntries, tokenize } from "./context-budget.js";

const TOP_K = 3;

// 门禁阈值。0.8 不是拍脑袋：留出约两成的余量给「中文口语与英文工具名之间
// 本来就没有共同词」的硬样例（口语里的「卡死了」在工具名里没有任何对应词，
// 只能靠 崩溃→crash 与 栈→stack 两条桥接兜住）。低于 0.8 说明桥接表或分词
// 断了；把阈值抬到 1.0 则会逼着后来的人删掉真实但难的口语样例。
const MIN_RECALL = 0.8;

// 中文查询单独设一条更高的门禁，因为这次改造要修的就是它。
// 中文样例若和中英混杂的总体分数绑在一起，英文那半边的满分会把中文的
// 塌方稀释掉——旧实现就是被「英文全对」这种总分掩盖的。
const MIN_RECALL_CJK = 0.8;

function fullNameOf(item) {
  return "mcp__" + item.expectServer + "__" + item.expectTool;
}

function isCjk(text) {
  return /[\u4e00-\u9fff]/.test(text);
}

// 跑一遍语料，返回逐条结果。名次用全量排序算，这样 miss 的条目能报出
// 「差了多少」——名次 4 和名次 60 是两种完全不同的故障。
function evaluate(cases) {
  const results = [];
  for (const item of cases) {
    const expected = fullNameOf(item);
    const ranked = rankEntries(CATALOG, item.query, CATALOG.length);
    const at = ranked.findIndex((e) => e.name === expected);
    results.push({
      item,
      expected,
      rank: at < 0 ? -1 : at + 1,
      top: ranked.slice(0, TOP_K).map((e) => e.name),
      hit: at >= 0 && at < TOP_K
    });
  }
  return results;
}

function recallOf(results) {
  if (!results.length) return 0;
  return results.filter((r) => r.hit).length / results.length;
}

function reportOf(label, results) {
  const misses = results.filter((r) => !r.hit);
  if (!misses.length) return label + "：全部命中";
  const lines = misses.map((r) => {
    const where = r.rank < 0 ? "未出现（得分 0，词形完全对不上）" : `实际第 ${r.rank} 名`;
    return `  ✗ ${r.item.query}\n     期望 ${r.expected} → ${where}\n     实际 top3：${r.top.join("、") || "（空）"}`;
  });
  return `${label}：${misses.length} 条 miss\n${lines.join("\n")}`;
}

// ── 语料自身先要立得住 ──────────────────────────────────────
// 这几条在测「检索质量」之前先测「评测集有没有被悄悄削弱」：
// 删样例、把期望工具改成永远命不中的名字、语料里出现目录里不存在的工具，
// 都会让 recall 看起来漂亮而实际什么都没测到。
test("语料规模在 50-100 条之间，且中英各半", () => {
  assert.ok(CORPUS.length >= CORPUS_MIN, `语料太少了：${CORPUS.length} < ${CORPUS_MIN}`);
  assert.ok(CORPUS.length <= CORPUS_MAX, `语料太多了：${CORPUS.length} > ${CORPUS_MAX}`);
  const cjk = CORPUS.filter((c) => isCjk(c.query)).length;
  const latin = CORPUS.length - cjk;
  assert.ok(cjk >= 20, `中文样例太少：${cjk}`);
  assert.ok(latin >= 20, `英文样例太少：${latin}`);
  // 「中英各半」不要求严格相等，但不许一边压倒另一边。
  assert.ok(Math.min(cjk, latin) / Math.max(cjk, latin) >= 0.6, `中英样例失衡：${cjk} / ${latin}`);
});

test("每条语料都指向目录里真实存在的工具，且查询不重复", () => {
  const names = new Set(CATALOG.map((e) => e.name));
  for (const item of CORPUS) {
    const expected = fullNameOf(item);
    assert.ok(names.has(expected), `语料指向了目录里不存在的工具：${expected}（查询「${item.query}」）`);
  }
  const seen = new Set();
  for (const item of CORPUS) {
    assert.ok(!seen.has(item.query), `查询重复：${item.query}`);
    seen.add(item.query);
  }
});

// ── 门禁本体 ────────────────────────────────────────────────
test(`recall@${TOP_K} >= ${MIN_RECALL}（全语料）`, () => {
  const results = evaluate(CORPUS);
  const recall = recallOf(results);
  assert.ok(
    recall >= MIN_RECALL,
    `recall@${TOP_K} = ${recall.toFixed(3)}（${results.filter((r) => r.hit).length}/${results.length}），` +
      `低于门禁 ${MIN_RECALL}\n` + reportOf("miss 明细", results)
  );
  // 通过时也把数值打出来：这个数字要出现在交付报告里，不该只能靠失败才看得到。
  console.log(`    recall@${TOP_K} = ${recall.toFixed(3)}（${results.filter((r) => r.hit).length}/${results.length} 命中）`);
});

test(`中文查询 recall@${TOP_K} >= ${MIN_RECALL_CJK}`, () => {
  const results = evaluate(CORPUS.filter((c) => isCjk(c.query)));
  assert.ok(results.length > 0, "中文样例为空，这条门禁失去意义");
  const recall = recallOf(results);
  assert.ok(
    recall >= MIN_RECALL_CJK,
    `中文 recall@${TOP_K} = ${recall.toFixed(3)}，低于门禁 ${MIN_RECALL_CJK}\n` + reportOf("中文 miss 明细", results)
  );
  console.log(`    中文 recall@${TOP_K} = ${recall.toFixed(3)}（${results.filter((r) => r.hit).length}/${results.length} 命中）`);
});

// ── 分词与签名：向后兼容那几条 ──────────────────────────────
test("tokenize 仍返回字符串数组，且中文段能被切成 2-gram", () => {
  const terms = tokenize("反汇编 so 符号 调试");
  assert.ok(Array.isArray(terms), "tokenize 必须仍返回数组");
  assert.ok(terms.every((t) => typeof t === "string"), "数组元素必须仍是字符串");
  // 向后兼容的现场证据：旧实现只回 ["so"]，任何依赖英文词的调用方都靠它。
  // 英文词必须原样还在，否则改分词就等于把英文检索一起改坏。
  assert.ok(terms.includes("so"), "英文词不能因为改造而丢失：" + JSON.stringify(terms));
  // 中文侧：连续段必须产出 2-gram，而不是被当成分隔符整段丢掉。
  assert.ok(terms.includes("反汇"), "中文要切出 2-gram：" + JSON.stringify(terms));
  assert.ok(terms.includes("符号"), "中文要切出 2-gram：" + JSON.stringify(terms));
  assert.ok(terms.includes("崩溃") === false, "没出现的字不该凭空产出词");
  assert.deepEqual(tokenize(""), [], "空串给空数组，调用方不必先判空");
  assert.deepEqual(tokenize(undefined), [], "undefined 也不能抛");
});

test("rankEntries 签名不变：返回 entry 对象数组，limit 生效", () => {
  const all = rankEntries(CATALOG, "screenshot", CATALOG.length);
  assert.ok(all.length > 0, "英文基线查询必须命中");
  assert.equal(typeof all[0], "object", "返回的必须是 entry 对象，不是 {entry,score}");
  assert.equal(all[0].name, all[0].name.trim());
  assert.ok(typeof all[0].server === "string" && typeof all[0].tool === "string", "entry 的原有字段都要在");
  const limited = rankEntries(CATALOG, "screenshot", 2);
  assert.ok(limited.length <= 2, "limit 必须生效");
  assert.deepEqual(limited, all.slice(0, 2), "limit 只截断，不改变顺序");
  assert.deepEqual(rankEntries(CATALOG, "", 5), [], "空查询给空数组，与旧行为一致");
  assert.deepEqual(rankEntries([], "screenshot", 5), [], "空目录不能抛");
});

// ── 这次改造要修的三类真实故障 ──────────────────────────────
// 每条都是现场证据，不是顺手加的覆盖。

test("D9 中文查询不再零命中：反汇编/崩溃/日志都能找到对应工具", () => {
  for (const [query, expected] of [
    ["反汇编", "mcp__rea__disassemble_function"],
    ["崩溃栈", "mcp__mobile__mobile_get_crash"],
    ["设备日志", "mcp__mobile__mobile_get_device_logs"],
    ["卸载应用", "mcp__mobile__mobile_uninstall_app"]
  ]) {
    const names = rankEntries(CATALOG, query, 3).map((e) => e.name);
    assert.ok(names.includes(expected), `「${query}」必须能命中 ${expected}，实际 top3：${names.join("、")}`);
  }
});

// 旧实现拿 name.includes(term) 做子串匹配，"so" 于是命中 source 里的 so，
// 把 compare_source_to_bundle 这种只在描述里顺带提到两个字母的工具顶到第一。
// 这条锁住「按子串撞运气」不再压过能力命中。
//
// 断言刻意不锁 top1：这是关键词堆叠，不是一句话。「反汇编 so 符号 调试」里
// 「符号」与「反汇编」都是能力词，谁排第一本来就没有唯一答案（同域内换个名次
// 对模型毫无影响）。要锁的是原来那件真事故——只有两个字母的 "so" 把一条
// 跨域的 compare_source_to_bundle 顶上来。
test("D9 不再被子串误伤：跨域长查询不会把只在散文里带 so 的工具顶上来", () => {
  const top = rankEntries(CATALOG, "反汇编 so 符号 调试", 3).map((e) => e.name);
  assert.ok(!top.includes("mcp__rea__compare_source_to_bundle"), "子串误伤的老毛病不能回来：" + top.join("、"));
  assert.equal(top[0], "mcp__rea__list_symbols", "「符号」是这条查询里最具体的词，应该排第一：" + top.join("、"));
  // 真能力命中必须在 top3 里：整条查询的能力指向是 rea 的反汇编。
  assert.ok(top.includes("mcp__rea__disassemble_function"), "反汇编工具要在 top3：" + top.join("、"));
  assert.ok(top.every((n) => n.startsWith("mcp__rea__")), "三条都该落在 rea：" + top.join("、"));
});

test("D9 中英桥接双向：中文查得到英文工具，英文查得到中文特征", () => {
  // 中文 → 英文工具名（工具名全是英文，不桥接就恒等于零命中）。
  const zh = rankEntries(CATALOG, "截屏", 3).map((e) => e.name);
  assert.ok(zh.some((n) => n.endsWith("Screenshot") || n.endsWith("mobile_save_screenshot")), "截屏必须桥接到 screenshot：" + zh.join("、"));
  // 英文 → 中文摘要特征：这条目录里没有中文摘要，所以验证的是「桥接不抛、
  // 英文仍是主通路」，而不是要求中文特征命中英文文档。
  const en = rankEntries(CATALOG, "crash", 3).map((e) => e.name);
  assert.ok(en.some((n) => n.endsWith("mobile_get_crash")), "crash 必须命中崩溃工具：" + en.join("、"));
  // 桥接表本身就是双向的产物：一次查询能同时吃进两种说法。
  const mixed = rankEntries(CATALOG, "拿 crash 日志", 3).map((e) => e.name);
  assert.ok(mixed.some((n) => n.includes("logs") || n.includes("crash")), "中英混说也要命中：" + mixed.join("、"));
});

// 能力词加权方向：名字里就带能力词的，必须压过只在摘要里提到的。
// 这条是「显著高于」这个验收口径的直接落地。
test("D9 能力词命中工具名时权重高于摘要散文命中", () => {
  // 「截图」：名字里有 screenshot 的两条（windows/Screenshot、mobile 的
  // take/save_screenshot）必须排在前面，而不是被摘要里的散文占位。
  const names = rankEntries(CATALOG, "截图", 3).map((e) => e.name);
  assert.ok(
    names.every((n) => n.toLowerCase().includes("screenshot")),
    "top3 必须全是名字里带 screenshot 的工具：" + names.join("、")
  );
  // 「崩溃」：mobile_get_crash 与 mobile_list_crashes 是唯二的崩溃类工具。
  const crash = rankEntries(CATALOG, "崩溃", 2).map((e) => e.name);
  assert.ok(crash.includes("mcp__mobile__mobile_get_crash"), "崩溃必须命中 get_crash：" + crash.join("、"));
});

// 门禁之外再保一条：这次改造不能把英文检索改坏。
// 「screenshot 必须还能命中 windows Screenshot」是既有测试 D2 的断言，
// 这里在离线语料上再锁一次，因为两者的目录不同（那边只有 3 个工具）。
test("D2 英文基线不退化：screenshot 第一名仍是 windows 的 Screenshot", () => {
  const top = rankEntries(CATALOG, "screenshot", 3).map((e) => e.name);
  assert.equal(top[0], "mcp__windows__Screenshot", "桌面上截图的经典查询不能被手机工具挤掉：" + top.join("、"));
});
