---
description: "DSH 的 MCP 多服务器控制台 —— 一个面板完成测试、接管、门禁与备份；streamable-http 与本地 stdio 进程一视同仁。"
kind: "plugin-reference"
---

# @dsh-external/dsh-mcp-hub

[English](README.md) | [中文](README.zh.md)

## 概述

`dsh-mcp-hub` 给 DSH 提供一个管理全部 MCP 服务器的控制台。它不与 `@deepseek-ai/dsh-mcp-client` 争抢连接：HTTP 服务器可以由插件直连，而 stdio 服务器和任何已注册进 DSH 的服务器都通过 `ctx.tools` 注册表代管，**连接方始终不变**。逐工具启用与审批策略、整插件备份、以及自动发现 DSH 已配置的服务器，都集中在同一个设置面板。

## 目录

- [使用本插件](#使用本插件)
- [实现说明](#实现说明)
- [接管本地服务器](#接管本地服务器)
- [备份与恢复](#备份与恢复)
- [HTTP API](#http-api)
- [已知限制](#已知限制)

-----

<a id="使用本插件"></a>
## 使用本插件

安装到某个 profile 并重启 DSH：

```powershell
dsh plugin --profile desktop add <本仓库路径>
```

设置页出现 **MCP Hub**。它以三种并列方式管理服务器：

| 方式 | 传输 | 由谁连接 | 面板能做 |
|---|---|---|---|
| HTTP | `streamable-http` | 插件自身，或注册后的 DSH | 连接测试、工具清单、门禁、调试 |
| 本地进程 | `stdio`（`command`/`args`） | DSH `mcp-client` | 工具清单、门禁、调试、接管 |
| 已接管 | DSH 已在跑的那个 | DSH `mcp-client`（不变） | 同上，且无需重填配置 |

工具名始终是 `mcp__<serverName>__<rawName>`，与原生客户端完全一致，因此会话历史与权限规则在重启后依然有效。

### 快捷导入

服务器编辑器里有 **快捷导入** 面板。粘贴下列任一格式，点「解析并回填表单」：

- 标准 `mcpServers` JSON 对象（Claude Desktop、Chatbox、Cursor、VS Code）
- 裸 URL，可带 `?token=…`
- 含 `mcp-client` 条目的 `cordis.patch.yml` 片段
- 带 `command` / `args` / `env` 的 `stdio` 条目

解析过程**不写任何文件**。它只回填表单，保存仍由你显式点击，因此贴错内容不会静默覆盖正在工作的服务器。

<a id="实现说明"></a>
## 实现说明

```
模型 ──tools──▶ DSH 工具管线
                     │
         tools/pre-execute  ◀── 允许 / 询问（本插件）
         ctx.tools.guard()  ◀── 单调拒绝（本插件）
                     │
     @deepseek-ai/dsh-mcp-client  ──▶ 外部 MCP 服务器
                     │
               ctx.tools.register()  ──▶ 注册表（本插件在此读取）
```

- **连接归属从不转移。** `mcp-client` 拥有每一条 stdio 连接和每一个已注册的服务器。面板读取注册表而非另开连接，所以 stdio 服务器显示的是实时工具，而不是「不支持」。
- **策略分两层。** `tools/pre-execute` 决定允许 / 询问，它是可扩展的瀑布，后续监听器理论上能翻案；`ctx.tools.guard()` 在该瀑布之后运行且不可逆——面板里禁用的工具在这里被否决。
- **调试调用走真实管线。** 面板调用经由 `ctx.tools.execute()`，审批弹窗、超时、内容投影全部生效。调用携带 `parent` 标记，被识别为子派发，从而不被 PTC 模式折叠。
- **状态是推导的，绝不伪造。** `mcp-client` 不导出连接状态，面板统计该服务器前缀下的已注册工具数。零个工具意味着「未连接」，而不是「已连接但没工具」。

<a id="接管本地服务器"></a>
## 接管本地服务器

**本地服务器** 卡片扫描每个 DSH profile 里的 `mcp-client` 条目——包括 profile 根目录和各个已安装插件的 bundle 补丁——并列出来源。点「接管到面板」把该配置复制进面板，从而可以设置门禁与查看状态，无需重填 URL、命令或 Token。

接管不改变连接的任何细节。它只是一条记录，不是重连。

<a id="备份与恢复"></a>
## 备份与恢复

**备份与恢复** 卡片导出一个 JSON，包含服务器列表、全部逐工具策略，以及当前加载补丁：

```json
{
  "kind": "dsh-mcp-hub/backup",
  "version": 1,
  "exportedAt": "2026-10-20T03:14:15.000Z",
  "profile": "",
  "servers": [ { "name": "qfun", "transport": "streamable-http", "url": "…", "tools": { "send_msg": { "approval": true } } } ],
  "patch": "…"
}
```

- **合并** 保留现有服务器，同名覆盖。
- **覆盖** 先清空列表——用于精确复刻一台机器。
- 导入前会校验：`kind` 不对、`version` 不支持、服务器重名，都会在写入前被拒。
- 调用日志刻意排除。它是按天追加的流水，塞进备份只会让文件无限增长。

备份里的 Token 是明文。它是凭证文件，不是可分享的产物。

<a id="http-api"></a>
## HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/mcp-hub/status` | 每个服务器的状态、托管标志、工具数 |
| GET/POST/PUT/DELETE | `/mcp-hub/servers` | 列出、新增或更新、删除 |
| GET | `/mcp-hub/test` | 连接并返回延迟、服务器信息、工具名 |
| GET | `/mcp-hub/tools` | 带策略的工具清单；`source` 标明 `registry` 或 `dial` |
| POST | `/mcp-hub/tool-policy` | 批量更新启用 / 审批 |
| POST | `/mcp-hub/invoke` | 经真实管线的调试调用 |
| GET/POST | `/mcp-hub/backup` | 导出，或按 `mode` 恢复 |
| GET/POST | `/mcp-hub/local` | 扫描可接管服务器，或接管其中一个 |
| GET/POST | `/mcp-hub/import` | 加载补丁状态，或写入 / 移除 |
| GET/DELETE | `/mcp-hub/records` | 按天查看调用历史 |

<a id="已知限制"></a>
## 已知限制

- 审批依赖 DSH 的审批通道。在自动批准会话里，`ask` 会退化为拒绝，这是安全默认。
- `ctx.tools.execute()` 是带完整 JSDoc 的公开方法，但不属于 `dsh-tools` 文档化的「Use this package」接口。已针对随包发布的构建验证过；未来大版本可能变动。
- `mcp-client` 没有暴露注册事件，因此面板按请求实时重算工具清单，而不是缓存连接态。
- 加载补丁以明文保存 `Authorization: Bearer <token>`。能读 profile 的人就能读到 Token。

## 开发说明

事实源：`lib/index.js`（宿主插件、路由、注册表适配层）与 `lib/client.js`（设置面板）。`config.json` 和 `cordis.patch.yml` 是运行时数据，已被 git 忽略。
