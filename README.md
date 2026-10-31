---
description: "MCP multi-server console for DSH — test, adopt, gate, and back up every MCP server from one panel, with approvals that follow DSH's own policy."
kind: "plugin-reference"
---

# dsh-mcp-hub

**Author**: xunyyds

English | [中文](README.zh.md)

---

## What is this?

In one line: **a console for every MCP server in DSH**.

Connection tests, tool listings, per-tool toggles, approval prompts, config backups — all in one panel. HTTP servers and local stdio servers are treated the same, so you never build two habits for two transports.

It ships one thing most consoles do not: **MCP tool schemas no longer live in the prompt**. One 207-tool server measures about 770 KB (≈210k tokens) of schema, and every turn used to pay that again. With this plugin only a single tool name stays resident; everything else unfolds on demand.

And one hard line: **it never takes over the connection**. stdio servers and anything already registered in DSH are managed through the `ctx.tools` registry, so `mcp-client` remains the connection owner. The panel only reads the registry, which is why a stdio server shows live tools instead of "unsupported".

---

## 📂 Project layout

```
dsh-mcp-hub/
├── lib/
│   ├── index.js                        # host plugin: routes, approval wiring, registry adapter, credential store
│   ├── client.js                       # settings pane (cordis front end — the whole UI lives in this one file)
│   ├── gateway.js                      # context-budget gateway + the mcp_hub_tools three-tier retrieval tool
│   ├── context-budget.js               # tier normalization, first-sentence summaries, BM25 ranking, meta-tool test (pure)
│   ├── capability-index.js             # auto-generated capability summaries: tokenize → drop generic → features → render + hash cache
│   ├── jit-hint.js                     # JIT trigger hints: per-turn signals → server nudge, with hard throttling
│   ├── capability-index.test.mjs       # index build, generic-word removal, render determinism, broken-cache fallback
│   ├── jit-hint.test.mjs               # signal extraction, throttle state machine, relief, per-session isolation
│   ├── retrieval.corpus.mjs            # offline eval corpus: real tool-catalog snapshot + 100 task phrasings
│   ├── retrieval.eval.test.mjs         # recall@3 gate (stops retrieval decaying as tools grow)
│   ├── integration.capabilities.test.mjs # end-to-end regression once the three modules are wired into index.js
│   ├── gateway.tiers.test.mjs          # three tiers, reveal-on-load, output-schema consistency guard
│   ├── gateway.regression.test.mjs     # tier/disable decision order, body rendering, summary splitting
│   ├── gateway.acceptance2.test.mjs    # miss-fallback cost, offline servers, zero-arg test, meta tools
│   └── tiers.e2e.test.mjs              # request shape and prompt catalog under the real apply()
├── cordis.patch.yml                    # loader patch (runtime data, git-ignored)
├── MARKETPLACE.md                      # marketplace copy and terminology rules
├── README.md / README.zh.md            # the two files you are reading
└── package.json                        # engines.dsh, files allowlist, npm test
```

> `config.json` and `cordis.patch.yml` are **runtime data** and sit in `.gitignore`.
> Both carry plaintext tokens — never commit them, and never treat a backup as a shareable artifact.

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

   A restart is required before the **MCP Hub** settings pane appears. Server-side code changes work the same way — the panel's *reconnect* only redials MCP servers, it **does not reload plugin code**.

3. **Add a server**

   Press *Add* and fill in a URL or a command, or use **quick import**: paste an `mcpServers` JSON object, a bare URL, a `cordis.patch.yml` fragment, or a `stdio` entry, then press *parse and fill*. Parsing **writes nothing** — saving stays an explicit click, so a bad paste cannot silently overwrite a working server.

4. **Use the panel**

   - **Servers**: connection test, latency, tool counts, per-tool enable/disable
   - **Approval**: one master switch plus a three-state override per server, following DSH by default
   - **Gateway & catalog**: tune the four `mcp_hub_tools` parameters; the preview is byte-identical to what the model receives
   - **Local servers**: scan existing `mcp-client` entries across profiles and adopt one into the panel
   - **Backup, import and export**: the whole setup as a single portable JSON
   - **Call logs**: per-day record of every call — tool, arguments, approval decision, latency, outcome

---

## 🪙 Context budget: three tiers on demand

This is where the token savings come from, and where the most lessons were learned.

The system prompt keeps exactly **one resident MCP tool name, `mcp_hub_tools`**, plus a catalog listing only **server names and per-server tool counts**. Tool names and schemas unfold per tier:

| Tier | Call | Returns | Cost |
|---|---|---|---|
| 1 | `mcp_hub_tools()` | server names + tool count each | independent of total tool count |
| 2 | `mcp_hub_tools({ server: "windows" })` | that server's tool names + one-line summaries | only this server |
| 3 | `mcp_hub_tools({ names: ["mcp__windows__Screenshot"] })` | full parameter schema for those tools | only those tools |

`mcp_hub_tools({ query: "capture" })` searches across servers by keyword at any time; hits return names and summaries only.

Several deliberate trade-offs, each one taught by a field incident:

- **A miss never dumps the full tool list.** The early fallback listed every tool name when `query` found nothing: at 262 tools one typo emitted 200 lines — about 25× the cost of an 8-hit result — and truncation would silently swallow whole servers. A miss now returns a **server-level summary** pointing at `server=` expansion, so cost stays independent of tool count.

- **Retrieval reveals the tool.** Dropping a schema only changes what the model *sees*; execution still resolves by name from the registry. But a well-behaved model will not call a tool absent from the `tools` array — it assumes it is unavailable and **retrieves the same name forever**. So after a successful `names` call the tool re-enters the callable list on the next assembly (cap 32, oldest evicted).

- **Name typos are corrected automatically.** A slip like `mcp_rea__open_binary` used to get back one line, "name not found", leaving the model no way to infer the difference but to retry. Now, when normalization matches exactly one catalog entry, it is resolved and the correction is stated; when ambiguous, the nearest real names are listed.

- **The zero-argument label prefers under-claiming.** Tier 2 marks tools that are provably argument-free as "no arguments, call directly" to skip a `names` round-trip. The test requires all three: confirmed `type:"object"` + empty `properties` + no `required`. The registry fills some tools' schemas lazily, so an empty `properties` alone would mislabel a tool with a **required** argument — and trusting that label costs a validation failure, more than the round-trip it saved.

- **Oversized schemas degrade honestly.** A schema above roughly 16 KB becomes a shallow view of "parameter name + type + required", and **required parameters are kept first — optional ones are dropped**. Dropping a required parameter would guarantee a failed call.

- **Offline servers are explained.** The runtime context may list 5 servers while the retrieval pool holds 3; that gap is not an error, two of them are unreachable. `mcp_hub_tools` reports them with their reason (e.g. `qfun: fetch failed`) so the model does not suspect a different problem.

- **Meta tools do not occupy retrieval slots.** Upstream "list more tools" switches such as `get_more_tools` stay out of the pool — listing them only makes the model bounce between this plugin's tiers and the server's own catalog. They remain callable by explicit name.

**Only the `off` tier disables a server.** `full` and `lazy` are now equivalent — both mean "unfold on demand"; the `full` name survives only for config compatibility. Server-disabled, tool-disabled, and `off` all feed one `blockReason`: gone from the prompt, refused at execution, and unretrievable. The panel can never say "disabled" while the model can still call it.

### Capability summaries: no prompt to write, new servers grow their own

The feature words after each server name are **computed from tool metadata**, not hand-written copy:

```
Servers: mobile (33 tools): logs·clipboard·click·crash·screenshot, rea (7 tools): function·binary·symbol·disassemble·compare
```

That distinction is the pivot of the whole design. Hand-written routing copy rots in two ways: tools grow, or a new server arrives — and the copy does not follow, so the model **forgets that machine exists**. Feature words are derived by three steps of statistics:

1. **Tokenize**: tool-name snake_case, full descriptions, parameter names three levels deep; mixed Chinese and English
2. **Drop generic words**: judged by "appears in 80%+ of servers" (not a hard-coded denylist — denylists expire with the next server), plus a slot test: in the `verb_object` naming convention the head slot is the verb and the tail is the capability, which sinks `list`/`get`/`open` and lifts `install`/`click`/`swipe`
3. **Bilingual bridge**: `screenshot→截图`, `crash→崩溃`, `logcat→日志`, so English tool names still yield Chinese summaries

Each server costs 15–20 tokens per line; above 8 servers it compresses into a grouped summary plus a retrieval hint. The index is cached to `storages/mcp-hub/capability-index.json` keyed by a signature hash: **signature unchanged reuses the disk copy, changed rebuilds, corrupt recomputes** — all three fallbacks are non-throwing, so a stale index never blocks startup.

You can turn it off on the **Gateway & catalog** page (losing the words, not the catalog).

### Retrieval: BM25 + capability weighting, Chinese no longer a zero-hit

The `mcp_hub_tools({ query })` ranking core was rewritten after this measured failure:

```
old tokenize("反汇编 so 符号 调试") → ["so"]        ← Chinese was entirely dropped by /[^a-z0-9]+/
old top-1 → compare_source_to_bundle               ← merely contained "so" in prose
```

With all Chinese dropped, only tools whose descriptions happened to contain a substring could surface. Today:

- **CJK is cut into 2-grams**; mixed queries yield meaningful terms, and `tokenize` keeps its signature and return type (a strict superset — no English term lost)
- **BM25 scoring**, idf computed per current catalog; field weights name 3 > params 1.2 > summary 1
- **Capability bonus**: a capability word hit in the *tool name* gets 1.5×, and that bonus only applies to names — prose mentions can no longer float to the top
- **Bidirectional bridge**: `崩溃→crash` and `crash→崩溃` both work

Measured afterwards: top-3 for `反汇编 so 符号 调试` all land in rea; top-1 for `进游戏卡死了拿崩溃栈` is `mobile_get_crash`.

**This is gated, not vibes.** `lib/retrieval.corpus.mjs` holds 100 task phrasings (half Chinese, half English, each with expected server/tool) and `retrieval.eval.test.mjs` runs offline retrieval against `recall@3 ≥ 0.8`:

| Metric | Measured |
|---|---|
| recall@3 (full corpus) | 0.980 (98/100) |
| recall@3 (Chinese subset) | 0.964 (53/55) |

The Chinese subset gets its own threshold because the old implementation was hidden behind "English all correct" — a total-only gate cannot see Chinese collapse.

### JIT trigger hints: one line at the right moment

The catalog answers "which servers do I have"; "which one applies *right now*" is a different question. Real incident: during one task the model pushed a 40MB `libil2cpp.so`, ran `adb` dozens of times, and pulled a `tombstone` — while `mobile_get_crash` was never considered. Every signal was on screen; what was missing was the hop from signal to tool.

When enabled (**off by default**), each turn extracts signals from "the user's recent words + the last few commands/paths" and appends one line on a trigger hit:

```
Hint: mobile has 33 log/screenshot tools; use mcp_hub_tools(query="logs") to see them
```

Its main risk is becoming noise, so throttling is hard:

- **At most 1 per turn**, **at most 1 per server per session**, **at most N per session** (default 3)
- The same signal text never produces a second hint (otherwise one sentence gets repeated by a different server)
- **Saying "can't find a tool / no such tool" lifts the above** — that sentence literally means "tell me again" — while still capping at 1 per turn so one stuck moment cannot flood
- State is per session, and `so` inside `also` / `so that` never triggers (`so` only counts as a file extension)

Injection goes through the official `ctx.systemPrompt.context()` (same layer as working directory and sandbox policy, recomputed each turn) rather than hand-assembling user messages. There is one trap the integration test pins: **runtime-context snapshots must never be read back as next-turn signals**, or a hint written into context becomes its own signal and the hint self-perpetuates.

### Gateway parameters

The **Gateway & catalog** page tunes the four `mcp_hub_tools` parameters; saving takes effect on the next request (config is read per execution, no restart):

| Parameter | Default | Range | Effect |
|---|---|---|---|
| `searchLimit` | 8 | 1–20 | max hits per retrieval |
| `catalogLimit` | 200 | 1–500 | tool names listed when a retrieval found nothing usable |
| `schemaMaxBytes` | 16000 | 2000–128000 | byte budget per retrieved schema, above which it degrades |
| `loadBatchMax` | 12 | 1–50 | max tools per `names` call |

These travel with the plugin backup (the `gateway` field); an older backup without the field keeps local values on merge and resets to defaults on replace.

Three more **catalog and hint** switches:

| Switch | Default | Effect |
|---|---|---|
| `catalog.capabilities` | on | whether to append auto-generated feature words after each server name |
| `hint.enabled` | **off** | master switch for JIT trigger hints |
| `hint.maxTotal` / `hint.maxPerServer` | 3 / 1 | per-session total hint cap / per-server cap |

All of these travel with the plugin backup (`gateway` / `catalog` / `hint` fields); older backups without them keep local values on merge and reset to defaults on replace.

---

## ✅ Approval

The **Approval** page has one master switch and a three-state override per server. The default is **follow DSH**.

**Following means consuming the official seam, not imitating it**: the same `ctx.approval`, the same `ask` / `never` folding, the same approval panel, the same `allowed-once` / `rejected` / `cancelled` / `unavailable` vocabulary. The "deployment default policy" and "current permission preset" shown in the panel are read from the official service, not recomputed here.

The card has three buttons:

| Button | Effect |
|---|---|
| Reject | this call does not run |
| Allow once | this call only; the next one asks again |
| Allow for this conversation | runs this call and remembers the tool for the rest of the conversation |

"Allow for this conversation" is a single click: the grant is written first, then the call is released. It expires on a new conversation or a DSH restart — grants live on the session, never in config, so opening a fresh conversation can never silently skip a prompt. The page lists current session grants and offers *clear grants*.

Granularity is the **tool**, not the server: approving `send_msg` does not release `get_skey` on the same server. Per-server memory would let one approval of a read-only tool unlock that server's entire surface, while the prompt the user saw named only that one action.

**The model is told what happened.** Approval happens in the UI and was previously invisible to the model — it could not distinguish "the user clicked Allow once" from "this tool never asks". Every approved call now ends with a receipt appended to the result body (emitted in Chinese, matching the panel's language), and the receipt matches the button that was actually pressed:

```
[审批：本次已由用户允许一次（下次仍会询问）]
[审批：本次已允许，并记住该工具，本对话内下次不再询问]
```

The first is *Allow once*; the second is *Allow for this conversation*. When a grant already exists and no prompt was shown, the receipt is `[审批：本对话内已授权，本次未再次询问]`.

**Unreadable policy denies.** Without `@deepseek-ai/dsh-user-approval`, or when the official request itself fails, the call fails closed, and both the error text and the DSH log say why. Nothing is silently allowed.

This card takes over approvals for the `mcp__` prefix only; everything else stays with the official panel. It is a runtime-registered slot, so uninstalling restores the original UI — **no DSH file is modified**.

---

## 📦 Adoption, backup, and logs

The **Local servers** card scans every DSH profile for `mcp-client` entries — profile root and each installed plugin's bundle patch — and lists their sources. *Adopt* copies that configuration into the panel so it can be gated and inspected without retyping a URL, a command, or a token. Adoption changes nothing about the connection: it is a record, not a reconnect.

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

**Call logs** record per day the tool, arguments, approval decision, latency, outcome, and raw error for every call. The `ok` field reflects the **final** outcome — including failures this plugin itself causes — so a green log can no longer hide a broken path.

---

## 🔌 HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/mcp-hub/status` | per-server status, managed flag, tool counts (12s poll, no credentials) |
| GET/POST/PUT/DELETE | `/mcp-hub/servers` | list, upsert, delete |
| GET | `/mcp-hub/test` | connect and report latency, server info, tool names |
| GET | `/mcp-hub/tools` | tool list with policy; `source` says `registry` or `dial` |
| POST | `/mcp-hub/tool-policy` | batch update enable / approval |
| GET/POST | `/mcp-hub/budget` | read tiers and bridge tool name; write one server or all |
| GET/POST | `/mcp-hub/gateway` | read/write gateway params and tool catalog, with a byte-exact preview |
| GET/POST | `/mcp-hub/approval` | read master switch, per-server modes, official policy; write switch / mode, `action:"grant"` for one session grant, `action:"revoke-grants"` to clear |
| GET | `/mcp-hub/pending` | resolve the pending MCP tool by `callId` |
| POST | `/mcp-hub/invoke` | debug call through the real pipeline |
| GET/POST | `/mcp-hub/backup` | export, or restore with `mode` |
| GET/POST | `/mcp-hub/local` | scan adoptable servers, or adopt one |
| GET/POST | `/mcp-hub/import` | loader patch status, or write / remove it |
| GET/DELETE | `/mcp-hub/records` | call history by day |

**Credential access boundary.** `/servers` returns the plaintext token (the editor must refill the input), and `/backup` and `/import` return full text containing tokens and Authorization headers. Those three serve full content only to **loopback same-origin requests**:

- the request `Host` must be a loopback address (`127.0.0.1` / `[::1]` / `localhost`);
- when `Sec-Fetch-Site` is present it must be `same-origin` / `none` (cross-site pages are rejected);
- when `Origin` is present its host must also be loopback.

Reaching the panel over a LAN address still manages servers normally, but yields no stored credentials (`_token` omitted, `credentialVisible: false`), and `/backup` and `/import` return 403. So even if the web server is rebound to a LAN interface (remote-web-ui and similar), **the port stops being the boundary of who can read the keys**.

---

## 🧠 Implementation

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

- **Connection ownership never moves.** `mcp-client` owns every stdio connection and every registered server. The panel reads the registry rather than opening a second connection.
- **Policy has two layers.** `tools/pre-execute` decides allow / ask and is an extensible waterfall a later listener could reverse; `ctx.tools.guard()` runs after it and cannot be reversed — a tool disabled in the panel is denied there.
- **Approval consumes the official seam instead of delegating the ask.** In follow mode the plugin does not return `{kind:'ask'}` and let `dsh-tools` ask; it calls `ctx.approval.request()` itself and maps the official outcome back to `allow` / `deny` / `cancel`. Two reasons make this necessary: it avoids `dsh-tools`' interpretation of `ask` as sandbox escalation (which turns `never` into a denial), and only by holding `allowed-once` can the plugin remember this conversation's grant. The audit pair `approval/asked` + `approval/decided` is still written by the official service.
- **Debug calls run the real pipeline.** Panel invocations go through `ctx.tools.execute()`, so approval prompts, timeouts, and content projection all apply. They carry a `parent` token, marking them as nested dispatches so PTC mode does not collapse them. Panel debug has no agent, so the approval gate does not stop it — pressing *run* is itself the explicit grant.
- **Status is derived, never faked.** `mcp-client` does not export connection state, so the panel counts registered tools under the server's prefix. Zero tools means "not connected", not "connected with nothing".
- **Tool names stay native.** Always `mcp__<serverName>__<rawName>`, so session history and permission rules survive restarts.

---

## 🧪 Tests

```sh
npm test
```

Eight files in sequence, **154 cases** total:

| File | Cases | Covers |
|---|---|---|
| `lib/gateway.tiers.test.mjs` | 23 | three tiers and the cost promise, reveal-on-load, name correction, output-schema consistency guard |
| `lib/gateway.regression.test.mjs` | 15 | tier/disable decision order, body rendering, summary splitting, legacy callers |
| `lib/gateway.acceptance2.test.mjs` | 13 | miss-fallback cost, offline servers, zero-argument test, meta-tool test |
| `lib/capability-index.test.mjs` | 45 | signature stability and sensitivity, generic-word removal is not a denylist, slot test, render determinism, broken-cache fallback |
| `lib/jit-hint.test.mjs` | 33 | signal extraction (including the `also` false-positive pin), throttle state machine, relief, per-session isolation |
| `lib/retrieval.eval.test.mjs` | 11 | recall@3 gate, Chinese subset, bidirectional bridge, capability weight above prose |
| `lib/integration.capabilities.test.mjs` | 10 | summaries really reach the prompt, switching off really removes them, hint throttling, **hints never self-perpetuate** |
| `lib/tiers.e2e.test.mjs` | 4 | request shape and prompt-catalog stability under the real `apply()` |

Key guards are **mutation-verified**: reintroducing a fixed bug must turn the matching assertion red immediately. That practice caught a case of "28 tests green while an entire path failed in production" — because the tests only asserted a function's return value and never validated it against the registered output schema.

Retrieval quality is guarded differently: instead of pinning "what a function returns", it pins the **hit rate across 100 real task phrasings**. Adding a server or changing the scoring weights runs it automatically, so ranking decay shows up immediately — without it, the index and the prompt slowly drift back to "I forgot that exists".

---

## ⚠️ Known limitations

- Approval depends on DSH's approval channel. With no composed answerer an `ask` degrades to a denial, which is the safe default.
- Session grants live in memory and die with the process. That is deliberate: a grant should not cross conversations or restarts.
- **Server-side code changes do not hot-reload.** After editing `lib/*.js` you must restart DSH; the panel's *reconnect* only redials MCP servers and never reloads gateway code.
- **Retrieval is lexical, not semantic.** Words that appear in tool names (`capture`, `screenshot`) hit best; a purely conceptual query ("the thing that edits files") may miss — you then get the server-level summary and can rephrase or expand with `server=`.
- **Reveal-on-load only matters to models that respect the `tools` array.** A model tolerant of out-of-list calls sees no difference, so its real payoff awaits such a session.

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
