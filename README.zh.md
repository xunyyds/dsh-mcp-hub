---
description: "DSH 的 MCP 多服务器控制台 —— 一个面板完成测试、接管、门禁与备份；审批跟随 DSH 官方策略，streamable-http 与本地 stdio 一视同仁。"
kind: "plugin-reference"
---

# `@dsh-external/dsh-mcp-hub`

[English](README.md) | 中文

`dsh-mcp-hub` 给 DSH 一个管理全部 MCP 服务器的控制台。它不与 `@deepseek-ai/dsh-mcp-client` 争抢连接：HTTP 服务器可由插件直连，而 stdio 服务器和任何已注册进 DSH 的服务器都通过 `ctx.tools` 注册表代管，**连接方始终不变**。审批默认跟随 DSH 官方策略——同一个 `ctx.approval`、同一个审批面板、同一份结果词表。

## 安装

```sh
dsh plugin --profile desktop add @dsh-external/dsh-mcp-hub
```

也可以从仓库本地安装：

```sh
dsh plugin --profile desktop add <本仓库路径>
```

装完重启 DSH，设置页出现 **MCP Hub**。要求 DSH `>= 0.2.1-rc.2`；更低的版本会在加载时按 `engines.dsh` 拒绝。

## 它管什么

面板以三种并列方式管理服务器：

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

**审批** 页有一个总开关，以及每台服务器的三态覆盖。默认是**跟随 DSH**。

| 层 | 取值 | 作用 |
|---|---|---|
| 总开关 | 开 / 关 | 关掉后回到「逐工具开关」的旧语义 |
| 服务器 | 继承总开关 / 跟随 DSH / 手动（逐工具） | 覆盖总开关，让个别服务器单独表态 |

**跟随是什么意思。** 不是本插件模仿官方，而是直接消费官方：同一个 `ctx.approval`，同一套 `ask` / `never` 折叠，同一个审批面板，同一份 `allowed-once` / `rejected` / `cancelled` / `unavailable` 结果词表。面板上显示的「部署默认策略」与「当前权限预设」读的也是官方服务的真实值（`overrideOf()` 与 `permissionPresets.current()`），不是本插件重新推导的。

**审批卡片有三个按钮。**

| 按钮 | 作用 |
|---|---|
| 拒绝 | 本次调用不执行 |
| 允许一次 | 只放行这次，下次仍会询问 |
| 本对话内允许 | 放行这次并记住该工具，本对话内不再询问 |

「本对话内允许」是一次点击：先写授权、再放行本次调用。换对话或重启 DSH 即失效——授权记在会话上，不写进配置，因此不会在你下次打开新对话时静默免询问。审批页会列出当前的会话授权，并提供「清空本次授权」。

粒度是**工具**而不是服务器：批准 `send_msg` 不会顺带放行同服务器的 `get_skey` 或 `kick`。按服务器记忆会让一次对只读工具的批准解锁整台服务器的全部能力，而用户在弹窗里看到的只是那一个动作。

这张卡片只接管 `mcp__` 前缀的审批，其他审批仍由官方面板处理。它是运行时注册的 slot，卸载插件即恢复原状，不修改任何 DSH 文件。

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

## 接管本地服务器

**本地服务器** 卡片扫描每个 DSH profile 里的 `mcp-client` 条目——包括 profile 根目录和各个已安装插件的 bundle 补丁——并列出来源。点「接管到面板」把该配置复制进面板，从而可以设置门禁与查看状态，无需重填 URL、命令或 Token。

接管不改变连接的任何细节。它只是一条记录，不是重连。

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

## HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/mcp-hub/status` | 每个服务器的状态、托管标志、工具数 |
| GET/POST/PUT/DELETE | `/mcp-hub/servers` | 列出、新增或更新、删除 |
| GET | `/mcp-hub/test` | 连接并返回延迟、服务器信息、工具名 |
| GET | `/mcp-hub/tools` | 带策略的工具清单；`source` 标明 `registry` 或 `dial` |
| POST | `/mcp-hub/tool-policy` | 批量更新启用 / 审批 |
| GET/POST | `/mcp-hub/approval` | 读审批总开关、每服务器三态与官方策略；写总开关 / 服务器模式，`action: "grant"` 记一条会话授权，或 `action: "revoke-grants"` 清空 |
| GET | `/mcp-hub/pending` | 按 `callId` 反查待审批的 MCP 工具 |
| POST | `/mcp-hub/invoke` | 经真实管线的调试调用 |
| GET/POST | `/mcp-hub/backup` | 导出，或按 `mode` 恢复 |
| GET/POST | `/mcp-hub/local` | 扫描可接管服务器，或接管其中一个 |
| GET/POST | `/mcp-hub/import` | 加载补丁状态，或写入 / 移除 |
| GET/DELETE | `/mcp-hub/records` | 按天查看调用历史 |

**凭证访问边界。** `/mcp-hub/servers` 会返回明文 Token（编辑器要把它填回输入框），
`/mcp-hub/backup` 与 `/mcp-hub/import` 会返回含 Token / Authorization 的全文。
这三条只对**本机同源请求**给满内容：

- 请求的 `Host` 必须是回环地址（`127.0.0.1` / `[::1]` / `localhost`）；
- 带 `Sec-Fetch-Site` 时必须是 `same-origin` / `none`（跨站页面会被拒）；
- 带 `Origin` 时其主机也必须在回环上。

从局域网地址访问面板仍可正常管理服务器，只是拿不到已保存的凭证
（`_token` 不返回，`credentialVisible: false`）；`/backup` 与 `/import` 直接 403。
这样即使 web 服务被改绑到局域网（例如用 remote-web-ui 那类插件），
端口本身也不再是「谁能读走密钥」的边界。
`/mcp-hub/status` 是每 12 秒一次的轮询响应，既不返回 Token 也不返回 stdio 的 `env`
（后者经常装着 API key），两者都只在 `/servers` 上出现。

## 已知限制

- 审批依赖 DSH 的审批通道。没组合应答者时，`ask` 退化为拒绝，这是安全默认。
- 会话级授权保存在内存里，进程重启即失效。这是有意的：授权不该跨会话，也不该跨重启。

## 开发

事实源：`lib/index.js`（宿主插件、路由、注册表适配层）与 `lib/client.js`（设置面板）。`config.json` 和 `cordis.patch.yml` 是运行时数据，已被 git 忽略。

```sh
npm test
```

等价于依次跑四个文件：

| 文件 | 覆盖 |
|---|---|
| `lib/approval.test.mjs` | 判定逻辑：跟随 / manual / never / fail closed |
| `lib/approval.routes.test.mjs` | HTTP 路由、授权粒度、备份兼容 |
| `lib/approval.real.test.mjs` | 对照真实 `dsh-user-approval` 的 `overrideOf` 折叠 |
| `lib/approval.e2e.test.mjs` | 与真实 `ApprovalService` 对接，验证官方审计对 |

后两个会从本机安装目录加载官方包（路径见文件顶部 `DSH_PKGS`），在别的机器上需要改那一行。
