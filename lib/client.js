window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-mcp-hub",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;
		// 官方审批面板用 @deepseek-ai/dsh-client-ui-primitives 的 Button 渲染
		// 「拒绝 / 允许一次」。拿同一个组件来渲染我们的按钮，视觉上才真的是
		// 卡片里的第三个按钮，而不是一个长得像的外来控件。
		// 拿不到就退回普通 button——面板不该因为这一个依赖缺失整块崩掉。
		let primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (e) {
			primitives = null;
		}
		const NativeButton = (props) => {
			if (primitives && primitives.Button) return h(primitives.Button, props, props.children);
			return h("button", {
				className: "qfm-btn" + (props.variant === "primary" ? " primary" : ""),
				disabled: props.disabled,
				onClick: props.onClick
			}, props.children);
		};

		const css = [
			".qfm-root{display:flex;flex-direction:column;gap:14px;max-width:640px;color:var(--dsw-alias-label-primary);font-size:13px}",
			".qfm-card{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px}",
			".qfm-card h2{margin:0;font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px}",
			".qfm-sub{margin:0;color:var(--dsw-alias-label-tertiary);line-height:1.55;font-size:12px}",
			".qfm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
			".qfm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}",
			".qfm-stat{background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:2px;min-width:0}",
			".qfm-stat b{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".qfm-stat span{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
			".qfm-field{display:flex;flex-direction:column;gap:6px;min-width:0}",
			".qfm-field>span{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}",
			".qfm-input,.qfm-select,.qfm-ta{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 11px;font:inherit;font-size:13px;min-height:34px;width:100%;box-sizing:border-box}",
			".qfm-ta{min-height:80px;font-family:ui-monospace,Consolas,monospace;font-size:12px;resize:vertical}",
			".qfm-input:focus-visible,.qfm-ta:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".qfm-btn{font:inherit;font-size:12.5px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:8px 13px;cursor:pointer;white-space:nowrap}",
			".qfm-btn:hover{border-color:var(--dsw-alias-brand-primary)}",
			".qfm-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}",
			".qfm-btn.danger{color:var(--dsw-alias-state-error-primary,#c62828);border-color:var(--dsw-alias-border-l4,#e6b0aa)}",
			".qfm-btn:disabled{opacity:.5;cursor:not-allowed}",
			".qfm-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 11px;font-size:11.5px;font-weight:600;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}",
			".qfm-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
			".qfm-pill.on .qfm-dot{background:#2eaa5e;box-shadow:0 0 6px #2eaa5e88}",
			".qfm-pill.warn .qfm-dot{background:#e6a23c}",
			".qfm-pill.off .qfm-dot{background:#c0504d}",
			".qfm-msg{font-size:12px;line-height:1.5;white-space:pre-wrap;margin:0;color:var(--dsw-alias-label-secondary)}",
			".qfm-msg.ok{color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%, var(--dsw-alias-label-primary))}.qfm-msg.err{color:var(--dsw-alias-state-error-primary,#c62828)}",
			".qfm-tools{display:flex;flex-direction:column;gap:6px;max-height:420px;overflow:auto;padding-right:4px}",
			".qfm-tool{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:8px 10px;display:flex;flex-direction:column;gap:6px}",
			".qfm-tool.off{opacity:.55}",
			".qfm-tool-head{display:flex;align-items:center;gap:8px}",
			".qfm-tool-name{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;font-weight:600;cursor:pointer;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".qfm-tool-name:hover{color:var(--dsw-alias-brand-primary)}",
			".qfm-tool-desc{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".qfm-sw{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;white-space:nowrap}",
			".qfm-sw input{accent-color:var(--dsw-alias-brand-primary);width:14px;height:14px;cursor:pointer;margin:0}",
			".qfm-detail{border-top:.5px dashed var(--dsw-alias-border-l4);padding-top:8px;display:flex;flex-direction:column;gap:8px}",
			".qfm-pre{background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto;margin:0;color:var(--dsw-alias-label-secondary)}",
			".qfm-chips{display:flex;flex-wrap:wrap;gap:6px}",
			".qfm-chip{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:4px 10px;font-size:11.5px;cursor:pointer}",
			".qfm-chip[data-active=true]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}",
			".qfm-chip .x{opacity:.65;font-weight:700}",
			".qfm-chip .x:hover{opacity:1;color:var(--dsw-alias-state-error-primary,#c62828)}",
			".qfm-records{display:flex;flex-direction:column;gap:5px;max-height:360px;overflow:auto;padding-right:4px}",
			".qfm-rec{border:.5px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);padding:7px 10px;display:flex;flex-direction:column;gap:4px;cursor:pointer}",
			".qfm-rec-line{display:flex;gap:8px;align-items:center;font-size:11.5px;min-width:0}",
			".qfm-rec-tool{font-family:ui-monospace,Consolas,monospace;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".qfm-badge{border-radius:5px;padding:1px 6px;font-size:10px;font-weight:600;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}",
			".qfm-badge.ok{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 72%, var(--dsw-alias-label-primary))}",
			".qfm-badge.err{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);color:var(--dsw-alias-state-error-primary,#c62828)}",
			".qfm-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center;padding:18px 0}",
			".qfm-adv{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px}",
			".qfm-adv summary{cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".qfm-head{display:flex;align-items:center;gap:10px;margin:0}",
			".qfm-head h2{margin:0;flex:1;min-width:0}",
			".qfm-back{border:none;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;font-size:12.5px;padding:4px 6px;border-radius:7px}",
			".qfm-back:hover{background:var(--dsw-alias-bg-layer-3)}",
			".qfm-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}",
			".qfm-tile{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:6px;cursor:pointer;transition:border-color .15s}",
			".qfm-tile:hover{border-color:var(--dsw-alias-brand-primary)}",
			".qfm-tile-top{display:flex;align-items:center;gap:8px;min-width:0}",
			".qfm-tile-name{font-weight:650;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}",
			".qfm-tile-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);display:flex;gap:10px;flex-wrap:wrap}",
			".qfm-nav{display:flex;flex-direction:column;gap:6px}",
			".qfm-nav-item{display:flex;align-items:center;gap:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:11px;padding:11px 13px;cursor:pointer;font-size:13px}",
			".qfm-nav-item:hover{border-color:var(--dsw-alias-brand-primary)}",
			".qfm-nav-item .grow{flex:1;min-width:0}",
			".qfm-nav-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px}",
			".qfm-crumb{font-size:11.5px;color:var(--dsw-alias-label-tertiary);display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
			".qfm-log-item{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:9px 11px;display:flex;flex-direction:column;gap:5px;cursor:pointer}",
			".qfm-log-item:hover{border-color:var(--dsw-alias-brand-primary)}",
			".qfm-time{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".qfm-chev{color:var(--dsw-alias-label-tertiary);font-size:16px;line-height:1;margin-left:2px}",
			".qfm-tool{transition:border-color .15s}.qfm-tool:hover{border-color:var(--dsw-alias-brand-primary)}",
			".qfm-tool.active{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-2))}",
			".qfm-embedded{display:flex;flex-direction:column;gap:10px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px;margin-top:4px}",
			".qfm-grantbar{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;padding-top:2px}",
			".qfm-grantbar-text{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);flex:1;min-width:0}",
			// MCP 审批卡片：套用官方审批卡片的视觉语言（同样的 warn 色带、
			// 同样的圆角与阴影、同样的动作行右对齐），让它是「原生卡片多一个按钮」，
			// 而不是叠在上面的外来浮层。
			".qfm-appr-root{padding:8px calc(var(--dsh-composer-side-clearance) + 16px) 12px;display:flex;flex-direction:column;align-items:center}",
			".qfm-appr-card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-state-warn-secondary);border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);overflow:hidden}",
			".qfm-appr-strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);display:flex;align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px}",
			".qfm-appr-dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor}",
			".qfm-appr-body{display:flex;flex-direction:column;gap:6px;padding:12px 16px 0}",
			".qfm-appr-headline{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:24px;font-family:ui-monospace,Consolas,monospace}",
			".qfm-appr-reason{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;word-break:break-all}",
			".qfm-appr-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;opacity:.85}",
			".qfm-appr-actions{display:flex;justify-content:flex-end;gap:8px;padding:14px 16px}"
		].join("\n");

		if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"dsh-mcp-hub\"]")) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@dsh-external/dsh-mcp-hub";
			tag.dataset.pluginCss = "dsh-mcp-hub";
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const state = {
			status: null,
			servers: [],
			activeId: "",
			draft: null,
			profile: "",
			view: "home",
			approval: { followDsh: true },
			approvalInfo: null,
			grants: [],
			logServer: "",
			logDays: [],
			logServers: [],
			showToken: false,
			tools: [],
			toolsLoading: false,
			imp: null,
			days: [],
			records: [],
			day: "",
			search: "",
			expanded: "",
			recExpanded: -1,
			busy: false,
			msg: "",
			msgTone: "",
			cfgError: "",
			debugArgs: {},
			debugResult: {},
			importText: "",
			importPending: null,
			importError: "",
			importWarn: [],
			invokeBusy: "",
			gateway: null,
			gatewayDraft: null,
			catalogDraft: null,
			hintDraft: null,
			localServers: [],
			backupMode: "merge",
			quickText: "",
			quickError: "",
			quickWarn: [],
			quickPending: null,
			quickOpen: false,
			confirmKey: "",
			confirmAt: 0,
			importDirty: false,
			credentialVisible: true
		};
		const listeners = new Set();
		const publish = () => {
			for (const fn of Array.from(listeners)) {
				try { fn(); } catch (e) {}
			}
		};
		const setMsg = (msg, tone) => {
			state.msg = msg;
			state.msgTone = tone || "";
			// 成功提示 6 秒后自动消退：留在原地只会盖住下面的内容，
			// 也分不清是「刚发生的」还是「三分钟前的旧消息」。错误不消退，
			// 用户需要时间读原因。
			if (state.msgTimer) {
				clearTimeout(state.msgTimer);
				state.msgTimer = 0;
			}
			if (state.msgTone === "ok" && typeof setTimeout === "function") {
				state.msgTimer = setTimeout(() => {
					if (state.msg === msg) {
						state.msg = "";
						state.msgTone = "";
						state.msgTimer = 0;
						publish();
					}
				}, 6000);
			}
			publish();
		};

		async function api(path, options) {
			const res = await fetch(path, {
				method: (options && options.method) || "GET",
				headers: { "Content-Type": "application/json" },
				body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined,
				cache: "no-store"
			});
			const text = await res.text();
			try {
				return JSON.parse(text);
			} catch {
				return { ok: false, error: "响应解析失败: " + text.slice(0, 120) };
			}
		}

		async function loadStatus() {
			try {
				const s = await api("/mcp-hub/status");
				state.status = s;
				// 轮询返回的是连接状态，不含凭证。整体替换会把手里的 _token 冲掉，
				// 于是「先刷新、再点编辑」就得到空 Token 输入框——正是要修的那个 bug。
				// 所以按 id 合并：连接态取新值，凭证沿用已知值。
				state.servers = mergeServers((s && s.servers) || []);
				state.profile = (s && s.profile) || "";
				if (!state.activeId && state.servers.length) state.activeId = state.servers[0].id;
				const active = state.servers.find((x) => x.id === state.activeId);
				// 编辑器开着时不覆盖草稿：用户在输入框里的未保存改动会被轮询冲掉。
				// 只有还没进入编辑（draft 为空）时才从快照建一份。
				if (active && !state.draft) state.draft = draftOf(active);
				publish();
			} catch (e) {}
		}

		// 保留旧条目上的可编辑字段（凭证、原始名），其余用新快照覆盖。
		function mergeServers(incoming) {
			const prev = new Map((state.servers || []).map((x) => [x.id, x]));
			return incoming.map((s) => {
				const old = prev.get(s.id);
				if (!old) return s;
				const merged = Object.assign({}, s);
				if (merged._token === undefined && old._token !== undefined) merged._token = old._token;
				// tokenConfigured 必须以宿主这次的回答为准。旧实现无条件沿用
				// 旧值，于是「清除 Token」之后面板还显示「已保存」，
				// 看起来像清除失败，而下次保存也不再发显式清空。
				if (s.tokenConfigured === undefined) merged.tokenConfigured = old.tokenConfigured === true;
				else merged.tokenConfigured = s.tokenConfigured === true || (s._token !== undefined && !!s._token);
				if (s.tokenUnreadable === undefined) merged.tokenUnreadable = old.tokenUnreadable === true;
				return merged;
			});
		}

		function draftOf(s) {
			return {
				id: s.id || "",
				name: s.serverName || s.name || "mcp",
				transport: s.transport === "stdio" ? "stdio" : "streamable-http",
				url: s.url || "",
				// 配置路由会带上 _token（明文，只在这条路径上），status 轮询不带。
				// 两者都读，才能在「打开编辑器」和「轮询刷新」时都不丢已保存的值。
				token: s._token !== undefined && s._token !== null ? s._token : (s.token || ""),
				tokenConfigured: !!(s.tokenConfigured || s._token),
				tokenUnreadable: !!s.tokenUnreadable,
				command: s.command || "",
				argsText: Array.isArray(s.args) ? s.args.join("\n") : "",
				envText: s.env && typeof s.env === "object"
					? Object.keys(s.env).map((k) => k + "=" + s.env[k]).join("\n")
					: "",
				autoReconnect: s.autoReconnect !== false,
				enabled: s.enabled !== false,
				approvalMode: s.approvalMode || "inherit",
				toolCallTimeoutMs: s.toolCallTimeoutMs || 60000
			};
		}

		function draftToServer(d, opts) {
			const args = String(d.argsText || "").split("\n").map((x) => x.trim()).filter(Boolean);
			const env = {};
			for (const line of String(d.envText || "").split("\n")) {
				const t = line.trim();
				if (!t) continue;
				const i = t.indexOf("=");
				if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
			}
			const out = {
				id: d.id || undefined,
				name: d.name,
				transport: d.transport,
				url: d.url,
				command: d.command,
				args,
				env,
				autoReconnect: d.autoReconnect,
				enabled: d.enabled,
				approvalMode: d.approvalMode || "inherit",
				toolCallTimeoutMs: Number(d.toolCallTimeoutMs) || 60000
			};
			// Token 有三态，不能一律发送空串：
			//   用户填/改过 → 发这个值
			//   输入框为空但已保存过凭证 → 什么都不发，让宿主保留原值
			//   点过「清除」 → 发空串，真的要清掉
			if (opts && opts.clearToken) out.token = "";
			else if (d.token) out.token = d.token;
			else if (!d.tokenConfigured) out.token = "";
			return out;
		}

		async function loadConfig() {
			try {
				const r = await api("/mcp-hub/servers");
				if (r && r.ok) {
					state.credentialVisible = r.credentialVisible !== false;
					state.servers = mergeServers(r.servers || []);
					state.profile = r.profile || "";
					if (!state.activeId && state.servers.length) state.activeId = state.servers[0].id;
					if (!state.draft) {
						const active = state.servers.find((x) => x.id === state.activeId);
						if (active) state.draft = draftOf(active);
					}
					state.cfgError = "";
					publish();
					// 配置变了，之前生成的那份 mcpServers JSON 就过期了。
					// 只按「是否为空」决定要不要重建的话，改完服务器再点「复制 JSON」
					// 会复制一份已经不存在的配置——恰恰是这个功能要防的事。
					if (!state.importText || state.importDirty) {
						state.importDirty = false;
						actions.genJson();
					}
				} else if (r && r.error) {
					state.cfgError = "读取插件配置失败：" + r.error;
					publish();
				}
			} catch (e) {
				state.cfgError = "读取插件配置失败：宿主服务未响应（" + (e && e.message ? e.message : e) + "）";
			}
		}

		async function loadTools(fresh) {
			state.toolsLoading = true;
			publish();
			try {
				const q = [];
				if (fresh) q.push("fresh=1");
				if (state.activeId) q.push("server=" + encodeURIComponent(state.activeId));
				const r = await api("/mcp-hub/tools" + (q.length ? "?" + q.join("&") : ""));
				if (r && r.ok) {
					state.tools = r.tools || [];
					if (fresh) setMsg("已同步 " + state.tools.length + " 个工具", "ok");
				} else if (r && r.error) {
					setMsg("拉取工具失败: " + r.error, "err");
				}
			} catch (e) {
				setMsg("拉取工具失败: " + e.message, "err");
			}
			state.toolsLoading = false;
			publish();
		}

		async function loadApproval() {
			try {
				const r = await api("/mcp-hub/approval");
				if (r && r.ok) {
					state.approval = r.approval || { followDsh: true };
					state.approvalInfo = r.dsh || null;
					state.grants = r.grants || [];
					publish();
				}
			} catch (e) {}
		}

		async function loadGateway() {
			try {
				const r = await api("/mcp-hub/gateway");
				if (r && r.ok) {
					state.gateway = r;
					if (!state.gatewayDraft) {
						state.gatewayDraft = {
							searchLimit: String(r.searchLimit || 8),
							catalogLimit: String(r.catalogLimit || 200),
							schemaMaxBytes: String(r.schemaMaxBytes || 16000),
							loadBatchMax: String(r.loadBatchMax || 12),
							revealMax: String(r.revealMax === undefined ? 0 : r.revealMax)
						};
					}
					if (!state.catalogDraft) {
						const c = r.catalog || {};
						state.catalogDraft = {
							enabled: c.enabled !== false,
							mode: c.mode || "names",
							limit: String(c.limit || 200),
							capabilities: c.capabilities !== false
						};
					}
					if (!state.hintDraft) {
						const hb = r.hint || {};
						state.hintDraft = {
							enabled: hb.enabled === true,
							maxTotal: String(hb.maxTotal === undefined ? 3 : hb.maxTotal),
							maxPerServer: String(hb.maxPerServer === undefined ? 1 : hb.maxPerServer)
						};
					}
					publish();
				}
			} catch (e) {}
		}

		async function loadImport() {
			try {
				const r = await api("/mcp-hub/import");
				if (r && r.ok) {
					state.imp = r;
					publish();
				}
			} catch (e) {}
		}

		async function loadLocal() {
			try {
				const r = await api("/mcp-hub/local");
				if (r && r.ok) {
					state.localServers = r.servers || [];
					publish();
				}
			} catch (e) {}
		}

		async function loadLogServers() {
			try {
				const r = await api("/mcp-hub/records");
				if (r && r.ok) {
					state.logServers = r.servers || [];
					publish();
				}
			} catch (e) {}
		}

		async function loadLogDays(serverName) {
			state.logServer = serverName;
			state.days = [];
			state.records = [];
			publish();
			try {
				const r = await api("/mcp-hub/records?name=" + encodeURIComponent(serverName));
				if (r && r.ok) {
					state.days = r.days || [];
					publish();
				}
			} catch (e) {}
		}

		async function loadDay(day) {
			state.day = day;
			state.recExpanded = -1;
			publish();
			try {
				const q = ["day=" + encodeURIComponent(day)];
				if (state.logServer) q.push("name=" + encodeURIComponent(state.logServer));
				const r = await api("/mcp-hub/records?" + q.join("&"));
				if (r && r.ok) {
					state.records = r.records || [];
					publish();
				}
			} catch (e) {}
		}

		function sanitizeName(v, fallback) {
			const s = String(v || "").replace(/[^A-Za-z0-9_-]/g, "");
			return s || fallback || "mcp";
		}

		function buildMcpJson() {
			const mcpServers = {};
			for (const s of state.servers) {
				const name = sanitizeName(s.serverName, "mcp");
				if (s.transport === "stdio") {
					const entry = { command: s.command || "" };
					if (Array.isArray(s.args) && s.args.length) entry.args = s.args;
					const keys = s.env && typeof s.env === "object" ? Object.keys(s.env) : [];
					if (keys.length) entry.env = Object.assign({}, s.env);
					mcpServers[name] = entry;
				} else {
					const entry = { url: s.url || "" };
					if (s._token && s._token !== "none") entry.headers = { Authorization: "Bearer " + s._token };
					mcpServers[name] = entry;
				}
			}
			return { mcpServers };
		}

		function maskToken(t) {
			return t ? t.slice(0, 4) + "••••" : "（无）";
		}

		// 把 parseMcpJson 的结果变成 /servers 认得的服务器对象。
		// 这里必须保留 stdio：之前两个导入入口都把 transport 写死成
		// streamable-http，粘贴一个 command 型条目会被存成「有命令但没有地址」
		// 的混合体——既不连接也不报错，只是永远不工作。
		function pendingToServer(p) {
			if (p && p.transport === "stdio") {
				return {
					name: p.serverName,
					transport: "stdio",
					command: p.command || "",
					args: Array.isArray(p.args) ? p.args : [],
					env: p.env && typeof p.env === "object" ? p.env : {},
					url: "",
					token: ""
				};
			}
			return {
				name: (p && p.serverName) || "mcp",
				transport: "streamable-http",
				url: (p && p.url) || "",
				token: (p && p.token) || ""
			};
		}

		// 破坏性操作过来问一句。这些动作全都不可撤销（删服务器会带走 Token 与
		// 策略，删日志把当天流水物理删掉），一次误点就是永久损失。
		//
		// 用面板内的两步确认而不是 window.confirm：这是聊天界面里的设置面板，
		// 弹一个阻塞式模态会把整段对话卡住，而且某些宿主环境里 confirm 直接被禁用
		// ——那会让删除功能整个失效。两步确认没有这些问题，也和「解析 → 确认应用」
		// 已有的操作语言一致。
		function confirmStep(key, question) {
			const fresh = state.confirmKey === key && Date.now() - state.confirmAt < 8000;
			if (fresh) {
				state.confirmKey = "";
				state.confirmAt = 0;
				return true;
			}
			state.confirmKey = key;
			state.confirmAt = Date.now();
			setMsg(question + "\n（8 秒内再点一次即确认执行）", "");
			return false;
		}

		// 按钮文案跟着确认状态变，用户能看出「这一下真的会删」。
		function confirmLabel(key, normal, armedLabel) {
			return state.confirmKey === key && Date.now() - state.confirmAt < 8000 ? armedLabel : normal;
		}

		function parseMcpJson(text) {
			const raw = String(text || "").trim();
			if (!raw) return { ok: false, error: "输入为空：请先粘贴或编辑 JSON 配置" };

			// 形态 1：裸 URL（可带 ?token= 或 #token）
			if (/^https?:\/\//i.test(raw) && raw.indexOf("{") < 0 && raw.indexOf("\n") < 0) {
				// 用 URL 解析而不是砍末尾：token 可能不是最后一个查询参数，
				// 按「匹配长度从尾部截掉」会把后面的参数一起删掉，得到一个连不上的地址。
				const parsed = (() => {
					try {
						return new URL(raw);
					} catch {
						return null;
					}
				})();
				if (!parsed) return { ok: false, error: "URL 格式不合法：" + raw };
				let token = "";
				const candidates = ["token", "access_token", "key"];
				for (const name of candidates) {
					const v = parsed.searchParams.get(name);
					if (v) {
						token = v;
						parsed.searchParams.delete(name);
						break;
					}
				}
				// #token= 形式（hash 不走 searchParams，单独处理）
				if (!token && parsed.hash) {
					const hm = /^#(?:token|access_token|key)=(.+)$/i.exec(parsed.hash);
					if (hm) {
						token = decodeURIComponent(hm[1]);
						parsed.hash = "";
					}
				}
				const clean = parsed.toString();
				const host = parsed.hostname.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
				return {
					ok: true,
					warn: ["已按裸 URL 解析；服务器名取自主机名「" + (host || "mcp") + "」，可在表单里改" + (token ? "，已从地址中提取 Token" : "")],
					data: { serverName: host || "mcp", url: clean, token }
				};
			}

			let obj;
			try {
				obj = JSON.parse(raw);
			} catch (e) {
				// 形态 2：cordis.patch.yml 里的 mcp-client 片段（非 JSON）
				if (/mcp-client|transport:\s*(stdio|streamable-http)/.test(raw)) {
					const name = (/serverName:\s*['"]?([A-Za-z0-9_-]+)/.exec(raw) || [])[1] || "";
					const url = (/url:\s*['"]?([^'"\s]+)/.exec(raw) || [])[1] || "";
					const bearer = /Authorization:\s*['"]?Bearer\s+([^'"\s]+)/.exec(raw);
					if (url) {
						return {
							ok: true,
							warn: ["已按 DSH cordis 片段解析（非 JSON）"],
							data: { serverName: name || "mcp", url, token: bearer ? bearer[1] : "" }
						};
					}
					return { ok: false, error: "识别为 DSH cordis 片段，但没找到 url（stdio 形式请用「本地服务器」入口接管）" };
				}
				return { ok: false, error: "JSON 解析失败：" + (e && e.message ? e.message : e) };
			}
			if (!obj || typeof obj !== "object" || Array.isArray(obj))
				return { ok: false, error: '顶层必须是 JSON 对象，形如 {"mcpServers":{...}}' };
			const servers = obj.mcpServers;
			if (servers === undefined || servers === null)
				return { ok: false, error: "缺少 mcpServers 字段（其它字段会被忽略）" };
			if (typeof servers !== "object" || Array.isArray(servers))
				return { ok: false, error: 'mcpServers 必须是对象，形如 {"my-mcp":{...}}' };
			const keys = Object.keys(servers);
			if (!keys.length) return { ok: false, error: "mcpServers 里没有任何服务器条目" };
			const warn = [];
			// 多服务器不再静默只取第一个。整个文件贴进来只导入一台、其余悄悄
			// 丢掉，是最容易被误读成「全部导入了」的失败方式——所以直接拦下来，
			// 让用户明确知道自己只导了一台。想批量导入请用「备份 JSON」。
			if (keys.length > 1) {
				return {
					ok: false,
					error: "这个文件里有 " + keys.length + " 个服务器（" + keys.join("、") + "），本入口一次只导入一台。请删到只剩「" + keys[0] + "」再粘贴，或改用备份 JSON 批量还原。"
				};
			}
			const key = keys[0];
			const entry = servers[key];
			if (!entry || typeof entry !== "object" || Array.isArray(entry))
				return { ok: false, error: "服务器「" + key + "」必须是对象" };
			const url = String(entry.url || "").trim();
			let serverNameEarly = String(key).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "mcp";
			if (serverNameEarly !== key) warn.push("服务器名「" + key + "」含非法字符，已规范为「" + serverNameEarly + "」（工具前缀 mcp__" + serverNameEarly + "__）");

			// 形态 3：stdio（command/args）—— 本地进程服务器，独立一类
			if (!url && (entry.command || entry.args)) {
				const command = String(entry.command || "").trim();
				if (!command) return { ok: false, error: "服务器「" + key + "」有 args 但缺 command" };
				const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
				const env = entry.env && typeof entry.env === "object" && !Array.isArray(entry.env) ? entry.env : {};
				return {
					ok: true,
					warn: warn.concat(["已识别为 stdio 本地进程服务器；连接方为 DSH 原生 mcp-client，保存后需写入加载补丁才生效"]),
					data: { serverName: serverNameEarly, transport: "stdio", command, args, env, url: "", token: "" }
				};
			}
			if (!url) return { ok: false, error: "服务器「" + key + "」缺少 url 或 command 字段" };
			if (!/^https?:\/\//i.test(url))
				return { ok: false, error: "url 必须以 http:// 或 https:// 开头：" + url };
			if (entry.transport && ["streamable-http", "http", "streamable_http"].indexOf(String(entry.transport).toLowerCase()) < 0)
				warn.push("transport 为「" + entry.transport + "」，将按 streamable-http 处理");
			let token = "";
			const headers = entry.headers && typeof entry.headers === "object" ? entry.headers : null;
			if (!headers) {
				warn.push("未检测到 headers/Authorization；若手机端 Token 未设为 none，连接将返回 401");
			} else {
				const auth = String(headers.Authorization || headers.authorization || "").trim();
				if (!auth) {
					warn.push("headers 里没有 Authorization；若手机端 Token 未设为 none，连接将返回 401");
				} else {
					const m = /^Bearer\s+(.+)$/i.exec(auth);
					if (m) token = m[1].trim();
					else {
						token = auth;
						warn.push("Authorization 缺少 Bearer 前缀，已自动补全");
					}
				}
			}
			let serverName = String(key).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
			if (!serverName) serverName = "mcp";
			if (serverName !== key) warn.push("服务器名「" + key + "」含非法字符，已规范为「" + serverName + "」（工具前缀 mcp__" + serverName + "__）");
			return { ok: true, warn, data: { serverName, transport: "streamable-http", url, token } };
		}

		const actions = {
			go(view) {
				state.view = view;
				publish();
			},
			openServer(id) {
				state.activeId = id;
				const found = state.servers.find((s) => s.id === id);
				state.draft = found ? draftOf(found) : null;
				state.view = "editor";
				publish();
			},
			openLogServer(name) {
				void loadLogDays(name);
			},
			patchDraft(patch) {
				const next = Object.assign({}, state.draft || {}, patch);
				// Token 三态的维护点集中在这里：
				//   输入非空       → 有新凭证，撤销「清除」标记
				//   输入被删空     → 回落成「已保存但保持原值」，不算清除
				//   「清除」按钮   → 由按钮自己带 clearToken 进来，交给 draftToServer
				if (patch.token !== undefined && patch.clearToken === undefined) {
					next.clearToken = false;
					if (patch.token !== "") next.tokenConfigured = true;
				}
				state.draft = next;
				publish();
			},
			selectServer(id) {
				state.activeId = id;
				const found = state.servers.find((s) => s.id === id);
				state.draft = found ? draftOf(found) : null;
				state.tools = [];
				state.expanded = "";
				// 搜索词跟着换服务器一起清：上一台的过滤词留在输入框里，
				// 会让新服务器的工具列表看起来「缺了一半」。
				state.search = "";
				publish();
				if (found) void loadTools(false);
			},
			newServer() {
				state.activeId = "";
				// 新建必须清掉任何残留的草稿（比如刚删完一台服务器）：
				// 否则表单里会出现上一台的 URL/Token，保存下去就变成一台错误的服务器。
				state.draft = draftOf({ id: "", name: "mcp", transport: "streamable-http", url: "", autoReconnect: true, enabled: true, approvalMode: "inherit" });
				state.tools = [];
				state.expanded = "";
				state.debugResult = {};
				state.msg = "";
				state.view = "editor";
				publish();
			},
			toggleShowToken() {
				state.showToken = !state.showToken;
				publish();
			},
			async save() {
				const d = state.draft || {};
				const name = String(d.name || "").trim();
				if (!name) {
					setMsg("请填写服务器名（决定工具前缀 mcp__<name>__）", "err");
					return;
				}
				if (!/^[A-Za-z0-9_-]+$/.test(name)) {
					setMsg("服务器名只能用字母、数字、下划线、连字符（工具前缀 mcp__<name>__）", "err");
					return;
				}
				if (d.transport !== "stdio") {
					const url = String(d.url || "").trim();
					if (!url) {
						setMsg("请填写服务器 URL", "err");
						return;
					}
					if (!/^https?:\/\/.+/i.test(url)) {
						setMsg("地址格式不对：需以 http:// 或 https:// 开头", "err");
						return;
					}
				} else if (!String(d.command || "").trim()) {
					setMsg("stdio 传输需要填写命令（如 node / python）", "err");
					return;
				}
				state.busy = true;
				setMsg("保存中…");
				try {
					const r = await api("/mcp-hub/servers", {
						method: "POST",
						body: { profile: state.profile, server: draftToServer(d, { clearToken: !!d.clearToken }) }
					});
					if (r && r.ok) {
						const patchNote = r.patch && r.patch.changed ? "\n加载补丁已同步：" + r.patch.reason + "（重启 DSH 后生效）" : "";
						setMsg("已保存服务器「" + r.server.serverName + "」" + patchNote, "ok");
						state.activeId = r.server.id;
						state.draft = null;
						state.view = "servers";
						state.importDirty = true;
						await loadConfig();
						await loadStatus();
					} else {
						setMsg("保存失败: " + ((r && r.error) || "未知错误"), "err");
					}
				} catch (e) {
					setMsg("保存失败: " + e.message, "err");
				} finally {
					// 放在 finally 里：上面任何一个 await 抛错都不能让 busy 卡在 true，
					// 否则整个面板的按钮从此全部禁用，只能刷新页面。
					state.busy = false;
					publish();
				}
			},
			async exportBackup() {
				state.busy = true;
				setMsg("正在生成备份…");
				try {
					const r = await api("/mcp-hub/backup");
					if (!r || !r.ok) throw new Error((r && r.error) || "生成失败");
					const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
					const name = "dsh-mcp-hub-backup-" + stamp + ".json";
					const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
					const a = document.createElement("a");
					a.href = URL.createObjectURL(blob);
					a.download = name;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
					setTimeout(() => URL.revokeObjectURL(a.href), 4000);
					setMsg("已导出 " + name + "（" + (r.servers || []).length + " 个服务器）", "ok");
				} catch (e) {
					setMsg("导出失败: " + e.message, "err");
				} finally {
					state.busy = false;
					publish();
				}
			},
			async importBackupFile(file) {
				if (!file) return;
				state.busy = true;
				setMsg("正在导入…");
				try {
					const text = await file.text();
					let parsed;
					try {
						parsed = JSON.parse(text);
					} catch (e) {
						throw new Error("不是合法 JSON：" + e.message);
					}
					const r = await api("/mcp-hub/backup", { method: "POST", body: { backup: parsed, mode: state.backupMode || "merge" } });
					if (r && r.ok) {
						const verb = r.mode === "replace" ? "覆盖" : "合并";
						setMsg("已" + verb + "导入 · 新增 " + r.added + " · 更新 " + r.updated + " · 补丁" + (r.patchWritten ? "已写入" : "未写入"), "ok");
						state.importDirty = true;
						await loadConfig();
						await loadStatus();
						await loadLocal();
					} else {
						setMsg("导入失败: " + (r && r.error), "err");
					}
				} catch (e) {
					setMsg("导入失败: " + e.message, "err");
				} finally {
					state.busy = false;
					publish();
				}
			},
			async adoptLocal(name) {
				state.busy = true;
				setMsg("正在接管 " + name + "…");
				try {
					const r = await api("/mcp-hub/local", { method: "POST", body: { serverName: name } });
					if (r && r.ok) {
						setMsg("已接管「" + name + "」→ 面板管理，连接方仍是 DSH 原生 mcp-client", "ok");
						state.importDirty = true;
						await loadConfig();
						await loadStatus();
						await loadLocal();
					} else {
						setMsg("接管失败: " + (r && r.error), "err");
					}
				} catch (e) {
					setMsg("接管失败: " + e.message, "err");
				} finally {
					state.busy = false;
					publish();
				}
			},
			async removeServer(id) {
				const target = (state.servers || []).find((s) => s.id === id);
				const name = sanitizeName(target && (target.serverName || target.name), "mcp");
				if (!confirmStep("del:" + id, "删除服务器「" + name + "」？它的 Token 与逐工具策略会一并删除，无法撤销。")) return;
				state.busy = true;
				try {
					const r = await api("/mcp-hub/servers?id=" + encodeURIComponent(id), { method: "DELETE" });
					if (r && r.ok) {
						const patchNote = r.patch && r.patch.changed ? "\n加载补丁已同步：" + r.patch.reason + "（重启 DSH 后生效）" : "";
						setMsg("已删除该服务器" + patchNote, "ok");
						state.importDirty = true;
						if (state.activeId === id) {
							state.activeId = "";
							// 草稿也要一起清：留着的话，「新增」会带着已删服务器的
							// URL 与 Token 打开，下一次保存就把它复活成另一台。
							state.draft = null;
						}
						state.view = "servers";
						await loadConfig();
						await loadStatus();
					} else {
						setMsg("删除失败: " + ((r && r.error) || ""), "err");
					}
				} catch (e) {
					setMsg("删除失败: " + e.message, "err");
				} finally {
					state.busy = false;
					publish();
				}
			},
			async test() {
				if (!state.activeId) {
					setMsg("请先保存服务器后再测试", "err");
					return;
				}
				state.busy = true;
				setMsg("正在连接…");
				try {
					const r = await api("/mcp-hub/test?server=" + encodeURIComponent(state.activeId), { method: "POST", body: {} });
					if (r && r.ok) {
						setMsg("连接成功 · 延迟 " + r.latencyMs + "ms · " + r.toolCount + " 个工具", "ok");
						await loadTools(false);
					} else {
						setMsg("连接失败: " + ((r && r.error) || "未知错误"), "err");
					}
					await loadStatus();
				} catch (e) {
					setMsg("连接失败: " + e.message, "err");
				} finally {
					state.busy = false;
					publish();
				}
			},
			async reconnect() {
				if (!state.activeId) {
					setMsg("请先保存服务器", "err");
					return;
				}
				state.busy = true;
				setMsg("强制重连中…");
				try {
					const r = await api("/mcp-hub/reconnect?server=" + encodeURIComponent(state.activeId), { method: "POST", body: {} });
					setMsg(r && r.ok ? "已重新连接" : "重连失败: " + ((r && r.error) || ""), r && r.ok ? "ok" : "err");
					await loadTools(false);
					await loadStatus();
				} catch (e) {
					setMsg("重连失败: " + e.message, "err");
				} finally {
					state.busy = false;
					publish();
				}
			},
			async doImport() {
				state.busy = true;
				setMsg("正在写入 cordis.yml…");
				try {
					const r = await api("/mcp-hub/import", { method: "POST", body: { mode: "add" } });
					if (r && r.ok) {
						setMsg("已写入加载补丁 " + r.cordisPath + "，重启 DSH 后原生工具生效", "ok");
						state.imp = r;
					} else {
						setMsg("导入失败: " + ((r && r.error) || "未知"), "err");
					}
				} catch (e) {
					setMsg("导入失败: " + e.message, "err");
				} finally {
					state.busy = false;
					publish();
				}
			},
			async removeImport() {
				if (!confirmStep("remove:bridge", "移除加载补丁里的桥接条目？插件本体与面板配置都会保留，重启 DSH 后原生工具才会消失。")) return;
				state.busy = true;
				try {
					const r = await api("/mcp-hub/import", { method: "POST", body: { mode: "remove" } });
					if (r && r.ok) {
						setMsg(r.changed ? "已移除桥接（插件本体保留）" : "没有可移除的桥接", "ok");
						state.imp = r;
					}
				} catch (e) {
					setMsg("移除失败: " + e.message, "err");
				} finally {
					state.busy = false;
					publish();
				}
			},
			copySnippet() {
				const text = state.importText || "";
				if (!text.trim()) {
					setMsg("没有可复制的内容：请先生成或粘贴 JSON", "err");
					return;
				}
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(text);
					}
					setMsg("配置已复制到剪贴板", "ok");
				} catch (e) {
					setMsg("复制失败: " + e.message, "err");
				}
			},
			genJson() {
				state.importText = JSON.stringify(buildMcpJson(), null, 2);
				state.importPending = null;
				state.importError = "";
				state.importWarn = [];
				publish();
				setMsg("已按当前配置生成 JSON", "ok");
			},
			patchImportText(v) {
				state.importText = v;
				state.importPending = null;
				if (state.importError) state.importError = "";
				publish();
			},
			cancelPending() {
				state.importPending = null;
				publish();
			},
			async applyOrParse() {
				if (!state.importPending) {
					const r = parseMcpJson(state.importText);
					state.importError = r.ok ? "" : r.error;
					state.importWarn = r.ok ? r.warn || [] : [];
					if (!r.ok) {
						setMsg("校验未通过，请按提示修改", "err");
						publish();
						return;
					}
					state.importPending = r.data;
					setMsg("校验通过，再点一次「确认应用」写入配置", "");
					publish();
					return;
				}
				const p = state.importPending;
				state.busy = true;
				const target = pendingToServer(p);
				setMsg("正在应用 " + (target.transport === "stdio" ? target.command : p.url) + " …");
				try {
					const r = await api("/mcp-hub/servers", { method: "POST", body: { profile: state.profile, server: target } });
					if (r && r.ok) {
						state.importPending = null;
						await loadConfig();
						// stdio 服务器的连接方是原生 mcp-client：这里没有可拨号的地址，
						// 直接 test 只会报一个与用户操作无关的失败。
						if (target.transport !== "stdio") await actions.test();
						else await loadStatus();
						setMsg("已应用：服务器「" + p.serverName + "」→ " + (target.transport === "stdio" ? "stdio · " + target.command : p.url) + " · Token " + maskToken(p.token) + (state.importWarn.length ? "\n注意：" + state.importWarn.join("；") : ""), "ok");
					} else {
						setMsg("应用失败: " + ((r && r.error) || "未知错误"), "err");
					}
				} catch (e) {
					setMsg("应用失败: " + e.message, "err");
				} finally {
					state.busy = false;
					publish();
				}
			},
			async importToDsh() {
				if (!state.importPending) {
					setMsg("请先「解析并校验」，确认无误后再写入 cordis.yml", "err");
					return;
				}
				const p = state.importPending;
				try {
					const rc = await api("/mcp-hub/servers", { method: "POST", body: { profile: state.profile, server: pendingToServer(p) } });
					if (!rc || !rc.ok) {
						setMsg("应用配置失败: " + ((rc && rc.error) || "未知"), "err");
						return;
					}
					await loadConfig();
				} catch (e) {
					setMsg("应用配置失败: " + e.message, "err");
					return;
				}
				state.importPending = null;
				await actions.doImport();
			},
			toggleQuick() {
				state.quickOpen = !state.quickOpen;
				publish();
			},
			patchQuickText(v) {
				state.quickText = v;
				state.quickError = "";
				state.quickPending = null;
				publish();
			},
			quickParse() {
				const parsed = parseMcpJson(state.quickText);
				state.quickError = parsed.ok ? "" : parsed.error;
				state.quickWarn = parsed.ok ? parsed.warn || [] : [];
				if (!parsed.ok) {
					setMsg("快捷导入校验未通过", "err");
					publish();
					return;
				}
				state.quickPending = parsed.data;
				// 直接回填到编辑表单，不落盘 —— 用户仍可改完再点保存
				const patch = { name: parsed.data.serverName, transport: parsed.data.transport || "streamable-http" };
				if (parsed.data.transport === "stdio") {
					patch.command = parsed.data.command || "";
					patch.argsText = (parsed.data.args || []).join("\n");
					patch.envText = Object.keys(parsed.data.env || {}).map((k) => k + "=" + parsed.data.env[k]).join("\n");
				} else {
					patch.url = parsed.data.url;
					patch.token = parsed.data.token;
				}
				state.draft = Object.assign({}, state.draft || {}, patch);
				state.quickOpen = false;
				state.quickText = "";
				setMsg("已回填表单：服务器「" + parsed.data.serverName + "」（" + patch.transport + "），检查后点保存", "ok");
				publish();
			},
			quickFillCurrent() {
				const d = state.draft || {};
				const entry = {};
				// argsText/envText 才是草稿上的真实来源：draftOf 把 args/env 摊成了
				// 多行文本，草稿对象上既没有 d.args 也没有 d.env，读它们永远是空。
				entry[d.name || "mcp"] = d.transport === "stdio"
					? {
						command: d.command || "",
						args: String(d.argsText || "").split("\n").map((x) => x.trim()).filter(Boolean),
						env: (() => {
							const out = {};
							for (const line of String(d.envText || "").split("\n")) {
								const t = line.trim();
								const i = t.indexOf("=");
								if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
							}
							return out;
						})()
					}
					: { url: d.url || "", headers: d.token ? { Authorization: "Bearer " + d.token } : {} };
				state.quickText = JSON.stringify({ mcpServers: entry }, null, 2);
				state.quickError = "";
				publish();
			},
			quickFillSample() {
				state.quickText = JSON.stringify({
					mcpServers: {
						qfun: {
							url: "http://10.49.32.221:8765/mcp",
							headers: { Authorization: "Bearer <你的Token>" }
						}
					}
				}, null, 2);
				state.quickOpen = true;
				publish();
			},
			setBackupMode(m) {
				state.backupMode = m === "replace" ? "replace" : "merge";
				publish();
			},
			setSearch(v) {
				state.search = v;
				publish();
			},
			toggleExpand(name) {
				state.expanded = state.expanded === name ? "" : name;
				if (state.expanded && state.debugArgs[name] === undefined) {
					state.debugArgs = Object.assign({}, state.debugArgs, { [name]: "{\n  \n}" });
				}
				publish();
			},
			async setPolicy(name, patch) {
				try {
					const r = await api("/mcp-hub/tool-policy", { method: "POST", body: Object.assign({ server: state.activeId, names: [name] }, patch) });
					// 宿主对未知 server 返回 404、路由异常返回 500，但之前这里一律
					// 乐观改本地状态：复选框翻过去、界面显示「已保存」，下次刷新
					// 又变回来。写入失败就必须让开关弹回去并说清原因。
					if (!r || !r.ok) {
						setMsg("保存策略失败: " + ((r && r.error) || "未知错误"), "err");
						return;
					}
					state.tools = state.tools.map((t) =>
						t.name === name ? Object.assign({}, t, patch) : t
					);
					publish();
				} catch (e) {
					setMsg("保存策略失败: " + e.message, "err");
				}
			},
			async setPolicyAll(patch, filterFn) {
				const names = state.tools.filter(filterFn || (() => true)).map((t) => t.name);
				if (!names.length) return;
				try {
					const r = await api("/mcp-hub/tool-policy", { method: "POST", body: Object.assign({ server: state.activeId, names }, patch) });
					if (!r || !r.ok) {
						// 批量操作失败同样不能假装生效：一次 stale activeId 会让
						// 全开/全关看起来成功，实际一条都没写进去。
						setMsg("批量设置失败: " + ((r && r.error) || "未知错误"), "err");
						return;
					}
					state.tools = state.tools.map((t) =>
						names.indexOf(t.name) >= 0 ? Object.assign({}, t, patch) : t
					);
					publish();
				} catch (e) {
					setMsg("批量设置失败: " + e.message, "err");
				}
			},
			patchDebugArgs(name, value) {
				state.debugArgs = Object.assign({}, state.debugArgs, { [name]: value });
				publish();
			},
			async invoke(name) {
				let args = {};
				try {
					const raw = state.debugArgs[name] || "{}";
					args = raw.trim() ? JSON.parse(raw) : {};
				} catch (e) {
					setMsg("参数不是合法 JSON: " + e.message, "err");
					return;
				}
				state.invokeBusy = name;
				state.debugResult = Object.assign({}, state.debugResult, { [name]: "调用中…" });
				publish();
				try {
					const r = await api("/mcp-hub/invoke", { method: "POST", body: { server: state.activeId, tool: name, arguments: args } });
					let text;
					if (r && r.ok) {
						text = (r.isError ? "[isError] " : "[ok] ") + "耗时 " + r.ms + "ms\n" + (r.text || "");
					} else {
						text = "[失败] " + ((r && r.error) || "未知错误") + (r && r.ms != null ? "（" + r.ms + "ms）" : "");
					}
					state.debugResult = Object.assign({}, state.debugResult, { [name]: text });
					if (state.logServer) await loadDay(state.day);
				} catch (e) {
					state.debugResult = Object.assign({}, state.debugResult, { [name]: "[失败] " + e.message });
				}
				state.invokeBusy = "";
				publish();
			},
			toggleRec(i) {
				state.recExpanded = state.recExpanded === i ? -1 : i;
				publish();
			},
			async deleteDay(day) {
				if (!confirmStep("day:" + day, "删除 " + day + " 的调用记录？这一天的流水会被物理删除，无法恢复。")) return;
				try {
					const r = await api("/mcp-hub/records?day=" + encodeURIComponent(day), { method: "DELETE" });
					// 不可撤销的动作必须按真实结果回话。之前无论响应如何都报
					// 「已删除」——宿主删失败时用户以为记录没了，实际文件还在。
					if (r && r.ok) {
						setMsg("已删除 " + day + " 的记录", "ok");
						if (state.logServer) await loadLogDays(state.logServer);
					} else {
						setMsg("删除失败: " + ((r && r.error) || "未知错误"), "err");
					}
				} catch (e) {
					setMsg("删除失败: " + e.message, "err");
				}
			},
			async clearAll() {
				if (!confirmStep("clear:records", "清空全部调用记录？所有日期的流水都会被物理删除，无法恢复。")) return;
				try {
					const r = await api("/mcp-hub/records", { method: "DELETE" });
					if (r && r.ok) {
						setMsg("已清空全部调用记录", "ok");
						state.day = "";
						state.records = [];
						if (state.logServer) await loadLogDays(state.logServer);
					} else {
						// 失败时绝不能清空本地状态：那会让面板看起来「空了」，
						// 掩盖磁盘上仍然存在的记录。
						setMsg("清空失败: " + ((r && r.error) || "未知错误"), "err");
					}
				} catch (e) {
					setMsg("清空失败: " + e.message, "err");
				}
			},
			refreshAll() {
				void loadConfig();
				void loadStatus();
				void loadTools(false);
				void loadImport();
				void loadLogServers();
				void loadLocal();
				void loadApproval();
				void loadGateway();
			},
			async setGlobalFollow(followDsh) {
				setMsg("设置中…");
				try {
					const r = await api("/mcp-hub/approval", { method: "POST", body: { followDsh } });
					if (r && r.ok) {
						state.approval = r.approval || state.approval;
						state.approvalInfo = r.dsh || state.approvalInfo;
						state.grants = r.grants || [];
						setMsg(followDsh ? "总开关已开：MCP 工具跟随 DSH 审批" : "总开关已关：改由逐工具开关决定", "ok");
					} else {
						setMsg("保存失败: " + ((r && r.error) || "未知错误"), "err");
					}
				} catch (e) {
					setMsg("保存失败: " + e.message, "err");
				}
				publish();
			},
			async setServerApproval(id, approvalMode) {
				try {
					const r = await api("/mcp-hub/approval", { method: "POST", body: { server: id, approvalMode } });
					if (r && r.ok) {
						state.approvalInfo = r.dsh || state.approvalInfo;
						await loadConfig();
						await loadStatus();
						setMsg("已更新该服务器的审批策略", "ok");
					} else {
						setMsg("保存失败: " + ((r && r.error) || "未知错误"), "err");
					}
				} catch (e) {
					setMsg("保存失败: " + e.message, "err");
				}
				publish();
			},
			async setBudgetTier(id, tier) {
				try {
					const r = await api("/mcp-hub/budget", { method: "POST", body: { server: id, tier } });
					if (r && r.ok) {
						await loadConfig();
						await loadStatus();
						setMsg("投放档位已改为 " + tier + "，下一步请求即生效", "ok");
					} else {
						setMsg("保存失败: " + ((r && r.error) || "未知错误"), "err");
					}
				} catch (e) {
					setMsg("保存失败: " + e.message, "err");
				}
				publish();
			},
			async revokeGrants() {
				try {
					const r = await api("/mcp-hub/approval", { method: "POST", body: { action: "revoke-grants" } });
					if (r && r.ok) {
						state.grants = [];
						setMsg("已清空本次会话的授权（" + (r.removed || 0) + " 条）", "ok");
					}
				} catch (e) {
					setMsg("清空失败: " + e.message, "err");
				}
				publish();
			},
			patchGateway(patch) {
				state.gatewayDraft = Object.assign({}, state.gatewayDraft || {}, patch);
				publish();
			},
			patchCatalogDraft(patch) {
				state.catalogDraft = Object.assign({}, state.catalogDraft || {}, patch);
				publish();
			},
			patchHintDraft(patch) {
				state.hintDraft = Object.assign({}, state.hintDraft || {}, patch);
				publish();
			},
			resetGatewayDraft() {
				const g = state.gateway || {};
				state.gatewayDraft = {
					searchLimit: String(g.searchLimit || 8),
					catalogLimit: String(g.catalogLimit || 200),
					schemaMaxBytes: String(g.schemaMaxBytes || 16000),
					loadBatchMax: String(g.loadBatchMax || 12),
					revealMax: String(g.revealMax === undefined ? 0 : g.revealMax)
				};
				const c = (g && g.catalog) || {};
				state.catalogDraft = {
					enabled: c.enabled !== false,
					mode: c.mode || "names",
					limit: String(c.limit || 200),
					capabilities: c.capabilities !== false
				};
				const hh = (g && g.hint) || {};
				state.hintDraft = {
					enabled: hh.enabled === true,
					maxTotal: String(hh.maxTotal === undefined ? 3 : hh.maxTotal),
					maxPerServer: String(hh.maxPerServer === undefined ? 1 : hh.maxPerServer)
				};
				publish();
			},
			async saveGateway() {
				const d = state.gatewayDraft || {};
				const cd = state.catalogDraft || {};
				state.busy = true;
				setMsg("保存网关设置…");
				try {
					const r = await api("/mcp-hub/gateway", {
						method: "POST",
						body: {
							searchLimit: Number(d.searchLimit),
							catalogLimit: Number(d.catalogLimit),
							schemaMaxBytes: Number(d.schemaMaxBytes),
							loadBatchMax: Number(d.loadBatchMax),
							revealMax: Number(d.revealMax),
							catalog: {
								enabled: cd.enabled !== false,
								mode: cd.mode || "names",
								limit: Number(cd.limit),
								capabilities: cd.capabilities !== false
							},
							hint: {
								enabled: (state.hintDraft || {}).enabled === true,
								maxTotal: Number((state.hintDraft || {}).maxTotal),
								maxPerServer: Number((state.hintDraft || {}).maxPerServer)
							}
						}
					});
					if (r && r.ok) {
						state.gateway = r;
						state.gatewayDraft = {
							searchLimit: String(r.searchLimit),
							catalogLimit: String(r.catalogLimit),
							schemaMaxBytes: String(r.schemaMaxBytes),
							loadBatchMax: String(r.loadBatchMax),
							revealMax: String(r.revealMax === undefined ? 0 : r.revealMax)
						};
						const c = r.catalog || {};
						state.catalogDraft = {
							enabled: c.enabled !== false,
							mode: c.mode || "names",
							limit: String(c.limit || 200),
							capabilities: c.capabilities !== false
						};
						const hb = r.hint || {};
						state.hintDraft = {
							enabled: hb.enabled === true,
							maxTotal: String(hb.maxTotal === undefined ? 3 : hb.maxTotal),
							maxPerServer: String(hb.maxPerServer === undefined ? 1 : hb.maxPerServer)
						};
						setMsg("已保存：下次请求即按新参数与目录执行", "ok");
					} else {
						setMsg("保存失败: " + ((r && r.error) || "未知错误"), "err");
					}
				} catch (e) {
					setMsg("保存失败: " + e.message, "err");
				} finally {
					state.busy = false;
					publish();
				}
			}
		};

		function Pill(props) {
			const cls = "qfm-pill " + (props.tone || "");
			return h("span", { className: cls }, h("i", { className: "qfm-dot" }), props.text);
		}

		function Field(props) {
			return h(
				"label",
				{ className: "qfm-field" },
				h("span", null, props.label),
				props.children
			);
		}

		function Switch(props) {
			return h(
				"label",
				{ className: "qfm-sw" },
				h("input", {
					type: "checkbox",
					checked: !!props.checked,
					disabled: props.disabled,
					onChange: (e) => props.onChange(e.target.checked)
				}),
				props.label
			);
		}

		function ToolRow(props) {
			const t = props.tool;
			const open = state.expanded === t.name;
			const result = state.debugResult[t.name];
			return h(
				"div",
				{ className: "qfm-tool" + (t.enabled ? "" : " off") },
				h(
					"div",
					{ className: "qfm-tool-head" },
					h(
						"span",
						{
							className: "qfm-tool-name",
							title: t.name,
							onClick: () => actions.toggleExpand(t.name)
						},
						t.name
					),
					h(Switch, {
						label: "启用",
						checked: t.enabled,
						onChange: (v) => actions.setPolicy(t.name, { enabled: v })
					}),
					h(Switch, {
						label: "需审批",
						checked: t.effective && t.effective.follow ? true : t.approval,
						disabled: !!(t.effective && t.effective.follow),
						onChange: (v) => actions.setPolicy(t.name, { approval: v })
					})
				),
				h("div", { className: "qfm-tool-desc", title: t.description }, t.description || "（无描述）"),
				open
					? h(
							"div",
							{ className: "qfm-detail" },
							h("p", { className: "qfm-sub" }, t.description || "（无描述）"),
							h("pre", { className: "qfm-pre" }, JSON.stringify(t.inputSchema, null, 2)),
							h(
								"div",
								{ className: "qfm-field" },
								h("span", null, "快捷调试 · 参数 JSON"),
								h("textarea", {
									className: "qfm-ta",
									value: state.debugArgs[t.name] || "",
									onChange: (e) => actions.patchDebugArgs(t.name, e.target.value)
								})
							),
							h(
								"div",
								{ className: "qfm-row" },
								h(
									"button",
									{
										className: "qfm-btn primary",
										disabled: state.invokeBusy === t.name || !t.enabled,
										onClick: () => actions.invoke(t.name)
									},
									state.invokeBusy === t.name ? "调用中…" : "运行（经原生管线）"
								),
								!t.enabled ? h("span", { className: "qfm-sub" }, "工具已禁用，启用后可调试") : null
							),
							result ? h("pre", { className: "qfm-pre" }, result) : null
					  )
					: null
			);
		}

		// 编辑器内的快捷导入：粘贴 mcpServers JSON 直接回填表单，
		// 不落盘、不写补丁 —— 保存仍由用户显式点按钮。
		function QuickImport() {
			const open = state.quickOpen;
			return h(
				"div",
				{ className: "qfm-card", style: { marginBottom: "12px", background: "rgba(120,160,255,.06)" } },
				h(
					"div",
					{ className: "qfm-row", style: { alignItems: "center", marginBottom: open ? "10px" : "0" } },
					h("b", { style: { flex: "1 1 auto", fontSize: "13px" } }, "快捷导入"),
					h("button", { className: "qfm-btn", onClick: () => actions.quickFillSample() }, "示例"),
					h("button", { className: "qfm-btn", onClick: () => actions.quickFillCurrent() }, "生成当前"),
					h("button", { className: "qfm-btn primary", onClick: () => actions.toggleQuick() }, open ? "收起" : "粘贴 JSON")
				),
				!open
					? h("p", { className: "qfm-sub", style: { margin: "6px 0 0" } },
						"支持 Claude Desktop / Chatbox / Cursor 等通用的 mcpServers JSON、裸 URL、以及 DSH cordis.patch.yml 片段")
					: null,
				open
					? h(
						"div",
						null,
						h("textarea", {
							className: "qfm-ta",
							style: { minHeight: "130px" },
							spellCheck: false,
							value: state.quickText,
							placeholder: '{\n  "mcpServers": {\n    "qfun": {\n      "url": "http://10.49.32.221:8765/mcp",\n      "headers": { "Authorization": "Bearer xxx" }\n    }\n  }\n}',
							onChange: (e) => actions.patchQuickText(e.target.value)
						}),
						state.quickError ? h("p", { className: "qfm-msg err" }, "✗ " + state.quickError) : null,
						state.quickWarn && state.quickWarn.length
							? h("p", { className: "qfm-msg" }, state.quickWarn.map((w) => "⚠ " + w).join("\n"))
							: null,
						h(
							"div",
							{ className: "qfm-row" },
							h("button", { className: "qfm-btn primary", disabled: state.busy, onClick: () => actions.quickParse() }, "解析并回填表单"),
							h("button", { className: "qfm-btn", onClick: () => actions.patchQuickText("") }, "清空")
						)
					)
					: null
			);
		}

		function ConnectionCard() {
			const s = state.servers.find((x) => x.id === state.activeId) || {};
			const d = state.draft || draftOf({});
			const connected = s.status === "connected";
			const tone = s.managed === true ? "on" : connected ? "on" : s.status === "reconnecting" || s.status === "connecting" ? "warn" : "off";
			const label = s.managed === true ? "DSH 托管" : connected ? "已连接" : s.status === "reconnecting" ? "重连中" : s.status === "connecting" ? "连接中" : "未连接";
			return h(
				"div",
				{ className: "qfm-card" },
				h(
					"h2",
					null,
					h(Pill, { tone, text: label }),
					"服务器设置"
				),
				h(
					"div",
					{ className: "qfm-grid" },
					h("div", { className: "qfm-stat" }, h("b", null, connected ? (s.latencyMs || 0) + "ms" : "—"), h("span", null, "延迟")),
					// 「面板拨通几个」和「模型看得到几个」分开显示：合在一起时
					// 原生客户端 401 而面板自带 Token 能拨号，会显示成健康的 38 工具，
					// 而模型实际一个都拿不到。
					h("div", { className: "qfm-stat" }, h("b", null, String(s.visibleToolCount || 0)), h("span", null, "模型可见")),
					h("div", { className: "qfm-stat" }, h("b", null, String(s.dialToolCount || 0)), h("span", null, "面板拨号")),
					h("div", { className: "qfm-stat" }, h("b", null, s.lastConnectedAt ? new Date(s.lastConnectedAt).toLocaleTimeString() : "—"), h("span", null, "最近连接"))
				),
				s.registryMissing
					? h("p", { className: "qfm-msg err" },
						"⚠ 面板能拨通（" + String(s.dialToolCount) + " 个工具），但 DSH 原生客户端没有注册这台服务器的任何工具，模型目前一个都看不到、也调不了。\n"
						+ "常见原因：加载补丁尚未写入（保存一次即写入），或写完还没重启 DSH。Token 现在直写进补丁，不需要再设环境变量。")
					: null,
				s.lastError ? h("p", { className: "qfm-msg err" }, "上次错误: " + s.lastError) : null,
				state.cfgError ? h("p", { className: "qfm-msg err" }, state.cfgError) : null,
				// 从局域网地址打开面板时，宿主不会把 Token 交给浏览器。用户会看到
				// 一个空的 Token 框，很容易以为凭证丢了——这里说明原因，
				// 并指出「留空保存不会清掉它」。
				state.credentialVisible === false
					? h("p", { className: "qfm-msg" },
						"当前不是从本机打开面板，宿主不返回已保存的 Token。输入框为空属正常：留空保存会保留原凭证；要改 Token 请在本机面板里操作。")
					: null,
				h(QuickImport, null),
				h(
					Field,
					{ label: "服务器名（决定工具前缀 mcp__<name>__）" },
					h("input", {
						className: "qfm-input",
						value: d.name || "",
						placeholder: "my-mcp",
						onChange: (e) => actions.patchDraft({ name: e.target.value })
					})
				),
				h(
					Field,
					{ label: "传输方式" },
					h(
						"div",
						{ className: "qfm-row" },
						h("button", {
							className: "qfm-btn" + (d.transport !== "stdio" ? " primary" : ""),
							onClick: () => actions.patchDraft({ transport: "streamable-http" })
						}, "HTTP"),
						h("button", {
							className: "qfm-btn" + (d.transport === "stdio" ? " primary" : ""),
							onClick: () => actions.patchDraft({ transport: "stdio" })
						}, "stdio")
					)
				),
				d.transport === "stdio"
					? h(
						"div",
						null,
						h(Field, { label: "命令（如 node / python）" },
							h("input", {
								className: "qfm-input",
								value: d.command || "",
								placeholder: "node",
								onChange: (e) => actions.patchDraft({ command: e.target.value })
							})
						),
						h(Field, { label: "参数（每行一个）" },
							h("textarea", {
								className: "qfm-ta",
								style: { minHeight: "80px" },
								value: d.argsText || "",
								placeholder: "D:\\dev\\mcp\\node_modules\\pkg\\dist\\index.js",
								onChange: (e) => actions.patchDraft({ argsText: e.target.value })
							})
						),
						h(Field, { label: "环境变量（每行 KEY=VALUE）" },
							h("textarea", {
								className: "qfm-ta",
								style: { minHeight: "70px" },
								value: d.envText || "",
								placeholder: "PYTHONPATH=D:\\dev\\mcp\\pkg",
								onChange: (e) => actions.patchDraft({ envText: e.target.value })
							})
						)
					  )
					: h(
						"div",
						null,
						h(Field, { label: "服务器地址" },
							h("input", {
								className: "qfm-input",
								value: d.url || "",
								placeholder: "http://192.168.x.x:8765/mcp",
								onChange: (e) => actions.patchDraft({ url: e.target.value })
							})
						),
						h(
							Field,
							{ label: "Token" },
							h(
								"div",
								{ className: "qfm-row" },
								h("input", {
									className: "qfm-input",
									type: state.showToken ? "text" : "password",
									value: d.token || "",
									placeholder: "留空表示无需鉴权",
									onChange: (e) => actions.patchDraft({ token: e.target.value })
								}),
								h("button", { className: "qfm-btn", onClick: () => actions.toggleShowToken() }, state.showToken ? "隐藏" : "显示"),
								h("button", {
									className: "qfm-btn",
									title: "清空输入框里的凭证（点保存后生效）",
									onClick: () => actions.patchDraft({ token: "", tokenConfigured: false, clearToken: true })
								}, "清除")
							),
							// 「解不开」和「没设」在输入框里看起来一模一样（都是空），
							// 但补救方式完全不同：前者必须重填，后者是本来就不需要。
							d.tokenUnreadable
								? h("span", { className: "qfm-msg err" },
									"⚠ 本地保存的 Token 来自旧版加密格式，已无法读取。请重新粘贴一次 Token，否则连接会一直 401。")
								: d.tokenConfigured && !d.token
									? h("span", { className: "qfm-msg" }, "已保存 Token，留空即保持原值；输入新值才会覆盖。")
									: null
						)
					  ),
				h(
					"div",
					{ className: "qfm-row" },
					h(Switch, {
						label: "启用该服务器",
						checked: d.enabled !== false,
						onChange: (v) => actions.patchDraft({ enabled: v })
					}),
					h(Switch, {
						label: "自动重连",
						checked: d.autoReconnect !== false,
						onChange: (v) => actions.patchDraft({ autoReconnect: v })
					})
				),
				h(Field, { label: "审批策略（跟随 DSH 时由官方策略决定问不问）" },
					h("div", { className: "qfm-chips" },
						[["inherit", "继承总开关"], ["follow", "跟随 DSH"], ["manual", "手动（逐工具）"]].map(([value, label]) =>
							h("button", {
								key: value,
								className: "qfm-chip",
								"data-active": (d.approvalMode || "inherit") === value ? "true" : "false",
								onClick: () => actions.patchDraft({ approvalMode: value })
							}, label)
						)
					)
				),
				h(
					"div",
					{ className: "qfm-row" },
					h("button", { className: "qfm-btn primary", disabled: state.busy, onClick: () => actions.test() }, state.busy ? "连接中…" : "连接测试"),
					h("button", { className: "qfm-btn", disabled: state.busy, onClick: () => actions.save() }, state.busy ? "保存中…" : "保存"),
					h("button", { className: "qfm-btn", disabled: state.busy, onClick: () => actions.reconnect() }, "立即重连"),
					h("button", { className: "qfm-btn", disabled: !state.activeId, onClick: () => actions.loadToolsForce() }, "同步工具"),
					// stdio 也要能看工具：它的工具来自 ctx.tools 注册表，正是可管理的那批。
					// 之前这里把 stdio 直接禁用，等于把本地服务器唯一的入口关掉了。
					h("button", { className: "qfm-btn", disabled: !state.activeId, onClick: () => { if (state.activeId) { void loadTools(false); actions.go("tools"); } } }, "查看工具")
				),
				h("details", { className: "qfm-adv" },
					h("summary", null, "高级：调用超时 / 写入 profile"),
					// 加载补丁里的 Authorization 现在直写面板里填的 Token。
					// 这里如实说明落点，让用户知道「保存」等于「原生工具可用」，
					// 不必再去启动脚本里摆环境变量。
					d.transport !== "stdio"
						? h(Field, { label: "Token 落点" },
							h("span", { className: "qfm-msg" },
								"面板里填的 Token 会直写进加载补丁（cordis.patch.yml）的 Authorization 头，DSH 原生工具直接用它。"
								+ "写入后需重启 DSH 生效。该文件含明文凭证，已在 .gitignore 中、不入库，权限按仅当前用户收紧。")
						)
						: null,
					h(Field, { label: "toolCallTimeoutMs" },
						h("input", {
							className: "qfm-input",
							value: String(d.toolCallTimeoutMs || 60000),
							onChange: (e) => actions.patchDraft({ toolCallTimeoutMs: e.target.value })
						})
					),
					h(Field, { label: "profile（写入 cordis.patch.yml 的目标，留空自动检测）" },
						h("input", {
							className: "qfm-input",
							value: state.profile || "",
							placeholder: "desktop",
							onChange: (e) => { state.profile = e.target.value; publish(); }
						})
					)
				)
			);
		}

		function ImportCard() {
			const imp = state.imp;
			const pending = state.importPending;
			return h(
				"div",
				{ className: "qfm-card" },
				h(Head, { title: "备份、导入与导出", onBack: () => actions.go("home") }),
				h(BackupSection, null),
				h("hr", { style: { border: "none", borderTop: "1px solid rgba(255,255,255,.1)", margin: "16px 0" } }),
				h(
					"p",
					{ className: "qfm-sub" },
					"粘贴任意 MCP 客户端通用的 mcpServers JSON（兼容 Claude Desktop / Chatbox 等导出格式）。解析校验 → 确认应用 → 可选写入插件加载补丁 cordis.patch.yml，注册为原生工具 ",
					h("b", null, "mcp__" + ((pending && pending.serverName) || (state.draft && state.draft.name) || "mcp") + "__工具名"),
					"。"
				),
				h(
					"div",
					{ className: "qfm-field" },
					h("span", null, "JSON 配置（mcpServers 格式）"),
					h("textarea", {
						className: "qfm-ta",
						style: { minHeight: "150px" },
						spellCheck: false,
						value: state.importText,
						placeholder: '{\n  "mcpServers": {\n    "my-mcp": {\n      "url": "http://192.168.x.x:8765/mcp",\n      "headers": { "Authorization": "Bearer <token>" }\n    }\n  }\n}',
						onChange: (e) => actions.patchImportText(e.target.value)
					})
				),
				state.importError ? h("p", { className: "qfm-msg err" }, "✗ " + state.importError) : null,
				state.importWarn && state.importWarn.length
					? h("p", { className: "qfm-msg" }, state.importWarn.map((w) => "⚠ " + w).join("\n"))
					: null,
				pending
					? h(
						"p",
						{ className: "qfm-msg ok" },
						"✓ 校验通过：服务器「" + pending.serverName + "」→ " + pending.url + " · Token " + maskToken(pending.token) + "\n再次点击「确认应用」写入；「撤销」返回重新编辑。"
					  )
					: null,
				h(
					"div",
					{ className: "qfm-row" },
					h(
						"button",
						{ className: "qfm-btn primary", disabled: state.busy, onClick: () => actions.applyOrParse() },
						pending ? "✓ 确认应用" : "解析并校验"
					),
					pending ? h("button", { className: "qfm-btn", onClick: () => actions.cancelPending() }, "撤销") : null,
					h(
						"button",
						{ className: "qfm-btn", disabled: state.busy || !pending, onClick: () => actions.importToDsh() },
						"应用并写入加载补丁"
					),
					h("button", { className: "qfm-btn", onClick: () => actions.genJson() }, "生成当前配置"),
					h("button", { className: "qfm-btn", onClick: () => actions.copySnippet() }, "复制 JSON")
				),
				imp
					? h("p", { className: "qfm-sub" }, (imp.imported ? "加载补丁：已写入 ✓ → " : "加载补丁：未写入（目标 ") + imp.cordisPath + (imp.imported ? "" : "）"))
					: null,
				h(
					"div",
					{ className: "qfm-row" },
					h(
						"button",
						{ className: "qfm-btn danger", disabled: state.busy || !(imp && imp.imported), onClick: () => actions.removeImport() },
						confirmLabel("remove:bridge", "移除桥接（保留插件）", "确认移除桥接？")
					)
				),
				h(
					"p",
					{ className: "qfm-sub" },
					"写入的是插件自身的 cordis.patch.yml（自动备份，最多保留 5 份），重启 DSH 后原生工具生效；卸载插件时该补丁随包自动清除，无需手动清理。stdio 与 streamable-http 都会写入，二者在面板里都能查看工具、设置启用/审批与调试——连接方始终是 DSH 原生 mcp-client，面板只读注册表。"
				)
			);
		}

		function ToolsCard() {
			const q = state.search.trim().toLowerCase();
			const list = state.tools.filter((t) => !q || t.name.toLowerCase().indexOf(q) >= 0 || (t.description || "").toLowerCase().indexOf(q) >= 0);
			const enabledCount = state.tools.filter((t) => t.enabled).length;
			const approvalCount = state.tools.filter((t) => t.approval).length;
			// 生效策略来自宿主，不在这里二次推导：面板显示的和管线真正用到的必须是同一个值。
			const following = state.tools.length > 0 && state.tools.every((t) => t.effective && t.effective.follow);
			const server = (state.servers || []).find((s) => s.id === state.activeId) || {};
			const tier = server.budgetTier || "full";
			// 本服务器的工具总数来自当前工具列表，不依赖后端另给一个计数字段：
			// 那个字段（budgetHidden）只存在于 /budget 响应，/status 里没有，
			// 而这张卡片读的是 /status 的 servers。直接用 tools.length 更可靠。
			const toolTotal = state.tools.length;
			const cat = state.gateway && state.gateway.catalog;
			const catLabel = cat && cat.enabled !== false ? (cat.mode === "summary" ? "名字+摘要" : "名字") : "关闭";
			return h(
				"div",
				{ className: "qfm-card" },
				h(
					"h2",
					null,
					"🛠 工具策略",
					h("span", { className: "qfm-badge" },
						following
							? enabledCount + "/" + state.tools.length + " 启用 · 审批跟随 DSH"
							: enabledCount + "/" + state.tools.length + " 启用 · " + approvalCount + " 需审批"),
					h("span", {
						className: "qfm-badge",
						style: { cursor: "pointer" },
						title: "工具目录 · 点击进入网关与目录设置",
						onClick: () => { void loadGateway(); actions.go("gateway"); }
					}, "目录 " + catLabel)
				),
				h(
					"div",
					{ className: "qfm-row", style: { alignItems: "center", gap: "8px" } },
					h("span", { className: "qfm-sub", style: { margin: 0 } }, "上下文投放"),
					h("div", { className: "qfm-chips" },
						[["full", "按需展开"], ["off", "不投放"]].map(([value, label]) =>
							h("button", {
								key: value,
								className: "qfm-chip",
								// lazy 是旧值：统一配置后它与 full 等价，都算「按需展开」。
								"data-active": (tier === "off" ? value === "off" : value === "full") ? "true" : "false",
								onClick: () => actions.setBudgetTier(server.id, value)
							}, label)
						)
					)
				),
				h(
					"p",
					{ className: "qfm-sub" },
					tier === "off"
						? "不投放：既不出现在提示词里，也不能被检索取回，调用一律拒绝。（等价于这台服务器不存在）"
						: "按需展开：提示词里只有 mcp_hub_tools 一个工具名与服务器列表，"
							+ "工具名要 server= 才展开、参数要 names= 才取回。"
							+ (toolTotal ? " 当前 " + toolTotal + " 个工具的 schema 全部不在请求里。" : "")
				),
				following
					? h("p", { className: "qfm-sub" },
						"该服务器的审批正在跟随 DSH，逐个工具的「需审批」不生效——问不问由会话策略（ask / never）决定。要恢复逐工具控制，在「审批」页把该服务器设为「手动」。")
					: null,
				h(
					"div",
					{ className: "qfm-row" },
					h("input", {
						className: "qfm-input",
						style: { flex: "1", minWidth: "140px" },
						placeholder: "搜索工具名或描述…",
						value: state.search,
						onChange: (e) => actions.setSearch(e.target.value)
					}),
					h("button", { className: "qfm-btn", onClick: () => actions.loadTools(true) }, state.toolsLoading ? "同步中…" : "刷新工具列表"),
					h("button", { className: "qfm-btn", onClick: () => actions.setPolicyAll({ enabled: true }) }, "全开"),
					h("button", { className: "qfm-btn", onClick: () => actions.setPolicyAll({ enabled: false }) }, "全关"),
					h("button", { className: "qfm-btn", disabled: following, onClick: () => actions.setPolicyAll({ approval: true }) }, "审批全开"),
					h("button", { className: "qfm-btn", disabled: following, onClick: () => actions.setPolicyAll({ approval: false }) }, "审批全关")
				),
				list.length
					? h("div", { className: "qfm-tools" }, list.map((t) => h(ToolRow, { key: t.name, tool: t })))
					: h("div", { className: "qfm-empty" }, state.toolsLoading ? "加载中…" : "暂无工具——先点「连接测试」或「刷新工具列表」")
			);
		}

		function RecordsCard(props) {
			const embedded = props && props.embedded;
			const days = state.days;
			const today = new Date();
			const dayLabel = (day) => {
				const d = new Date(day + "T00:00:00");
				const diff = Math.floor((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - d) / 86400000);
				if (diff === 0) return "今天";
				if (diff === 1) return "昨天";
				return day;
			};
			const head = embedded
				? h("div", { className: "qfm-row" },
						h("span", { className: "qfm-sub" }, (state.day || "") + " · " + String(state.records.length) + " 条"),
						h("button", { className: "qfm-btn", onClick: () => actions.refreshAll() }, "刷新"),
						h("button", { className: "qfm-btn danger", onClick: () => actions.deleteDay(state.day) }, confirmLabel("day:" + state.day, "删除当天", "确认删除？"))
				  )
				: h(
						"h2",
						null,
						"🕘 调用记录",
						h("span", { className: "qfm-badge" }, days.reduce((n, d) => n + d.count, 0) + " 条")
				  );
			return h(
				"div",
				{ className: embedded ? "qfm-embedded" : "qfm-card" },
				head,
				embedded ? null : h(
					"div",
					{ className: "qfm-row" },
					h("button", { className: "qfm-btn", onClick: () => actions.refreshAll() }, "刷新"),
					h("button", { className: "qfm-btn danger", onClick: () => actions.clearAll() }, confirmLabel("clear:records", "清空全部", "确认清空？"))
				),
				(embedded ? false : true) && days.length
					? h(
							"div",
							{ className: "qfm-chips" },
							days.map((d) =>
								h(
									"span",
									{
										key: d.day,
										className: "qfm-chip",
										"data-active": state.day === d.day ? "true" : "false",
										onClick: () => actions.loadDay(d.day)
									},
									dayLabel(d.day) + " · " + d.count,
									h("span", {
										className: "x",
										title: "删除当天",
										onClick: (e) => {
											e.stopPropagation();
											actions.deleteDay(d.day);
										}
									}, "×")
								)
							)
					  )
					: null,
				state.records.length
					? h(
							"div",
							{ className: "qfm-records" },
							state.records.map((r, i) =>
								h(
									"div",
									{ key: i, className: "qfm-rec", onClick: () => actions.toggleRec(i) },
									h(
										"div",
										{ className: "qfm-rec-line" },
										h("span", { className: "qfm-badge" }, r.source === "debug" ? "调试" : "Agent"),
										h("span", { className: "qfm-rec-tool" }, r.tool),
										h("span", { className: "qfm-badge " + (r.ok ? "ok" : "err") }, r.ok ? "ok" : "失败"),
										h("span", { className: "qfm-sub" }, r.ms + "ms"),
										h("span", { className: "qfm-sub" }, (r.ts || "").slice(11, 19))
									),
									i === state.recExpanded
										? h(
												"div",
												{ className: "qfm-detail" },
												h("pre", { className: "qfm-pre" }, "参数: " + JSON.stringify(r.args, null, 2)),
												r.error ? h("pre", { className: "qfm-pre" }, "错误: " + r.error) : null,
												h("p", { className: "qfm-sub" }, "决策: " + (r.decision || "-") + " · " + (r.ts || ""))
										  )
										: null
								)
							)
					  )
					: h("div", { className: "qfm-empty" }, "暂无记录")
			);
		}

		function ApprovalCard() {
			const g = state.approval || { followDsh: true };
			const info = state.approvalInfo || {};
			const grants = state.grants || [];
			const follow = g.followDsh !== false;
			const policyLabel = (p) => (p === "never" ? "never（不弹窗，直接放行）" : p === "ask" ? "ask（走官方审批弹窗）" : "未知");
			const modeLabel = (m) => (m === "follow" ? "跟随 DSH" : m === "manual" ? "手动（逐工具）" : "继承总开关");
			// 三态选择用一排 chips，而不是 select：这台机器的设置面板里
			// 之前没有任何 select，多引入一种控件只会让人多找一次。
			const modeChips = (s) =>
				h(
					"div",
					{ className: "qfm-chips" },
					[
						["inherit", "继承总开关"],
						["follow", "跟随 DSH"],
						["manual", "手动（逐工具）"]
					].map(([value, label]) =>
						h(
							"button",
							{
								key: value,
								className: "qfm-chip",
								"data-active": (s.approvalMode || "inherit") === value ? "true" : "false",
								onClick: () => void actions.setServerApproval(s.id, value)
							},
							label
						)
					)
				);
			return h(
				"div",
				{ className: "qfm-card" },
				h("h2", null, h(Pill, { tone: info.available ? "on" : "warn", text: info.available ? "已接入" : "未接入" }), "审批"),
				h(
					"p",
					{ className: "qfm-sub" },
					"打开总开关后，MCP 工具不再由本插件自己决定问不问，而是走 DSH 官方审批：同一个 ctx.approval、同一套 ask / never 折叠、同一个审批面板、同一份 allowed-once / rejected / cancelled / unavailable 结果词表。"
				),
				h(
					"div",
					{ className: "qfm-row" },
					h(Switch, {
						label: "审批跟随 DSH（总开关）",
						checked: follow,
						onChange: (v) => void actions.setGlobalFollow(v)
					}),
					h("span", { className: "qfm-badge" }, info.available ? "policy: " + policyLabel(info.policy) : "不可用")
				),
				info.available
					? h(
						"div",
						{ className: "qfm-grid" },
						h("div", { className: "qfm-stat" }, h("b", null, policyLabel(info.defaultPolicy)), h("span", null, "部署默认策略")),
						h("div", { className: "qfm-stat" }, h("b", null, String((info.sessions || []).length)), h("span", null, "活跃会话")),
						info.presets && info.presets.current
							? h("div", { className: "qfm-stat" }, h("b", null, String(info.presets.current)), h("span", null, "当前权限预设"))
							: null
					  )
					: h("p", { className: "qfm-msg err" }, info.reason || "未检测到官方审批服务；跟随模式下无法询问，会按 fail closed 处理。"),
				h(
					"p",
					{ className: "qfm-sub" },
					"ask 时走审批卡片：「允许一次」只放行这一次，「本对话内允许」才会记住该工具；never 时不弹窗、直接放行——这是官方预设（如 danger-full-access）表达「不要提示」的方式，不是拒绝。MCP 工具没有沙箱，所以这里不套用「升权被拒」那套映射。"
				),
				h(
					"p",
					{ className: "qfm-sub" },
					"总开关打开时，会话授权只对「同一工具」在「当前这次对话」内生效：点「本对话内允许」批准过一次，后续调用不再重复弹窗；换对话即失效，因为授权记在会话上而不是记在配置里。"
				),
				h(
					"div",
					{ className: "qfm-row" },
					h("span", { className: "qfm-badge" }, String(grants.length) + " 条会话授权"),
					h("button", { className: "qfm-btn", disabled: !grants.length, onClick: () => void actions.revokeGrants() }, "清空本次授权")
				),
				grants.length
					? h(
						"div",
						{ className: "qfm-tools" },
						grants.map((x, i) =>
							h(
								"div",
								{ key: String(i), className: "qfm-tool" },
								h(
									"div",
									{ className: "qfm-tool-head" },
									h("span", { className: "qfm-tool-name" }, x.server + " / " + (x.tool || "（整台服务器）")),
									h("span", { className: "qfm-badge ok" }, "已授权"),
									h("span", { className: "qfm-sub" }, (x.session || "").slice(0, 8))
								)
							)
						)
					  )
					: null,
				h(
					"details",
					{ className: "qfm-adv" },
					h("summary", null, "分服务器覆盖（" + String((state.servers || []).length) + "）"),
					h(
						"div",
						{ className: "qfm-tools" },
						(state.servers || []).length
							? (state.servers || []).map((s) =>
								h(
									"div",
									{ key: s.id, className: "qfm-tool" },
									h(
										"div",
										{ className: "qfm-tool-head" },
										h("span", { className: "qfm-tool-name" }, sanitizeName(s.serverName, "mcp")),
										h("span", { className: "qfm-badge" }, modeLabel(s.approvalMode)),
										s.approvalEffective && s.approvalEffective.follow
											? h("span", { className: "qfm-badge ok" }, "跟随")
											: h("span", { className: "qfm-badge" }, "手动")
									),
									modeChips(s)
								)
							)
							: h("div", { className: "qfm-empty" }, "还没有服务器")
					)
				)
			);
		}

		function Head(props) {
			return h(
				"div",
				{ className: "qfm-head" },
				props.onBack ? h("button", { className: "qfm-back", onClick: props.onBack }, "‹ 返回") : null,
				h("h2", null, props.title),
				props.right || null
			);
		}

		// 网关与目录：mcp_hub_tools 检索工具的可调参数 + 按需档位的常驻工具目录。
		// 保存立即生效，不需要重启——网关与目录每次装配都现读配置。
		function GatewayCard() {
			const g = state.gateway;
			const d = state.gatewayDraft || {};
			const cd = state.catalogDraft || {};
			const cat = (g && g.catalog) || {};
			const preview = (cat.preview && cat.preview.text) || "";
			const bytes = (cat.preview && cat.preview.bytes) || 0;
			if (!g) return null;
			const rows = [
				["searchLimit", "检索单次返回上限", "1–20", "模型一次「搜索」最多看到几条命中结果"],
				["catalogLimit", "目录名单上限", "1–500", "未命中回落时列出的工具名条数"],
				["schemaMaxBytes", "取回字节预算", "2000–128000", "单个工具 schema 取回时的体积上限，超了自动降级为摘要"],
				["loadBatchMax", "单次批量取回上限", "1–50", "一次 names 取回最多带几台工具的完整参数"],
				["revealMax", "可调用列表上限", "0 = 不限", "取回过的工具默认一直留在可调用列表（0 = 不设上限）；模型可用 release 自己决定移出谁，插件不会偷偷淘汰"]
			];
			return h(
				"div",
				{ className: "qfm-card" },
				h(Head, { title: "网关与目录", onBack: () => actions.go("home") }),
				h(
					"p",
					{ className: "qfm-sub" },
					"「按需」档位下，模型先用检索工具 mcp_hub_tools 查目录、再取回完整参数。这里调它的参数，保存后下一步请求即生效。"
				),
				rows.map(([key, label, range, hint]) =>
					h(
						"div",
						{ className: "qfm-field", key },
						h("span", null, label + "（" + range + "）"),
						h("input", {
							className: "qfm-input",
							value: d[key] || "",
							inputMode: "numeric",
							onChange: (e) => actions.patchGateway({ [key]: e.target.value })
						}),
						h("span", { className: "qfm-sub" }, hint)
					)
				),
				h(
					"div",
					{ className: "qfm-field" },
					h(Switch, {
						label: "工具目录常驻系统提示词（按需档位的工具名模型开局即可见）",
						checked: cd.enabled !== false,
						onChange: (v) => actions.patchCatalogDraft({ enabled: v })
					})
				),
				cd.enabled !== false
					? h(
							"div",
							null,
							h(
								"div",
								{ className: "qfm-field" },
								h(Switch, {
									label: "能力摘要：在服务器名后面挂一串自动生成的特征词",
									checked: cd.capabilities !== false,
									onChange: (v) => actions.patchCatalogDraft({ capabilities: v })
								}),
								h("span", { className: "qfm-sub" },
									"特征词从工具名/描述/参数名里现算，不是手写文案——新加一台服务器不用改任何提示词，摘要自己就长出来。每台多花约 15–20 token。")
							),
							h(
								"div",
								{ className: "qfm-field" },
								h("span", null, "目录粒度"),
								h(
									"div",
									{ className: "qfm-chips" },
									[["names", "仅名字"], ["summary", "名字 + 摘要"]].map(([value, label]) =>
										h("button", {
											key: value,
											className: "qfm-chip",
											"data-active": (cd.mode || "names") === value ? "true" : "false",
											onClick: () => actions.patchCatalogDraft({ mode: value })
										}, label)
									)
								),
								h("span", { className: "qfm-sub" }, "摘要模式下每个工具多带一句话用途，成本约为仅名字的 3 倍")
							),
							h(
								"div",
								{ className: "qfm-field" },
								h("span", null, "目录上限（1–500）"),
								h("input", {
									className: "qfm-input",
									value: String(cd.limit || 200),
									inputMode: "numeric",
									onChange: (e) => actions.patchCatalogDraft({ limit: e.target.value })
								}),
								h("span", { className: "qfm-sub" }, "跨服务器累计最多列几个工具名，超出的进检索兜底")
							),
							h("span", { className: "qfm-sub" },
								preview
									? "当前预览 · " + bytes + " 字节 ≈ " + Math.round(bytes / 4) + " token（粗估）"
									: "当前没有按需服务器，目录为空"),
							h("pre", { className: "qfm-pre" }, preview || "（当前没有按需服务器，目录为空）"),
							preview
								? h(
										"div",
										{ className: "qfm-row" },
										h("button", {
											className: "qfm-btn",
											onClick: () => {
												try {
													if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(preview);
													setMsg("已复制目录预览（与模型实际收到的逐字节一致）", "ok");
												} catch (e) {
													setMsg("复制失败: " + e.message, "err");
												}
											}
										}, "复制预览")
								  )
								: null
					  )
					: null,
				h(
					"div",
					{ className: "qfm-field" },
					h(Switch, {
						label: "JIT 触发提示：当这一轮出现某台服务器的信号时补一行提示",
						checked: (state.hintDraft || {}).enabled === true,
						onChange: (v) => actions.patchHintDraft({ enabled: v })
					}),
					h("span", { className: "qfm-sub" },
						"默认关闭。打开后，本轮出现 adb / logcat / tombstone / *.so 这类信号、而对应服务器本会话还没用过时，补一行「某台服务器有这类工具，用 mcp_hub_tools 查」。严格节流：每轮最多 1 条、每台每会话 1 次、总计不超过上限；你说「找不到工具」时解除限制。")
				),
				(state.hintDraft || {}).enabled === true
					? h(
							"div",
							null,
							[
								["maxTotal", "每会话总提示上限（0–20）", "本会话最多补几行，超了就不再提示"],
								["maxPerServer", "每台服务器上限（0–10）", "同一台服务器在一个会话里最多提示几次"]
							].map(([key, label, hint]) =>
								h(
									"div",
									{ className: "qfm-field", key },
									h("span", null, label),
									h("input", {
										className: "qfm-input",
										value: String((state.hintDraft || {})[key] || ""),
										inputMode: "numeric",
										onChange: (e) => actions.patchHintDraft({ [key]: e.target.value })
									}),
									h("span", { className: "qfm-sub" }, hint)
								)
							)
					  )
					: null,
				h(
					"div",
					{ className: "qfm-row" },
					h("button", { className: "qfm-btn primary", disabled: state.busy, onClick: () => actions.saveGateway() }, "保存"),
					h("button", { className: "qfm-btn", disabled: state.busy, onClick: () => actions.resetGatewayDraft() }, "还原为已保存值")
				)
			);
		}

		// 整插件备份与恢复：一个 JSON 装下服务器列表、工具策略与加载补丁。
		// 内嵌在「备份、导入与导出」页里，不单独占一块区域。
		function BackupSection() {
			const total = (state.servers || []).length;
			const policies = (state.servers || []).reduce((n, s) => n + Object.keys(s.tools || {}).length, 0);
			const fileRef = react.useRef ? react.useRef(null) : { current: null };
			return h(
				"div",
				null,
				h("p", { className: "qfm-sub", style: { marginTop: 0 } },
					"整插件备份：导出 " + total + " 个服务器、 " + policies + " 条工具策略与加载补丁，换机或重装后一键还原。备份含 Token，请自行保管。"),
				h(
					"div",
					{ className: "qfm-row", style: { marginBottom: "10px" } },
					h("button", { className: "qfm-btn primary", disabled: state.busy, onClick: () => actions.exportBackup() }, "导出备份 JSON"),
					h("button", { className: "qfm-btn", disabled: state.busy, onClick: () => fileRef.current && fileRef.current.click() }, "导入备份…"),
					h("input", {
						type: "file",
						accept: ".json,application/json",
						style: { display: "none" },
						ref: fileRef,
						onChange: (e) => {
							const f = e.target.files && e.target.files[0];
							if (f) void actions.importBackupFile(f);
							e.target.value = "";
						}
					})
				),
				h(
					"div",
					{ className: "qfm-row" },
					h("span", { className: "qfm-sub", style: { flex: "0 0 auto" } }, "导入方式："),
					h("button", {
						className: "qfm-btn" + (state.backupMode === "merge" ? " primary" : ""),
						onClick: () => actions.setBackupMode("merge")
					}, "合并（保留现有）"),
					h("button", {
						className: "qfm-btn" + (state.backupMode === "replace" ? " primary" : ""),
						onClick: () => actions.setBackupMode("replace")
					}, "覆盖（清空后导入）")
				)
			);
		}

		// 本地 MCP：扫描 DSH 已连接的 mcp-client 实例，一键接管进面板。
		function LocalCard() {
			const list = state.localServers || [];
			const pending = list.filter((s) => !s.adopted).length;
			return h(
				"div",
				{ className: "qfm-card" },
				h(Head, {
					title: "本地服务器",
					right: h("button", { className: "qfm-btn", disabled: state.busy, onClick: () => void loadLocal() }, "重新扫描")
				}),
				h("p", { className: "qfm-sub" },
					"扫描 DSH profile 里已配置的 mcp-client 实例。接管只把配置纳入面板管理，连接方仍是 DSH 原生 mcp-client，工具前缀不变。" +
					(pending ? "（发现 " + pending + " 个未接管）" : "")),
				list.length
					? h("div", { className: "qfm-tools" },
						list.map((s) =>
							h("div", { key: s.serverName, className: "qfm-tool" },
								h("div", { className: "qfm-tool-head" },
									h("span", { className: "qfm-tool-name" }, s.serverName),
									h(Pill, { tone: s.adopted ? "on" : "warn", text: s.adopted ? "已接管" : "未接管" }),
									h("span", { className: "qfm-badge" }, s.transport === "stdio" ? "stdio" : "HTTP")
								),
								h("div", { className: "qfm-tool-desc" }, s.transport === "stdio" ? s.command : s.url),
								h("div", { className: "qfm-row", style: { marginTop: "6px" } },
									s.adopted
										? h("span", { className: "qfm-sub" }, "已在面板中，可在「服务器」里编辑")
										: h("button", {
											className: "qfm-btn primary",
											disabled: state.busy,
											onClick: () => void actions.adoptLocal(s.serverName)
										}, "接管到面板")
								)
							)
						)
					)
					: h("div", { className: "qfm-empty" }, "未发现 DSH 已配置的 MCP 服务器")
			);
		}

		function HomeView() {
			const list = state.servers || [];
			const onCount = list.filter((s) => s.status === "connected").length;
			const toolTotal = list.reduce((n, s) => n + (s.toolCount || 0), 0);
			return h(
				react.Fragment,
				null,
				h(
					"div",
					{ className: "qfm-card" },
					h(Head, { title: "MCP Hub" }),
					h(
						"div",
						{ className: "qfm-grid" },
						h("div", { className: "qfm-stat" }, h("b", null, String(onCount) + " / " + String(list.length)), h("span", null, "已连接 / 总数")),
						h("div", { className: "qfm-stat" }, h("b", null, String(toolTotal)), h("span", null, "工具总数")),
						h("div", { className: "qfm-stat" }, h("b", null, String((state.logServers || []).reduce((n, x) => n + x.count, 0))), h("span", null, "调用记录"))
					),
					h(
						"div",
						{ className: "qfm-tiles" },
						list.length
							? list.map((s) => {
									const connected = s.status === "connected";
									const tone = s.managed === true ? "on" : connected ? "on" : s.status === "reconnecting" || s.status === "connecting" ? "warn" : "off";
									const text = s.managed === true ? "DSH 托管" : connected ? "已连接" : s.status === "reconnecting" ? "重连中" : s.status === "connecting" ? "连接中" : "未连接";
									return h(
										"div",
										{
											key: s.id,
											className: "qfm-tile",
											onClick: () => actions.openServer(s.id)
										},
										h("div", { className: "qfm-tile-top" },
											h("span", { className: "qfm-tile-name" }, sanitizeName(s.serverName, "mcp")),
											h(Pill, { tone, text })
										),
										h("div", { className: "qfm-tile-meta" },
											h("span", null, s.transport === "stdio" ? "stdio" : "HTTP"),
											h("span", null, String(s.toolCount || 0) + " 工具"),
											connected ? h("span", null, (s.latencyMs || 0) + "ms") : null
										)
									);
							  })
							: h("div", { className: "qfm-empty" }, "还没有服务器，进入「服务器」新增")
					),
					list.some((s) => s.lastError)
						? h("p", { className: "qfm-msg err" },
								list.filter((s) => s.lastError).map((s) => sanitizeName(s.serverName, "mcp") + "：" + s.lastError).join("\n"))
						: null
				),
				h(LocalCard, null),
				h(
					"div",
					{ className: "qfm-card" },
					h(Head, { title: "管理" }),
					h(
						"div",
						{ className: "qfm-nav" },
						h("div", { className: "qfm-nav-item", onClick: () => actions.go("servers") },
							h("span", { className: "grow" }, "服务器",
								h("div", { className: "qfm-nav-sub" }, "新增、编辑、测试、删除，以及逐个服务器的工具开关")),
							h("span", { className: "qfm-nav-sub" }, String(list.length))
						),
						h("div", { className: "qfm-nav-item", onClick: () => { void loadApproval(); actions.go("approval"); } },
							h("span", { className: "grow" }, "审批",
								h("div", { className: "qfm-nav-sub" }, "总开关跟随 DSH 官方审批，分服务器覆盖，以及本次对话内的授权")),
							h("span", { className: "qfm-nav-sub" }, (state.approval && state.approval.followDsh !== false) ? "跟随" : "手动")
						),
						h("div", { className: "qfm-nav-item", onClick: () => { void loadLogServers(); actions.go("logs"); } },
							h("span", { className: "grow" }, "调用日志",
								h("div", { className: "qfm-nav-sub" }, "按服务器、再按日期查看，可逐日清理")),
							h("span", { className: "qfm-nav-sub" }, String((state.logServers || []).reduce((n, x) => n + x.count, 0)))
						),
						h("div", { className: "qfm-nav-item", onClick: () => { void loadGateway(); actions.go("gateway"); } },
							h("span", { className: "grow" }, "网关与目录",
								h("div", { className: "qfm-nav-sub" }, "按需投放的检索参数与常驻工具目录")),
							h("span", { className: "qfm-nav-sub" },
								(() => {
									const lazyCount = (state.servers || []).filter((s) => s.budgetTier === "lazy").length;
									const cat = state.gateway && state.gateway.catalog;
									const on = cat && cat.enabled !== false;
									return on ? lazyCount + " 台按需 · ≤ " + (cat.limit || 200) + " 个名字" : "目录已关";
								})())
						),
						h("div", { className: "qfm-nav-item", onClick: () => actions.go("import") },
							h("span", { className: "grow" }, "备份、导入与导出",
								h("div", { className: "qfm-nav-sub" }, "整插件备份与恢复，粘贴 mcpServers JSON，或写入 cordis.patch.yml")),
							h("span", { className: "qfm-nav-sub" }, String((state.servers || []).length) + " 服务器")
						)
					),
					state.msg ? h("p", { className: "qfm-msg " + state.msgTone }, state.msg) : null
				)
			);
		}

		function ServersView() {
			return h(
				react.Fragment,
				null,
				h(
					"div",
					{ className: "qfm-card" },
					h(Head, { title: "服务器", onBack: () => actions.go("home"), right: h("button", { className: "qfm-btn primary", onClick: () => actions.newServer() }, "新增") }),
					h(
						"div",
						{ className: "qfm-tools" },
						(state.servers || []).length
							? state.servers.map((s) => {
									const connected = s.status === "connected";
									const tone = s.managed === true ? "on" : connected ? "on" : s.status === "reconnecting" || s.status === "connecting" ? "warn" : "off";
									const text = s.managed === true ? "DSH 托管" : connected ? "已连接" : s.status === "reconnecting" ? "重连中" : s.status === "connecting" ? "连接中" : "未连接";
									return h(
										"div",
										{ key: s.id, className: "qfm-tool", style: { cursor: "pointer" }, onClick: () => actions.openServer(s.id) },
										h("div", { className: "qfm-tool-head" },
											h("span", { className: "qfm-tool-name" }, sanitizeName(s.serverName, "mcp")),
											h(Pill, { tone, text }),
											h("span", { className: "qfm-chev" }, "›")
										),
										h("div", { className: "qfm-tool-desc" },
											(s.transport === "stdio" ? "stdio · " + (s.command || "") : s.url || "未填地址") + " · " + String(s.toolCount || 0) + " 个工具")
									);
							  })
							: h("div", { className: "qfm-empty" }, "还没有服务器")
					)
				),
			);
		}

		function EditorView() {
			const isNew = !state.activeId;
			return h(
				"div",
				{ className: "qfm-card" },
				h(Head, {
					title: isNew ? "新增服务器" : "编辑 · " + sanitizeName((state.servers.find((x) => x.id === state.activeId) || {}).serverName, "mcp"),
					onBack: () => actions.go("servers")
				}),
				h(ConnectionCard, null)
			);
		}

		function ToolsView() {
			const current = (state.servers || []).find((x) => x.id === state.activeId);
			return h(
				react.Fragment,
				null,
				h(
					"div",
					{ className: "qfm-card" },
					h(Head, {
						title: "工具" + (current ? " · " + sanitizeName(current.serverName, "mcp") : ""),
						onBack: () => actions.go("editor")
					}),
					h(ToolsCard, null)
				)
			);
		}

		function LogsView() {
			if (!state.logServer) {
				return h(
					"div",
					{ className: "qfm-card" },
					h(Head, { title: "调用日志", onBack: () => actions.go("home") }),
					h(
						"div",
						{ className: "qfm-tools" },
						(state.logServers || []).length
							? state.logServers.map((s) =>
									h(
										"div",
										{ key: s.name, className: "qfm-log-item", onClick: () => actions.openLogServer(s.name) },
										h("div", { className: "qfm-rec-line" },
											h("span", { className: "qfm-rec-tool" }, s.name),
											s.configured ? null : h("span", { className: "qfm-badge" }, "已移除"),
											h("span", { className: "qfm-badge" }, String(s.count) + " 条")
										)
									)
							  )
							: h("div", { className: "qfm-empty" }, "还没有调用记录")
					)
				);
			}
			return h(
				"div",
				{ className: "qfm-card" },
				h(Head, {
					title: "日志 · " + state.logServer,
					onBack: () => { state.logServer = ""; state.days = []; state.records = []; state.day = ""; publish(); }
				}),
				h("div", { className: "qfm-crumb" }, "共 " + String(state.days.length) + " 天"),
				h(
					"div",
					{ className: "qfm-chips" },
					state.days.length
						? state.days.map((d) =>
								h("button", {
									key: d.day,
									className: "qfm-chip",
									"data-active": state.day === d.day,
									onClick: () => void loadDay(d.day)
								}, d.day.slice(5) + " · " + String(d.count))
						  )
						: h("div", { className: "qfm-empty" }, "该服务器没有记录")
				),
				state.day ? h(RecordsCard, { embedded: true }) : null
			);
		}

		function Panel() {
			const [, force] = react.useState(0);
			react.useEffect(() => {
				const sub = () => force((v) => v + 1);
				listeners.add(sub);
				actions.refreshAll();
				const timer = setInterval(() => {
					void loadStatus();
				}, 12000);
				return () => {
					listeners.delete(sub);
					clearInterval(timer);
				};
			}, []);
			const body =
				state.view === "servers" ? h(ServersView, null)
				: state.view === "editor" ? h(EditorView, null)
				: state.view === "tools" ? h(ToolsView, null)
				: state.view === "approval" ? h(
						"div",
						{ className: "qfm-card", style: { padding: "0", border: "none", background: "transparent" } },
						h("div", { className: "qfm-card" }, h(Head, { title: "审批", onBack: () => actions.go("home") }), h(ApprovalCard, null))
				  )
				: state.view === "logs" ? h(LogsView, null)
				: state.view === "gateway" ? h(GatewayCard, null)
				: state.view === "import" ? h(ImportCard, null)
				: h(HomeView, null);
			// 消息栏放在 Panel 层：所有操作（保存、测试、删日志、网关设置…）
			// 的反馈只有首页这一处能看到的话，其他页面里的动作就是「点了没反应」。
			// 首页与服务器页自己渲染过一份，这里对它们不再重复。
			const showGlobalMsg = state.msg && state.view !== "home" && state.view !== "servers";
			return h(
				"div",
				{ className: "qfm-root" },
				showGlobalMsg ? h("p", { className: "qfm-msg " + state.msgTone, style: { margin: 0 } }, state.msg) : null,
				body
			);
		}

		actions.loadToolsForce = () => actions.loadTools(true);

		// MCP 审批卡片：直接接管 conversation.composer 的选举，渲染原生三按钮。
		//
		// 为什么可以接管：conversation.composer 是 kind:"chain"，选举时按 priority
		// 升序逐个调用 select，第一个返回非 null 的条目独占渲染并 break。
		// 我们用 priority 0，排在 ui-approval（priority 1）之前；只对 mcp__ 前缀的
		// 审批返回实例，其余一律返回 null，官方面板照旧处理。
		//
		// 为什么不挂 conversation.approval.detail：那是 ui-approval 声明的 single
		// 插槽，ui-chat 已用默认 priority 占位；再注册会抛
		// "single slot ... already has a registration"，后注册的一方整条插件 failed，
		// 严重时 web boot 直接被拦住（这条之前踩过）。
		//
		// 接管后 pending 上直接带 toolName / sessionId / answer()，
		// 不再需要 /pending 反查，也不再需要 shell.overlay 浮动条。
		//
		// 纯运行时注册：返回的 disposer 在插件卸载时撤掉，官方面板恢复原状。

		function McpApprovalPanel(props) {
			const pending = props && props.matched;
			const [state, setState] = react.useState ? react.useState("idle") : ["idle", () => {}];
			const [done, setDone] = react.useState ? react.useState(false) : [false, () => {}];
			if (!pending) return null;
			const tool = String(pending.toolName || "");
			const shortTool = tool.split("__").slice(2).join("__") || tool;
			const server = tool.split("__")[1] || "";
			const reason = pending.displayReason && pending.displayReason.zh
				? pending.displayReason.zh
				: (pending.displayReason && pending.displayReason.en) || pending.reason || "";
			const settle = async (outcome) => {
				if (state === "busy" || !pending.answerable) return;
				setState("busy");
				try {
					await pending.answer(outcome);
				} catch (e) {
					setState("idle");
				}
			};
			// 一次点击：先写授权，再回答 allowed-once。
			// 顺序不能反——先回答会让调用继续，授权可能还没落库，下一个调用又要问一次。
			const allowSession = async () => {
				if (state === "busy" || !pending.answerable) return;
				setState("busy");
				let granted = false;
				try {
					const r = await api("/mcp-hub/approval", {
						method: "POST",
						body: { action: "grant", session: pending.sessionId, toolName: tool }
					});
					granted = !!(r && r.ok);
				} catch (e) {}
				try {
					setDone(granted);
					await pending.answer("allowed-once");
				} catch (e) {
					setState("idle");
				}
			};
			// 键盘与官方面板一致：Enter 允许一次，Esc 拒绝。
			const onKeyDown = (event) => {
				if (event.defaultPrevented) return;
				const el = event.target;
				if (el && el.closest && el.closest("input, textarea, select, [contenteditable=\"true\"]")) return;
				if (event.key !== "Enter" && event.key !== "Escape") return;
				if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
				event.preventDefault();
				event.stopPropagation();
				if (done) return;
				void settle(event.key === "Enter" ? "allowed-once" : "rejected");
			};
			const buttons = [];
			buttons.push(h(NativeButton, {
				key: "reject",
				variant: "outline",
				disabled: state === "busy" || done,
				onClick: () => void settle("rejected")
			}, "拒绝"));
			buttons.push(h(NativeButton, {
				key: "once",
				variant: "outline",
				disabled: state === "busy" || done,
				onClick: () => void settle("allowed-once")
			}, "允许一次"));
			if (!done) {
				buttons.push(h(NativeButton, {
					key: "session",
					variant: "primary",
					disabled: state === "busy",
					onClick: () => void allowSession()
				}, state === "busy" ? "处理中…" : "本对话内允许"));
			}
			return h(
				"div",
				{ className: "qfm-appr-root", onKeyDown },
				h(
					"div",
					{ className: "qfm-appr-card" },
					h(
						"div",
						{ className: "qfm-appr-strip" },
						h("span", { className: "qfm-appr-dot" }),
						done ? "已允许，本对话内不再询问" : "等待审批"
					),
					h(
						"div",
						{ className: "qfm-appr-body" },
						h("div", { className: "qfm-appr-headline" }, shortTool + (server ? " · " + server : "")),
						reason ? h("div", { className: "qfm-appr-reason" }, reason) : null,
						h("div", { className: "qfm-appr-hint" },
							done
								? "下同一次调用不再弹窗；换对话或重启后失效"
								: "「允许一次」只放行这次；「本对话内允许」会记住这个工具")
					),
					h("div", { className: "qfm-appr-actions" }, buttons)
				)
			);
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => {
				try {
					const unregister = ctx.slots.register(
						{
							name: "settings.section",
							id: "mcp-hub",
							order: 26,
							label: () => "MCP Hub",
							inject: () => ({})
						},
						Panel
					);
					return () => {
						try { unregister(); } catch (e) {}
					};
				} catch (e) {
					return () => {};
				}
			});

			// MCP 审批卡片：接管 conversation.composer 的选举（chain 插槽，按
			// priority 升序调用 select，先命中者独占渲染）。我们 priority 0 排在
			// ui-approval 的 priority 1 之前，只对 mcp__ 前缀返回实例；
			// 其他审批一律 null，官方面板不受影响。
			//
			// 这里不碰 conversation.approval.detail：它是 single 插槽且已被 ui-chat
			// 占用，抢位会让其中一方插件 failed，严重时整个 web boot 被拦住。
			try {
				ctx.slots.inject("conversation.composer", () => {
					try {
						const unregister = ctx.slots.register(
							{
								name: "conversation.composer",
								id: "mcp-hub-approval",
								priority: 0,
								select: ({ pendingInteraction }) => {
									if (!pendingInteraction || pendingInteraction.kind !== "approval") return null;
									const name = String(pendingInteraction.toolName || "");
									// 只接管本插件管理的 MCP 工具；其余交回官方面板。
									if (name.indexOf("mcp__") !== 0) return null;
									if (!pendingInteraction.answerable) return null;
									return pendingInteraction;
								},
								inject: () => ({})
							},
							McpApprovalPanel
						);
						return () => {
							try { unregister(); } catch (e) {}
						};
					} catch (e) {
						return () => {};
					}
				});
			} catch (e) {}
		}

		exports.apply = apply;
		exports.inject = ["slots", "connection"];
		return module.exports;
	}
});
