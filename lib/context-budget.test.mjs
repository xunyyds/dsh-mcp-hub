// 上下文预算网关的判定逻辑。这组测试守的是本插件最贵的一条承诺：
// 「禁用」必须真的从提示词里消失，而「lazy」必须真的还能调用。
//
// 之所以单独测而不是只测路由：过滤发生在 system-prompt/assemble 里，
// 那是每个 step 都会走的热路径，一个恒为 true 的判定会让整台服务器
// 静默消失（模型看不见、也没有报错），这是最难在面板上发现的一类回归。

import assert from "node:assert/strict";
import test from "node:test";

import { firstSentence, normalizeTier, rankEntries, splitToolName, tokenize } from "./context-budget.js";

test("normalizeTier：未知值一律回落 full，绝不因为拼错就悄悄降级", () => {
  assert.equal(normalizeTier("full"), "full");
  assert.equal(normalizeTier("lazy"), "lazy");
  assert.equal(normalizeTier("off"), "off");
  assert.equal(normalizeTier(undefined), "full");
  assert.equal(normalizeTier("lazzy"), "full");
  assert.equal(normalizeTier(""), "full");
  assert.equal(normalizeTier(null), "full");
});

test("splitToolName：按 mcp__<server>__<tool> 拆，非 MCP 名字返回 null", () => {
  assert.deepEqual(splitToolName("mcp__rea__analyze_function"), { server: "rea", tool: "analyze_function" });
  assert.deepEqual(splitToolName("mcp__my-server__do_thing"), { server: "my-server", tool: "do_thing" });
  assert.equal(splitToolName("read"), null);
  assert.equal(splitToolName("mcp__nounderscore"), null);
  assert.equal(splitToolName(""), null);
});

test("firstSentence：截首句，没有句号就按长度截断", () => {
  assert.equal(firstSentence("Analyze one function. Then do more."), "Analyze one function.");
  assert.equal(firstSentence("中文第一句。第二句。"), "中文第一句。");
  assert.equal(firstSentence("no period here"), "no period here");
  assert.equal(firstSentence(""), "");
  assert.equal(firstSentence(undefined), "");
  const long = "x".repeat(300);
  assert.equal(firstSentence(long).length, 160);
});

test("rankEntries：名字命中优先于摘要命中，无命中的词不引入噪声", () => {
  const entries = [
    { name: "mcp__s__capture_web_screenshot", summary: "capture a page" },
    { name: "mcp__s__compare_artifacts", summary: "capture two artifacts and diff" },
    { name: "mcp__s__list_segments", summary: "list binary segments" }
  ];
  const hits = rankEntries(entries, "capture", 8);
  assert.equal(hits.length, 2, "只有两条提到 capture");
  assert.equal(hits[0].name, "mcp__s__capture_web_screenshot", "名字命中必须排在摘要命中前面");

  assert.deepEqual(rankEntries(entries, "segment", 8).map((e) => e.name), ["mcp__s__list_segments"]);
  assert.deepEqual(rankEntries(entries, "", 8), [], "空查询不返回全部：那等于把目录塞进结果");
  assert.deepEqual(rankEntries(entries, "zzz", 8), []);
});

test("rankEntries：limit 生效且结果稳定", () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({ name: "mcp__s__tool_" + i, summary: "capture" }));
  const hits = rankEntries(entries, "capture", 5);
  assert.equal(hits.length, 5);
  const again = rankEntries(entries, "capture", 5);
  assert.deepEqual(again.map((e) => e.name), hits.map((e) => e.name), "同输入必须给同顺序");
});

test("tokenize：切 snake_case 与分隔符，丢弃单字符", () => {
  assert.deepEqual(tokenize("capture_web_screenshot"), ["capture", "web", "screenshot"]);
  assert.deepEqual(tokenize("a b c"), []);
  assert.deepEqual(tokenize(""), []);
});
