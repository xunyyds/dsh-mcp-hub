---
description: "MCP multi-server console for DSH: one panel to test connections, manage tools, approve calls, and back up your setup. Tool schemas load on demand instead of living in the prompt."
kind: "plugin-reference"
---

# dsh-mcp-hub

**Author**: xunyyds

English | [中文](README.zh.md)

---

## What is this?

One line: **a console for every MCP server in DSH**.

- Connection tests, tool listings, per-tool toggles, approval prompts, and configuration backups — all in one panel.
- HTTP servers and local stdio servers are treated the same, so you do not need two habits for two transports.
- It never takes over the connection: stdio servers and anything already registered in DSH are managed through the `ctx.tools` registry; `mcp-client` stays the connection owner, and the panel only reads the registry.

The big difference: **MCP tool schemas no longer live in the prompt**. A 207-tool server measures about 770 KB (≈210k tokens) of schema, paid again on every turn. With this plugin only `mcp_hub_tools` stays resident; everything else unfolds on demand.

---

## ✨ Features

| Capability | What you get |
|---|---|
| Server management | add/edit/delete, connection tests, latency and tool counts, per-tool toggles |
| On-demand loading | schemas stay out of the prompt; retrieve per server or per tool, cost independent of total tool count |
| Smart catalog | auto-generated capability words after each server name |
| Bilingual search | find tools with Chinese or English keywords; hits return names and summaries only |
| JIT hints | optional: nudge the model toward the right server at the right moment, hard-throttled |
| Approval | follows DSH's official approval; three buttons; the model receives a receipt |
| Quick import | paste mcpServers JSON, a URL, or a patch fragment to fill the form |
| One-click adoption | scan existing mcp-client entries and bring them into the panel |
| Backup and restore | the whole setup as one portable JSON |
| Call logs | per-day record of tool, arguments, approval decision, latency and outcome |

---

## 🚀 Installation

### Requirements

| Item | Requirement |
|---|---|
| DSH | `>= 0.2.1-rc.2` (older runtimes are rejected at load time by `engines.dsh`) |
| Approval channel | `@deepseek-ai/dsh-user-approval`; without it `ask` degrades to a denial (safe default) |

### Steps

1. **Install the plugin**

   ```sh
   dsh plugin --profile desktop add @dsh-external/dsh-mcp-hub
   ```

   From a local checkout:

   ```sh
   dsh plugin --profile desktop add <path-to-this-repo>
   ```

2. **Restart DSH**

   A restart is required before the **MCP Hub** settings pane appears. Upgrades work the same way — the panel's *reconnect* only redials MCP servers, it **does not reload plugin code**.

3. **Add a server**

   Press *Add* and fill in a URL or a command, or use **quick import**: paste an `mcpServers` JSON object, a bare URL, a `cordis.patch.yml` fragment, or a `stdio` entry, then press *parse and fill*. Parsing **writes nothing** — saving stays an explicit click, so a bad paste cannot silently overwrite a working server.

4. **Use the panel**

   - **Servers**: connection test, latency, tool counts, per-tool enable/disable
   - **Approval**: one master switch plus a three-state override per server, following DSH by default
   - **Gateway & catalog**: tune the `mcp_hub_tools` parameters; the preview is byte-identical to what the model receives
   - **Local servers**: scan existing `mcp-client` entries across profiles and adopt one into the panel
   - **Backup, import and export**: the whole setup as a single portable JSON
   - **Call logs**: per-day record of every call

---

## 🪙 Context budget: three tiers on demand

The system prompt keeps exactly **one resident MCP tool name, `mcp_hub_tools`**, plus a catalog listing only **server names and per-server tool counts**. Tool names and schemas unfold per tier:

| Tier | Call | Returns | Cost |
|---|---|---|---|
| 1 | `mcp_hub_tools()` | server names + tool count each | independent of total tool count |
| 2 | `mcp_hub_tools({ server: "windows" })` | that server's tool names + one-line summaries | only this server |
| 3 | `mcp_hub_tools({ names: ["mcp__windows__Screenshot"] })` | full parameter schema for those tools | only those tools |

`mcp_hub_tools({ query: "capture" })` searches across servers by keyword at any time; hits return names and summaries only.

A few behaviors worth knowing:

- **A miss never dumps the full tool list.** An empty result returns a server-level summary pointing at `server=` expansion, so cost stays independent of tool count.
- **Retrieval reveals the tool.** After a successful `names` call the tool re-enters the callable list on the next assembly (cap 32, oldest evicted), so a model that respects the `tools` array is never stuck re-retrieving the same name.
- **Name typos are corrected automatically.** When a slip such as `mcp_rea__open_binary` normalizes to exactly one catalog entry, it is resolved and the correction is stated; when ambiguous, the nearest real names are listed.
- **The zero-argument label prefers under-claiming.** A tool is marked "no arguments, call directly" only when all three hold: confirmed `type:"object"`, empty `properties`, and no `required`.
- **Oversized schemas degrade honestly.** A schema above roughly 16 KB becomes a shallow view of "parameter name + type + required", with **required parameters kept first**.
- **Offline servers are explained.** Unreachable servers are reported with their reason (e.g. `qfun: fetch failed`) and stay out of the retrieval pool.
- **Meta tools do not occupy retrieval slots.** Upstream "list more tools" switches such as `get_more_tools` stay out of the pool but remain callable by explicit name.

**Only the `off` tier disables a server.** `full` and `lazy` are now equivalent — both mean "unfold on demand"; the `full` name survives only for config compatibility. Server-disabled, tool-disabled, and `off` all feed one block reason: gone from the prompt, refused at execution, and unretrievable.

### Smart catalog

The feature words after each server name are **computed from tool metadata**, not hand-written copy:

```
Servers: mobile (33 tools): logs·clipboard·click·crash·screenshot, rea (7 tools): function·binary·symbol·disassemble·compare
```

The benefit is direct: connect a new server and its summary grows by itself — nobody has to remember to edit the prompt. As tools change, the words change too, so the model never "forgets that machine exists".

The words come from tool names, descriptions, and parameter names, with a bilingual bridge (`screenshot→截图`, `crash→崩溃`, `logcat→日志`). Each server costs 15–20 tokens per line; above 8 servers it compresses into a grouped summary plus a retrieval hint. Turn it off on the **Gateway & catalog** page if you do not want it.

### Bilingual search

`mcp_hub_tools({ query })` accepts Chinese and English keywords, mixed or separate. Chinese is no longer dropped:

- `反汇编 so 符号 调试` → top-3 all land in `rea`
- `进游戏卡死了拿崩溃栈` → top-1 is `mobile_get_crash`

Hits return tool names and one-line summaries only; full schemas still need `names`.

### JIT hints (off by default)

The catalog answers "which servers do I have"; JIT hints answer "which one applies *right now*".

When enabled, each turn extracts signals from "your recent words + the last few commands/paths" and appends one line when a server's trigger words match:

```
Hint: mobile has 33 log/screenshot tools; use mcp_hub_tools(query="logs") to see them
```

Its main risk is becoming noise, so throttling is hard:

- At most 1 per turn; at most 1 per server per session; at most N per session (default 3)
- The same signal text never produces a second hint
- Saying "can't find a tool / no such tool" lifts the above, while still capping at 1 per turn
- State is per session, and `so` inside `also` / `so that` never triggers

### Gateway parameters

The **Gateway & catalog** page tunes the four `mcp_hub_tools` parameters; saving takes effect on the next request (config is read per execution, no restart):

| Parameter | Default | Range | Effect |
|---|---|---|---|
| `searchLimit` | 8 | 1–20 | max hits per retrieval |
| `catalogLimit` | 200 | 1–500 | tool names listed when a retrieval found nothing usable |
| `schemaMaxBytes` | 16000 | 2000–128000 | byte budget per retrieved schema, above which it degrades |
| `loadBatchMax` | 12 | 1–50 | max tools per `names` call |

Three more **catalog and hint** switches:

| Switch | Default | Effect |
|---|---|---|
| `catalog.capabilities` | on | whether to append auto-generated feature words after each server name |
| `hint.enabled` | **off** | master switch for JIT hints |
| `hint.maxTotal` / `hint.maxPerServer` | 3 / 1 | per-session total hint cap / per-server cap |

All of these travel with the plugin backup; older backups without them keep local values on merge and reset to defaults on replace.

---

## ✅ Approval

The **Approval** page has one master switch and a three-state override per server. The default is **follow DSH**: the same approval panel, the same `ask` / `never` folding, the same official outcome vocabulary. The "deployment default policy" and "current permission preset" shown in the panel are read from the official service.

The card has three buttons:

| Button | Effect |
|---|---|
| Reject | this call does not run |
| Allow once | this call only; the next one asks again |
| Allow for this conversation | runs this call and remembers the tool for the rest of the conversation |

"Allow for this conversation" is a single click: the grant is written first, then the call is released. It expires on a new conversation or a DSH restart — grants live on the session, never in config. The page lists current session grants and offers *clear grants*.

Granularity is the **tool**, not the server: approving `send_msg` does not release `get_skey` on the same server.

**The model is told what happened.** Every approved call ends with a receipt appended to the result body, matching the button that was actually pressed (the receipt text is Chinese, matching the panel's language):

```
[审批：本次已由用户允许一次（下次仍会询问）]
[审批：本次已允许，并记住该工具，本对话内下次不再询问]
```

The first is *Allow once*; the second is *Allow for this conversation*. When a grant already exists and no prompt was shown, the receipt is `[审批：本对话内已授权，本次未再次询问]`.

**Unreadable policy denies.** Without `@deepseek-ai/dsh-user-approval`, or when the official request itself fails, the call fails closed, and both the error text and the DSH log say why. Nothing is silently allowed.

This card takes over approvals for the `mcp__` prefix only; everything else stays with the official panel. It is a runtime-registered slot, so uninstalling restores the original UI — **no DSH file is modified**.

---

## 📦 Adoption, backup, and logs

The **Local servers** card scans every DSH profile for `mcp-client` entries — profile root and each installed plugin's patch — and lists their sources. *Adopt* copies that configuration into the panel so it can be managed without retyping a URL, a command, or a token. Adoption changes nothing about the connection: it is a record, not a reconnect.

**Backup, import and export** produces one JSON holding the server list, every per-tool policy, the approval master switch, the gateway parameters, and the current loader patch:

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

- **Merge** keeps existing servers and overwrites matching names; **Replace** clears the list first — use it to reproduce a machine exactly.
- Restores are validated: wrong `kind`, unsupported `version`, and duplicate names are rejected before anything is written.
- An older backup without an `approval` field keeps the local value on merge and falls back to follow mode on replace — "absent" is not "off".
- Call logs are deliberately excluded: they are an append-only daily stream, and folding them in makes the file grow without bound.

⚠️ **A backup carries tokens in plain text. It is a credential file, not a shareable artifact.**

**Call logs** record per day the tool, arguments, approval decision, latency, outcome, and raw error for every call. The `ok` field reflects the **final** outcome, including failures this plugin itself causes.

### Security and credentials

`config.json`, `cordis.patch.yml`, and backup files may contain plaintext tokens — never commit or share them. Stored credentials are returned only to loopback same-origin requests; reaching the panel over a LAN address still manages servers normally, but no tokens are exposed and backup/import requests are rejected (403).

---

## ⚠️ Known limitations

- Approval depends on DSH's approval channel. With no composed answerer an `ask` degrades to a denial, which is the safe default.
- Session grants live in memory and die with the process. That is deliberate: a grant should not cross conversations or restarts.
- **Plugin code changes do not hot-reload.** After an upgrade or editing `lib/*.js` you must restart DSH; the panel's *reconnect* only redials MCP servers and never reloads plugin code.
- **Retrieval is lexical, not semantic.** Words that appear in tool names (`capture`, `screenshot`) hit best; a purely conceptual query ("the thing that edits files") may miss — you then get the server-level summary and can rephrase or expand with `server=`.
- **Reveal-on-load only matters to models that respect the `tools` array.** A model tolerant of out-of-list calls sees no difference.

---

## Contact

**Author**: xunyyds

**Reach us**: issues are welcome

## Finally

- Fork it, learn from it (but if you redistribute, keep the credit — or just drop a star ⭐).

---

<div align="center">

**dsh-mcp-hub** - Because Every Schema Should Earn Its Tokens™

</div>
