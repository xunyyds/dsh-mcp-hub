// patch 桥接区的边界识别。
//
// 这条逻辑曾把边界切在 args 数组元素 `          - '-m'` 上（它也是 `- ` 开头），
// 于是桥接区被截成一个半个条目，剩下的桥接条目留在区外，下次写入时与新块
// 并存——patch 里出现两份 mcp-hub-windows / mcp-hub-mobile，两个 mcp-client
// 实例抢同一个 serverName。所以这里逐条守住边界。

import assert from "node:assert/strict";
import { test } from "node:test";

// 复刻 lib/index.js 的 findBridgeInPatch。跑的是同一套判定，
// 因为该函数不是具名导出；一旦实现改动，这里必须同步并重新验证。
function findBridgeInPatch(raw) {
  const idx = raw.indexOf("- id: mcp-hub-");
  if (idx < 0) return null;
  const start = raw.lastIndexOf("\n", idx) + 1;
  const lines = raw.split("\n");
  let startLine = 0;
  let consumed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    consumed += lines[i].length + 1;
    if (consumed > start) {
      startLine = i;
      break;
    }
  }
  const isBridgeLine = (i) => {
    const line = lines[i] || "";
    if (!/^\s*- id: mcp-hub-/.test(line)) return false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (/^\s*$/.test(next)) continue;
      return /^\s+name:\s*'@deepseek-ai\/dsh-mcp-client'/.test(next);
    }
    return false;
  };
  const isItemStart = (i) => /^\s*- (id|name|insert|disabled):/.test(lines[i] || "");
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i += 1) {
    if (isItemStart(i)) {
      if (isBridgeLine(i)) continue;
      endLine = i;
      break;
    }
  }
  let end = 0;
  for (let i = 0; i < endLine; i += 1) end += lines[i].length + 1;
  if (end > raw.length) end = raw.length;
  return { start, end };
}

const PATCH = [
  "# header",
  "- insert:",
  "    - id: mcp-hub",
  "      name: '@dsh-external/dsh-mcp-hub'",
  "    - id: mcp-hub-alpha",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: alpha",
  "        transport: stdio",
  "        command: 'x'",
  "        args:",
  "          - '-m'",
  "          - 'serve'",
  "        toolCallTimeoutMs: 120000",
  "    - id: mcp-hub-beta",
  "      name: '@deepseek-ai/dsh-mcp-client'",
  "      config:",
  "        serverName: beta",
  "        transport: stdio",
  "        command: 'y'",
  "        toolCallTimeoutMs: 60000"
].join("\n");

test("边界不切在 args 数组元素上（那会把桥接区截成半个条目）", () => {
  const r = findBridgeInPatch(PATCH);
  const block = PATCH.slice(r.start, r.end);
  assert.equal((block.match(/- id: mcp-hub-/g) || []).length, 2, "两个桥接条目都必须在区内");
  assert.ok(block.includes("          - 'serve'"), "args 元素必须留在区内");
  assert.ok(block.includes("mcp-hub-beta"), "第二条桥接条目不能被切在外面");
});

test("块之后的非桥接条目属于区外，不能被后续写入吞掉", () => {
  const withTail = PATCH + "\n- id: another-plugin\n  name: 'x'\n";
  const r = findBridgeInPatch(withTail);
  const block = withTail.slice(r.start, r.end);
  assert.ok(!block.includes("another-plugin"), "别人的条目不能进桥接区");
  assert.ok(withTail.slice(r.end).includes("another-plugin"), "它必须留在区外、原样保留");
});

test("没有桥接条目时返回 null，交给调用方走「新建」分支", () => {
  assert.equal(findBridgeInPatch("- insert:\n    - id: mcp-hub\n      name: x\n"), null);
});

test("重复条目全部落在同一区里（这正是去重能生效的前提）", () => {
  const dup = PATCH + "\n" + PATCH.split("\n").slice(4).join("\n");
  const r = findBridgeInPatch(dup);
  const block = dup.slice(r.start, r.end);
  assert.equal((block.match(/- id: mcp-hub-/g) || []).length, 4, "四条（含重复）都要在区内，否则去不掉");
});
