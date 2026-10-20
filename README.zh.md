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
- [审批](#审批)
- [实现说明](#实现说明)
- [接管本地服务器](#接管本地服务器)
- [备份与恢复](#备份与恢复)
- [HTTP API](#http-api)
- [已知限制](#已知限制)
- [开发说明](#开发说明)

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

<a id="审批"></a>
## 审批

设置页的 **审批** 页有一个总开关，以及每台服务器的三态覆盖。默认是**跟随 DSH**。

| 层 | 取值 | 作用 |
|---|---|---|
| 总开关 | 开 / 关 | 关掉后回到「逐工具开关」的旧语义 |
| 服务器 | 继承总开关 / 跟随 DSH / 手动（逐工具） | 覆盖总开关，让个别服务器单独表态 |

**跟随是什么意思。** 不是本插件模仿官方，而是直接消费官方：同一个 `ctx.approval`，同一套 `ask` / `never` 折叠，同一个审批面板，同一份 `allowed-once` / `rejected` / `cancelled` / `unavailable` 结果词表。面板上显示的「部署默认策略」与「当前权限预设」读的也是官方服务的真实值（`overrideOf()` 与 `permissionPresets.current()`），不是本插件重新推导的。

**一次授权只对同一软件、本次对话有效。** 在官方弹窗里点「允许一次」后，本对话内该服务器的后续调用不再重复询问；换对话即失效。授权记在会话上，不写进配置，因此不会在你下次打开新对话时静默免询问。审批页会列出当前的会话授权，并提供「清空本次授权」。

**`ask` 与 `never` 在 MCP 上的含义。** `ask` 走官方弹窗；`never` 不弹窗、直接放行——这是官方预设（如 `danger-full-access`）表达「不要提示」的方式。这一点与沙箱升权不同：MCP 工具没有沙箱，「升权被拒」那套映射不适用，照搬会让选了 Full access 的用户每个 MCP 调用都被拒。

**读不到策略就拒绝。** 没组合 `@deepseek-ai/dsh-user-approval`、或官方请求自身失败时，按 fail closed 拒绝，并在错误信息与 DSH 日志里说明原因，不静默放行。

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
- **审批不代问，直接消费官方 seam。** 跟随模式下本插件不返回 `{kind:'ask'}` 让 `dsh-tools` 代问，而是自己调 `ctx.approval.request()`，再按官方词表把结果映射回 `allow` / `deny` / `cancel`。这样做有两个必要理由：一是不落入 `dsh-tools` 把 `ask` 一律当「沙箱升权」的解释（那会让 `never` 变成拒绝），二是只有拿到 `allowed-once` 本身才能记住本次对话的授权。审计仍是官方写的 `approval/asked` + `approval/decided` 配对。
- **调试调用走真实管线。** 面板调用经由 `ctx.tools.execute()`，审批弹窗、超时、内容投影全部生效。调用携带 `parent` 标记，被识别为子派发，从而不被 PTC 模式折叠。面板调试没有 agent，因此不受审批门禁拦截——点「运行」本身就是对这次调用的明确授权。
- **状态是推导的，绝不伪造。** `mcp-client` 不导出连接状态，面板统计该服务器前缀下的已注册工具数。零个工具意味着「未连接」，而不是「已连接但没工具」。

<a id="接管本地服务器"></a>
## 接管本地服务器

**本地服务器** 卡片扫描每个 DSH profile 里的 `mcp-client` 条目——包括 profile 根目录和各个已安装插件的 bundle 补丁——并列出来源。点「接管到面板」把该配置复制进面板，从而可以设置门禁与查看状态，无需重填 URL、命令或 Token。

接管不改变连接的任何细节。它只是一条记录，不是重连。

<a id="备份与恢复"></a>
## 备份与恢复

**备份、导入与导出** 是同一页面，从首页「管理」的第三项进入。其中的备份区导出一个 JSON，包含服务器列表、全部逐工具策略、审批总开关，以及当前加载补丁：

```json
{
  "kind": "dsh-mcp-hub/backup",
  "version": 1,
  "exportedAt": "2026-10-20T03:14:15.000Z",
  "profile": "",
  "approval": { "followDsh": true },
  "servers": [ { "name": "qfun", "transport": "streamable-http", "url": "…", "approvalMode": "inherit", "tools": { "send_msg": { "approval": true } } } ],
  "patch": "…"
}
```

- **合并** 保留现有服务器，同名覆盖。
- **覆盖** 先清空列表——用于精确复刻一台机器。
- 导入前会校验：`kind` 不对、`version` 不支持、服务器重名，都会在写入前被拒。
- 旧备份（没有 `approval` 字段）合并时保留本机现值，覆盖时回到「跟随」默认值——「没写」不等于「关掉」。
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
| GET/POST | `/mcp-hub/approval` | 读审批总开关、每服务器三态与官方策略；写总开关 / 服务器模式，或 `action: "revoke-grants"` 清空会话授权 |
| POST | `/mcp-hub/invoke` | 经真实管线的调试调用 |
| GET/POST | `/mcp-hub/backup` | 导出，或按 `mode` 恢复 |
| GET/POST | `/mcp-hub/local` | 扫描可接管服务器，或接管其中一个 |
| GET/POST | `/mcp-hub/import` | 加载补丁状态，或写入 / 移除 |
| GET/DELETE | `/mcp-hub/records` | 按天查看调用历史 |

<a id="已知限制"></a>
## 已知限制

- 审批依赖 DSH 的审批通道。没组合应答者时，`ask` 退化为拒绝，这是安全默认；跟随模式下本插件会把「官方审批服务不可用」明确写进拒绝原因，而不是静默放行。
- 会话级授权保存在内存里，进程重启即失效。这是有意的：授权不该跨会话，也不该跨重启。
- `ctx.tools.execute()` 是带完整 JSDoc 的公开方法，但不属于 `dsh-tools` 文档化的「Use this package」接口。已针对随包发布的构建验证过；未来大版本可能变动。
- `mcp-client` 没有暴露注册事件，因此面板按请求实时重算工具清单，而不是缓存连接态。
- 加载补丁以明文保存 `Authorization: Bearer <token>`。能读 profile 的人就能读到 Token。

## 开发说明

事实源：`lib/index.js`（宿主插件、路由、注册表适配层）与 `lib/client.js`（设置面板）。`config.json` 和 `cordis.patch.yml` 是运行时数据，已被 git 忽略。

审批相关测试不依赖 DSH 启动，直接 `node` 运行：

```powershell
node lib/approval.test.mjs          # 判定逻辑：跟随 / manual / never / fail closed
node lib/approval.routes.test.mjs   # HTTP 路由与备份兼容
node lib/approval.real.test.mjs     # 对照真实 dsh-user-approval 的 overrideOf 折叠
node lib/approval.e2e.test.mjs      # 与真实 ApprovalService 对接，验证官方审计对
```

`approval.real.test.mjs` 与 `approval.e2e.test.mjs` 会从本机安装目录加载官方包（路径见文件顶部 `DSH_PKGS`），在别的机器上需要改那一行。
