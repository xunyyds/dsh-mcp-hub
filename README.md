---
description: "MCP multi-server console for DSH — one panel to test, adopt, gate, and back up every MCP server, whether it speaks streamable-http or runs as a local stdio process."
kind: "plugin-reference"
---

# @dsh-external/dsh-mcp-hub

[English](README.md) | [中文](README.zh.md)

## Summary

`dsh-mcp-hub` gives DSH one console for every MCP server. It does not compete with `@deepseek-ai/dsh-mcp-client` for the connection: HTTP servers may be dialled directly, while stdio servers and anything already registered in DSH are managed through the `ctx.tools` registry, so the connection owner never changes. Per-tool enable and approval policy, whole-plugin backup, and discovery of servers DSH already configured all live in one settings pane.

## Table of Contents

- [Use this plugin](#use-this-plugin)
- [Approval](#approval)
- [Understand the implementation](#understand-the-implementation)
- [Adopt a local server](#adopt-a-local-server)
- [Backup and restore](#backup-and-restore)
- [HTTP API](#http-api)
- [Known limitations](#known-limitations)
- [Dev note](#dev-note)

-----

<a id="use-this-plugin"></a>
## Use this plugin

Install into a profile and restart DSH:

```powershell
dsh plugin --profile desktop add <path-to-this-repo>
```

The settings pane appears under **MCP Hub**. It manages servers in three parallel ways:

| Way | Transport | Who connects | Panel can |
|---|---|---|---|
| HTTP | `streamable-http` | the plugin itself, or DSH once registered | test, list tools, gate, debug |
| Local process | `stdio` (`command`/`args`) | DSH `mcp-client` | list tools, gate, debug, adopt |
| Adopted | whichever DSH already runs | DSH `mcp-client` (unchanged) | everything above, without retyping config |

Tool names stay `mcp__<serverName>__<rawName>`, identical to the native client, so session history and permission rules survive restarts.

### Quick import

The server editor carries a **quick import** panel. Paste any of these and press *parse and fill*:

- a standard `mcpServers` JSON object (Claude Desktop, Chatbox, Cursor, VS Code)
- a bare URL, optionally carrying `?token=…`
- a `cordis.patch.yml` fragment containing an `mcp-client` entry
- a `stdio` entry with `command` / `args` / `env`

Parsing never writes anything. It fills the form and leaves saving to you, so a bad paste cannot silently overwrite a working server.

<a id="approval"></a>
## Approval

The **Approval** page has one master switch and a three-state override per server. The default is **follow DSH**.

| Layer | Values | Effect |
|---|---|---|
| Master switch | on / off | Off returns to the legacy per-tool switch semantics |
| Server | inherit / follow DSH / manual (per tool) | Overrides the master switch so one server can differ |

**What "follow" means.** This is not the plugin imitating the official behaviour — it consumes it. The same `ctx.approval`, the same `ask` / `never` folding, the same approval panel, the same `allowed-once` / `rejected` / `cancelled` / `unavailable` outcome vocabulary. The "deployment default policy" and "current permission preset" shown in the panel are read from the official service (`overrideOf()` and `permissionPresets.current()`), not recomputed here.

**One grant covers one server for one conversation.** After approving once in the official prompt, later calls to that server in the same conversation stop asking; a new conversation expires the grant. Grants live on the session, never in config, so opening a fresh conversation can never silently skip a prompt. The Approval page lists current session grants and offers *clear grants*.

**What `ask` and `never` mean for MCP.** `ask` raises the official prompt. `never` does not prompt and allows the call — that is how an official preset such as `danger-full-access` expresses "stop asking me". This differs from sandbox escalation: MCP tools have no sandbox, so the "escalation denied" mapping does not apply, and copying it would deny every MCP call for a user who selected Full access.

**Unreadable policy denies.** Without `@deepseek-ai/dsh-user-approval`, or when the official request itself fails, the call fails closed, and both the error text and the DSH log say why. Nothing is silently allowed.

<a id="understand-the-implementation"></a>
## Understand the implementation

```
model ──tools──▶ DSH tool pipeline
                      │
          tools/pre-execute  ◀── allow / ask  (this plugin)
          ctx.tools.guard()  ◀── monotonic deny (this plugin)
                      │
      @deepseek-ai/dsh-mcp-client  ──▶ external MCP server
                      │
                ctx.tools.register()  ──▶ registry (this plugin reads here)
```

- **Connection ownership never moves.** `mcp-client` owns every stdio connection and every server it already registered. The panel reads the registry rather than opening a second connection, which is why a stdio server shows live tools instead of "unsupported".
- **Policy has two layers.** `tools/pre-execute` decides allow / ask and is extensible, so a later listener could reverse it. `ctx.tools.guard()` runs after that waterfall and cannot be reversed — a tool disabled in the panel is denied there.
- **Approval consumes the official seam instead of delegating the ask.** In follow mode the plugin does not return `{kind:'ask'}` and let `dsh-tools` ask; it calls `ctx.approval.request()` itself and maps the official outcome back to `allow` / `deny` / `cancel`. Two reasons make this necessary: it avoids `dsh-tools`' interpretation of `ask` as sandbox escalation (which turns `never` into a denial), and only by holding `allowed-once` can the plugin remember this conversation's grant. The audit pair `approval/asked` + `approval/decided` is still written by the official service.
- **Debug calls run the real pipeline.** Panel invocations go through `ctx.tools.execute()`, so approval prompts, timeouts, and content projection all apply. They carry a `parent` token, which marks them as nested dispatches and keeps PTC mode from collapsing them. Panel debug has no agent, so the approval gate does not stop it — pressing *run* is itself the explicit grant for that call.
- **Status is derived, never faked.** `mcp-client` does not export connection state, so the panel counts registered tools under the server's prefix. Zero tools means "not connected", not "connected with nothing".

<a id="adopt-a-local-server"></a>
## Adopt a local server

The **local servers** card scans every DSH profile for `mcp-client` entries — in the profile root and in each installed plugin's bundle patch — and lists what it finds. *Adopt* copies that configuration into the panel so the server can be gated and inspected without retyping a URL, a command, or a token.

Adoption changes nothing about the connection. It is a record, not a reconnect.

<a id="backup-and-restore"></a>
## Backup and restore

**Backup, import and export** is one page, reached from the third entry under *Manage* on the home screen. Its backup section exports one JSON containing the server list, every per-tool policy, the approval master switch, and the current loader patch:

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

- **Merge** keeps existing servers and overwrites matching names.
- **Replace** clears the list first — use it to reproduce a machine exactly.
- Restores are validated: wrong `kind`, unsupported `version`, and duplicate names are rejected before anything is written.
- An older backup without an `approval` field keeps the local value on merge and falls back to follow mode on replace — "absent" is not "off".
- Call logs are deliberately excluded. They are an append-only daily stream; folding them into a backup makes the file grow without bound.

A backup carries tokens in plain text. It is a credential file, not a shareable artifact.

<a id="http-api"></a>
## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/mcp-hub/status` | per-server status, managed flag, tool counts |
| GET/POST/PUT/DELETE | `/mcp-hub/servers` | list, upsert, delete |
| GET | `/mcp-hub/test` | connect and report latency, server info, tool names |
| GET | `/mcp-hub/tools` | tool list with policy; `source` says `registry` or `dial` |
| POST | `/mcp-hub/tool-policy` | batch update enable / approval |
| GET/POST | `/mcp-hub/approval` | read the master switch, per-server modes, and official policy; write the switch / a server mode, or `action: "revoke-grants"` |
| POST | `/mcp-hub/invoke` | debug call through the real pipeline |
| GET/POST | `/mcp-hub/backup` | export, or restore with `mode` |
| GET/POST | `/mcp-hub/local` | scan adoptable servers, or adopt one |
| GET/POST | `/mcp-hub/import` | loader patch status, or write / remove it |
| GET/DELETE | `/mcp-hub/records` | call history by day |

<a id="known-limitations"></a>
## Known limitations

- Approval depends on DSH's approval channel. With no composed answerer an `ask` degrades to a denial, which is the safe default; in follow mode the plugin names "official approval service unavailable" in the denial reason instead of silently allowing.
- Session grants live in memory and die with the process. That is deliberate: a grant should not cross conversations or restarts.
- `ctx.tools.execute()` is a public method with full JSDoc but is not part of the documented "Use this package" surface of `dsh-tools`. It is verified against the shipped build; a future major version could change it.
- `mcp-client` exposes no registration events, so the panel recomputes tool lists per request instead of caching connection state.
- The loader patch stores `Authorization: Bearer <token>` in plain text. Anyone who can read the profile can read the token.

## Dev note

Source of truth: `lib/index.js` (host plugin, routes, registry adapter) and `lib/client.js` (settings pane). `config.json` and `cordis.patch.yml` are runtime data and are ignored by git.

The approval tests start no DSH; run each file with plain `node`:

```powershell
node lib/approval.test.mjs          # decision logic: follow / manual / never / fail closed
node lib/approval.routes.test.mjs   # HTTP routes and backup compatibility
node lib/approval.real.test.mjs     # against the real dsh-user-approval overrideOf fold
node lib/approval.e2e.test.mjs      # against a real ApprovalService, official audit pair
```

`approval.real.test.mjs` and `approval.e2e.test.mjs` load the official packages from the local install (see `DSH_PKGS` at the top of each file); that path needs changing on another machine.
