# 插件市场简介

面向 DSH 插件市场（`dsh-plugin-market-index` format 1）的展示文案。`description` 是 `LocalizedText`，中英各一份。

## 一句话简介（列表页 / 卡片）

长度控制在 40 字以内，市场卡片一行能放下：

- **中文**：MCP 多服务器控制台：一个面板测试、门禁、审批与备份
- **English**: One console to test, gate, approve, and back up every MCP server

## 市场 description（详情页）

`LocalizedText` 形态，与索引文件里的 `description` 字段一一对应：

```json
{
  "description": {
    "zh": "DSH 的 MCP 多服务器控制台。HTTP 与 stdio 一视同仁：逐服务器测试连接、查看工具、按工具启用或禁用、快捷导入 mcpServers 配置、一键接管 DSH 已连的服务器，并把整份配置导出成可迁移的备份。审批默认跟随 DSH——同一个审批面板、同一套 ask / never 折叠与结果词表，一次授权只对同一工具、本次对话有效。连接方始终是原生 mcp-client，插件只读注册表。",
    "en": "MCP multi-server console for DSH. HTTP and stdio are treated the same: test a connection, inspect its tools, enable or disable any single tool, paste an mcpServers config, adopt a server DSH already runs, and export the whole setup as a portable backup. Approvals follow DSH by default — the same prompt, the same ask / never folding and outcome vocabulary, with one grant covering one tool for one conversation. The native mcp-client keeps every connection; the plugin only reads the registry."
  }
}
```

## 索引条目示例

放进市场索引时，`metadata` 与 `versions` 由生成器负责，这里只示范本插件自己的字段：

```json
{
  "name": "@dsh-external/dsh-mcp-hub",
  "title": {
    "zh": "MCP Hub",
    "en": "MCP Hub"
  },
  "description": {
    "zh": "MCP 多服务器控制台：一个面板测试、门禁、审批与备份。",
    "en": "MCP multi-server console: test, gate, approve, and back up every server from one panel."
  },
  "author": "xunyyds",
  "homepage": "https://github.com/xunyyds/dsh-mcp-hub#readme",
  "repository": {
    "type": "git",
    "url": "https://github.com/xunyyds/dsh-mcp-hub"
  }
}
```

## 用词约定

为了让市场文案和 README、设置面板保持一致，这几个词固定下来：

| 概念 | 用词 | 不用 |
|---|---|---|
| 跟随官方审批 | 跟随 DSH | 自动审批、智能审批 |
| 一次会话授权 | 本次对话内允许 | 永久允许、记住选择 |
| 逐工具开关模式 | 手动（逐工具） | 自定义、高级模式 |
| 权限预设 | 权限预设 | 权限模式、安全等级 |

「自动审批」这个词刻意不用：它容易和官方的 **Auto review**（`dsh-experimental-auto-review`，用模型逐调用审查的 EXP 预设）混淆，而本插件跟随的是 `ask` / `never` 这条策略线，不是那套审查。
