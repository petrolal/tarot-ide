(function () {
	const vscode = acquireVsCodeApi();

	const sessionTabsEl = document.getElementById('session-tabs');
	const newSessionBtn = document.getElementById('btn-new-session');
	const historyBtn = document.getElementById('btn-session-history');
	const dockEditorBtn = document.getElementById('btn-dock-editor');
	const focusModeBtn = document.getElementById('btn-focus-mode');
	const messagesEl = document.getElementById('messages');
	const reviewBarEl = document.getElementById('review-bar');
	const reviewToggleBtn = document.getElementById('btn-review-toggle');
	const reviewRefreshBtn = document.getElementById('btn-review-refresh');
	const reviewSummaryText = document.getElementById('review-summary-text');
	const reviewFileListEl = document.getElementById('review-file-list');
	const contextMenuEl = document.getElementById('context-menu');
	const slashMenuEl = document.getElementById('slash-menu');
	const hashBtn = document.getElementById('btn-hash');
	const attachBtn = document.getElementById('btn-attach');
	const contextRingEl = document.getElementById('context-ring');
	const contextRingArc = document.getElementById('context-ring-arc');
	const modelPickerBtn = document.getElementById('btn-model-picker');
	const modelPickerLabel = document.getElementById('model-picker-label');
	const modelMenuEl = document.getElementById('model-menu');
	const modelAgentPillsEl = document.getElementById('model-agent-pills');
	const modelOptionsListEl = document.getElementById('model-options-list');
	const effortPillsEl = document.getElementById('effort-pills');
	const modePickerBtn = document.getElementById('btn-mode-picker');
	const modePickerLabel = document.getElementById('mode-picker-label');
	const modeMenuEl = document.getElementById('mode-menu');
	const autonomyPickerBtn = document.getElementById('btn-autonomy-picker');
	const autonomyPickerLabel = document.getElementById('autonomy-picker-label');
	const autonomyEnforcementDot = document.getElementById('autonomy-enforcement-dot');
	const autonomyMenuEl = document.getElementById('autonomy-menu');
	const promptInput = document.getElementById('prompt-input');
	const sendBtn = document.getElementById('btn-send');
	const iconSend = document.getElementById('icon-send');
	const iconStop = document.getElementById('icon-stop');
	const attachmentsEl = document.getElementById('attachments');
	const statusRow = document.getElementById('status-row');
	const statusEl = document.getElementById('status-indicator');

	const RING_CIRCUMFERENCE = 34.56;

	// String catalog injected by the host (see src/views/panelStrings.ts). Keys fall back to
	// themselves so a missing entry degrades to a readable label instead of an empty string.
	const L10N = window.__tarotL10n || {};

	function t(key, ...args) {
		const template = L10N[key] || key;
		return template.replace(/\{(\d+)\}/g, (match, index) => {
			const value = args[Number(index)];
			return value === undefined ? match : String(value);
		});
	}

	let state = {
		agents: [],
		activeAgentId: 'claude',
		mode: 'vibe',
		autonomy: 'acceptFileChanges',
		permissionEnforcement: { kind: 'advisory' },
		isFocusMode: false,
		isRunning: false,
		activeSessionId: '',
		sessions: [],
		attachments: [],
		changedFiles: [],
		messages: [],
		contextPercent: 0,
	};

	let reviewExpanded = false;

	let liveBubbleEl = null;
	let liveBodyEl = null;
	let liveToolsDetails = null;
	let liveToolsSummary = null;
	let liveToolsBody = null;
	let liveToolsCount = 0;
	let liveRawText = '';
	let liveRenderRaf = 0;

	function scheduleLiveRender() {
		if (liveRenderRaf) {
			return;
		}
		liveRenderRaf = window.requestAnimationFrame(() => {
			liveRenderRaf = 0;
			if (liveBodyEl) {
				renderFormattedContent(liveBodyEl, liveRawText);
				messagesEl.scrollTop = messagesEl.scrollHeight;
			}
		});
	}

	function formatElapsed(ms) {
		if (!ms || ms < 1000) {
			return `${Math.max(1, Math.round((ms || 0) / 100) / 10)}s`;
		}
		const totalSec = Math.round(ms / 1000);
		const mins = Math.floor(totalSec / 60);
		const secs = totalSec % 60;
		return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
	}

	function autoResizeInput() {
		promptInput.style.height = 'auto';
		const next = Math.min(promptInput.scrollHeight, 180);
		promptInput.style.height = `${Math.max(next, 40)}px`;
	}

	function updateSendButtonState() {
		if (state.isRunning) {
			sendBtn.disabled = false;
			sendBtn.classList.add('stop');
			sendBtn.title = t('stopExecution');
			iconSend.classList.add('hidden');
			iconStop.classList.remove('hidden');
			return;
		}
		sendBtn.classList.remove('stop');
		sendBtn.title = t('send');
		iconSend.classList.remove('hidden');
		iconStop.classList.add('hidden');
		sendBtn.disabled = promptInput.value.trim().length === 0;
	}

	function renderSessionTabs() {
		sessionTabsEl.textContent = '';
		for (const s of state.sessions || []) {
			const tab = document.createElement('button');
			tab.type = 'button';
			tab.className = `session-tab${s.id === state.activeSessionId ? ' active' : ''}`;
			tab.title = s.title;
			tab.addEventListener('click', () => {
				vscode.postMessage({ type: 'selectSession', sessionId: s.id });
			});

			if (s.isRunning || s.mode === 'spec') {
				const dot = document.createElement('span');
				dot.className = `tab-dot${s.isRunning ? ' running' : ''}`;
				tab.appendChild(dot);
			}

			const title = document.createElement('span');
			title.className = 'tab-title';
			title.textContent = s.title;
			tab.appendChild(title);

			if ((state.sessions || []).length > 1) {
				const close = document.createElement('span');
				close.className = 'tab-close';
				close.textContent = '×';
				close.title = t('closeTab');
				close.addEventListener('click', e => {
					e.stopPropagation();
					vscode.postMessage({ type: 'closeSession', sessionId: s.id });
				});
				tab.appendChild(close);
			}

			sessionTabsEl.appendChild(tab);
		}
	}

	const EFFORT_OPTIONS = [
		{ id: 'auto', labelKey: 'effortAuto' },
		{ id: 'low', labelKey: 'effortLow' },
		{ id: 'medium', labelKey: 'effortMedium' },
		{ id: 'high', labelKey: 'effortHigh' },
		{ id: 'xhigh', labelKey: 'effortXHigh' },
		{ id: 'max', labelKey: 'effortMax' },
	];

	const ALL_POPOVERS = [modelMenuEl, modeMenuEl, autonomyMenuEl, contextMenuEl, slashMenuEl];

	function setOpenPopover(targetMenu, force) {
		const show = typeof force === 'boolean' ? force : targetMenu.classList.contains('hidden');
		for (const menu of ALL_POPOVERS) {
			if (menu) {
				menu.classList.toggle('hidden', menu !== targetMenu || !show);
			}
		}
		return show;
	}

	function toggleModelMenu(force) { setOpenPopover(modelMenuEl, force); }
	function toggleModeMenu(force) { setOpenPopover(modeMenuEl, force); }
	function toggleAutonomyMenu(force) { setOpenPopover(autonomyMenuEl, force); }

	function renderModelAndModePickers() {
		const activeAgent = state.activeAgentId || 'auto';
		const selectedModel = state.selectedModel || 'auto';
		const selectedEffort = state.selectedEffort || 'auto';
		const models = Array.isArray(state.models) ? state.models : [];

		// Compact trigger label: e.g. "agy · Auto" or "agy · Gemini 4 Neon"
		const matchedModel = models.find(m => m.id === selectedModel);
		const effectiveModel = (models.length > 0 && selectedModel !== 'auto' && !matchedModel) ? 'auto' : selectedModel;
		const modelDisplay = effectiveModel === 'auto' ? t('autoLabel') : (matchedModel ? matchedModel.label : effectiveModel);
		const effortSuffix = selectedEffort !== 'auto' ? ` · ${selectedEffort}` : '';
		modelPickerLabel.textContent = `${activeAgent} · ${modelDisplay}${effortSuffix}`;

		const modeMap = { vibe: t('modeDefaultTitle'), spec: t('modeSpecTitle'), plan: t('modePlanTitle') };
		const profiles = Array.isArray(state.agentProfiles) ? state.agentProfiles : [];
		const activeProfileId = state.activeProfileId || (state.mode === 'vibe' ? 'default' : state.mode || 'default');
		const activeProfile = profiles.find(p => p.id === activeProfileId);
		modePickerLabel.textContent = (activeProfile && activeProfile.origin !== 'builtIn')
			? activeProfile.name
			: (modeMap[state.mode] || t('modeDefaultTitle'));
		modePickerBtn.disabled = !!state.isRunning;

		for (const old of modeMenuEl.querySelectorAll('[data-dynamic="profile"]')) {
			old.remove();
		}
		for (const item of modeMenuEl.querySelectorAll('.mode-menu-item')) {
			const isBuiltInActive = (!activeProfile || activeProfile.origin === 'builtIn')
				&& item.dataset.mode === (state.mode || 'vibe');
			item.classList.toggle('active', isBuiltInActive);
		}
		for (const group of [
			{ origin: 'workspace', title: t('workspaceAgentsHeader') },
			{ origin: 'user', title: t('userAgentsHeader') },
		]) {
			const groupProfiles = profiles.filter(p => p.origin === group.origin);
			if (groupProfiles.length === 0) {
				continue;
			}
			const header = document.createElement('div');
			header.className = 'context-popup-header';
			header.dataset.dynamic = 'profile';
			header.textContent = group.title;
			modeMenuEl.appendChild(header);

			for (const p of groupProfiles) {
				const btn = document.createElement('button');
				btn.className = 'mode-menu-item' + (p.id === activeProfileId ? ' active' : '');
				btn.type = 'button';
				btn.dataset.dynamic = 'profile';
				const tag = document.createElement('span');
				tag.className = 'ctx-tag';
				tag.textContent = p.name;
				const desc = document.createElement('span');
				desc.className = 'ctx-desc';
				desc.textContent = p.description || p.id;
				btn.appendChild(tag);
				btn.appendChild(desc);
				btn.addEventListener('click', () => {
					toggleModeMenu(false);
					vscode.postMessage({ type: 'selectProfile', profileId: p.id });
				});
				modeMenuEl.appendChild(btn);
			}
		}

		const autonomyLabelMap = {
			supervised: t('autonomySupervisedTitle'),
			acceptFileChanges: t('autonomyAcceptTitle'),
			approveForMe: t('autonomyApproveTitle'),
		};
		const autonomy = state.autonomy || 'acceptFileChanges';
		autonomyPickerLabel.textContent = autonomyLabelMap[autonomy] || autonomyLabelMap.acceptFileChanges;
		for (const item of autonomyMenuEl.querySelectorAll('.mode-menu-item')) {
			item.classList.toggle('active', item.dataset.autonomy === autonomy);
		}
		const enforcement = state.permissionEnforcement || { kind: 'advisory' };
		autonomyEnforcementDot.classList.toggle('enforced', enforcement.kind === 'enforced');
		autonomyEnforcementDot.title = enforcement.kind === 'enforced'
			? t('enforcementEnforced')
			: t('enforcementAdvisory', enforcement.detail || activeAgent);

		// Agent CLI pills
		modelAgentPillsEl.textContent = '';
		for (const agent of state.agents || []) {
			const pill = document.createElement('button');
			pill.type = 'button';
			pill.className = 'popover-pill' + (agent.id === activeAgent ? ' active' : '');
			pill.disabled = !agent.available;
			pill.textContent = agent.available ? agent.id : t('agentUnavailableLabel', agent.id);
			pill.title = agent.available ? `${agent.displayName}${agent.version ? ' · ' + agent.version : ''}` : (agent.installHint || agent.displayName);
			pill.addEventListener('click', () => {
				vscode.postMessage({ type: 'selectAgent', agentId: agent.id });
			});
			modelAgentPillsEl.appendChild(pill);
		}

		// Model list ("Auto" + dynamic CLI models)
		modelOptionsListEl.textContent = '';
		const allModels = [{ id: 'auto', label: t('autoLabel') }, ...models];
		for (const m of allModels) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'model-option-item' + (m.id === effectiveModel ? ' active' : '');
			const labelSpan = document.createElement('span');
			labelSpan.className = 'model-option-label';
			labelSpan.textContent = m.label;
			row.appendChild(labelSpan);
			if (m.id === effectiveModel) {
				const check = document.createElement('span');
				check.className = 'model-option-check';
				check.textContent = '✓';
				row.appendChild(check);
			}
			row.addEventListener('click', () => {
				vscode.postMessage({ type: 'setModel', model: m.id });
				toggleModelMenu(false);
			});
			modelOptionsListEl.appendChild(row);
		}

		// Reasoning Effort pills
		effortPillsEl.textContent = '';
		for (const opt of EFFORT_OPTIONS) {
			const pill = document.createElement('button');
			pill.type = 'button';
			pill.className = 'popover-pill' + (opt.id === selectedEffort ? ' active' : '');
			pill.textContent = t(opt.labelKey);
			pill.addEventListener('click', () => {
				vscode.postMessage({ type: 'setEffort', effort: opt.id });
			});
			effortPillsEl.appendChild(pill);
		}
	}

	function renderContextRing() {
		const pct = Math.max(0, Math.min(100, state.contextPercent || 0));
		const offset = RING_CIRCUMFERENCE * (1 - pct / 100);
		contextRingArc.setAttribute('stroke-dashoffset', offset.toFixed(2));
		const used = typeof state.contextUsedTokens === 'number' ? state.contextUsedTokens : 0;
		const win = typeof state.contextWindowTokens === 'number' ? state.contextWindowTokens : 200000;
		if (used > 0) {
			const fmtUsed = used >= 1000 ? `${(used / 1000).toFixed(1)}k` : String(used);
			const fmtWin = `${Math.round(win / 1000)}k`;
			contextRingEl.title = t('contextUsageTokens', fmtUsed, fmtWin, pct, state.contextIsReal ? '' : t('estimatedSuffix'));
		} else {
			contextRingEl.title = t('contextUsage', pct);
		}
	}

	function renderAttachments() {
		attachmentsEl.textContent = '';
		const list = state.attachments || [];
		attachmentsEl.classList.toggle('hidden', list.length === 0);
		list.forEach((att, idx) => {
			const chip = document.createElement('span');
			chip.className = 'attachment-chip';

			const label = document.createElement('span');
			label.textContent = `#${att.label}`;
			chip.appendChild(label);

			const rm = document.createElement('button');
			rm.className = 'attachment-remove';
			rm.type = 'button';
			rm.textContent = '×';
			rm.addEventListener('click', () => {
				vscode.postMessage({ type: 'removeAttachment', index: idx });
			});
			chip.appendChild(rm);
			attachmentsEl.appendChild(chip);
		});
	}

	function appendInlineSegments(parent, text) {
		const inlineRegex = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:file:\/\/|https?:\/\/)[^)\s\n]+\))/g;
		let last = 0;
		let m;
		while ((m = inlineRegex.exec(text)) !== null) {
			if (m.index > last) {
				parent.appendChild(document.createTextNode(text.slice(last, m.index)));
			}
			const token = m[0];
			if (token.startsWith('`')) {
				const code = document.createElement('code');
				code.className = 'inline-code';
				code.textContent = token.slice(1, -1);
				parent.appendChild(code);
			} else if (token.startsWith('**')) {
				const strong = document.createElement('strong');
				strong.textContent = token.slice(2, -2);
				parent.appendChild(strong);
			} else {
				const linkMatch = /^\[([^\]\n]+)\]\(((?:file:\/\/|https?:\/\/)[^)\s\n]+)\)$/.exec(token);
				if (linkMatch) {
					const linkBtn = document.createElement('button');
					linkBtn.type = 'button';
					linkBtn.className = 'transcript-link';
					linkBtn.textContent = linkMatch[1];
					linkBtn.title = linkMatch[2];
					const targetUrl = linkMatch[2];
					linkBtn.addEventListener('click', () => {
						vscode.postMessage({ type: 'openLink', url: targetUrl });
					});
					parent.appendChild(linkBtn);
				} else {
					parent.appendChild(document.createTextNode(token));
				}
			}
			last = inlineRegex.lastIndex;
		}
		if (last < text.length) {
			parent.appendChild(document.createTextNode(text.slice(last)));
		}
	}

	function appendTextBlocks(container, text) {
		const lines = text.split('\n');
		let plainBuf = [];
		const flushPlain = () => {
			if (plainBuf.length === 0) { return; }
			const span = document.createElement('span');
			appendInlineSegments(span, plainBuf.join('\n'));
			container.appendChild(span);
			plainBuf = [];
		};
		for (let i = 0; i < lines.length; i++) {
			const hm = lines[i].match(/^(#{1,4})\s+(.+)$/);
			if (hm) {
				flushPlain();
				const h = document.createElement('div');
				h.className = `msg-md-h msg-md-h${hm[1].length}`;
				appendInlineSegments(h, hm[2]);
				container.appendChild(h);
			} else {
				plainBuf.push(lines[i]);
			}
		}
		flushPlain();
	}

	function renderFormattedContent(container, rawText) {
		container.textContent = '';
		const fenceRegex = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
		let lastIndex = 0;
		let match;

		while ((match = fenceRegex.exec(rawText)) !== null) {
			if (match.index > lastIndex) {
				appendTextBlocks(container, rawText.slice(lastIndex, match.index));
			}

			const lang = match[1] || 'code';
			const codeText = match[2];

			const block = document.createElement('div');
			block.className = 'code-block';

			const header = document.createElement('div');
			header.className = 'code-block-header';

			const langEl = document.createElement('span');
			langEl.textContent = lang;
			header.appendChild(langEl);

			const copyBtn = document.createElement('button');
			copyBtn.className = 'code-copy-btn';
			copyBtn.type = 'button';
			copyBtn.textContent = t('copy');
			copyBtn.addEventListener('click', () => {
				if (navigator.clipboard) {
					navigator.clipboard.writeText(codeText).then(() => {
						copyBtn.textContent = t('copied');
						setTimeout(() => { copyBtn.textContent = t('copy'); }, 1200);
					}).catch(() => {});
				}
			});
			header.appendChild(copyBtn);
			block.appendChild(header);

			const pre = document.createElement('pre');
			pre.textContent = codeText;
			block.appendChild(pre);
			container.appendChild(block);

			lastIndex = fenceRegex.lastIndex;
		}

		if (lastIndex < rawText.length) {
			appendTextBlocks(container, rawText.slice(lastIndex));
		}
	}

	function createToolCallCard(tool) {
		const row = document.createElement('div');
		row.className = 'tool-call-card';
		const icon = document.createElement('span');
		icon.className = 'tool-call-icon';
		const raw = String(tool || '');
		const lower = raw.toLowerCase();
		icon.textContent = lower.includes('write') || lower.includes('edit') || lower.includes('replace')
			? '✎'
			: lower.includes('bash') || lower.includes('shell') || lower.includes('run')
				? '⌘'
				: '◈';
		const labelSpan = document.createElement('span');
		labelSpan.className = 'tool-call-name';
		const parts = raw.split(/\s+(?=[./\w-]+\.\w+)/);
		labelSpan.textContent = parts[0] || raw;
		row.appendChild(icon);
		row.appendChild(labelSpan);
		if (parts.length > 1) {
			const chip = document.createElement('span');
			chip.className = 'tool-call-file-chip';
			chip.textContent = parts.slice(1).join(' ');
			row.appendChild(chip);
		}
		const check = document.createElement('span');
		check.className = 'tool-call-check';
		check.textContent = '✓';
		row.appendChild(check);
		return row;
	}

	function createDisclosure(label, itemsOrText) {
		const details = document.createElement('details');
		details.className = 'msg-disclosure';
		const summary = document.createElement('summary');
		summary.textContent = label;
		details.appendChild(summary);
		const body = document.createElement('div');
		body.className = 'disclosure-body';
		if (Array.isArray(itemsOrText)) {
			for (const tool of itemsOrText) {
				body.appendChild(createToolCallCard(tool));
			}
		} else {
			body.textContent = itemsOrText || '';
		}
		details.appendChild(body);
		return { details, summary, body };
	}

	function renderMessages() {
		messagesEl.textContent = '';
		const msgs = state.messages || [];
		if (msgs.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'empty-state';

			const head = document.createElement('div');
			head.className = 'empty-head';
			const sigil = document.createElement('div');
			sigil.className = 'empty-sigil';
			sigil.textContent = '✦';
			head.appendChild(sigil);
			const h3 = document.createElement('h3');
			h3.textContent = t('emptyTitle');
			head.appendChild(h3);
			const sub = document.createElement('p');
			sub.textContent = t('emptySubtitle');
			head.appendChild(sub);
			empty.appendChild(head);

			const cards = document.createElement('div');
			cards.className = 'mode-cards';

			const arcana = (window.__tarotArcana && window.__tarotArcana.art) || {};
			const cardDefs = [
				{
					id: 'vibe',
					title: t('modeVibeTitle'),
					desc: t('modeVibeDesc'),
					img: arcana.vibe,
					active: state.mode === 'vibe',
					onClick: () => {
						vscode.postMessage({ type: 'setMode', mode: 'vibe' });
						promptInput.focus();
					},
				},
				{
					id: 'spec',
					title: t('modeSpecTitle'),
					desc: t('modeSpecDesc'),
					img: arcana.spec,
					active: state.mode === 'spec',
					onClick: () => {
						vscode.postMessage({ type: 'setMode', mode: 'spec' });
						promptInput.focus();
					},
				},
				{
					id: 'plan',
					title: t('modePlanTitle'),
					desc: t('modePlanDesc'),
					img: arcana.plan,
					active: state.mode === 'plan',
					onClick: () => {
						vscode.postMessage({ type: 'setMode', mode: 'plan' });
						promptInput.focus();
					},
				},
				{
					id: 'bugfix',
					title: t('modeBugfixTitle'),
					desc: t('modeBugfixDesc'),
					img: arcana.bugfix,
					active: false,
					onClick: () => {
						vscode.postMessage({ type: 'runSlashCommand', slashCommand: '/bugfix' });
					},
				},
			];

			for (const def of cardDefs) {
				const card = document.createElement('button');
				card.type = 'button';
				card.className = `mode-card${def.active ? ' active' : ''}`;
				if (def.img) {
					const thumbWrap = document.createElement('div');
					thumbWrap.className = 'mode-card-art-wrap';
					const img = document.createElement('img');
					img.className = 'mode-card-art';
					img.src = def.img;
					img.alt = def.title;
					thumbWrap.appendChild(img);
					card.appendChild(thumbWrap);
				}
				const textWrap = document.createElement('div');
				textWrap.className = 'mode-card-text';
				const titleEl = document.createElement('div');
				titleEl.className = 'mode-card-title';
				titleEl.textContent = def.title;
				const descEl = document.createElement('div');
				descEl.className = 'mode-card-desc';
				descEl.textContent = def.desc;
				textWrap.appendChild(titleEl);
				textWrap.appendChild(descEl);
				card.appendChild(textWrap);
				card.addEventListener('click', def.onClick);
				cards.appendChild(card);
			}

			empty.appendChild(cards);

			const quickBtn = document.createElement('button');
			quickBtn.type = 'button';
			quickBtn.className = 'quick-spec-bar';
			const qt = document.createElement('span');
			qt.className = 'mode-card-title';
			qt.textContent = `⚡ ${t('modeQuickSpecTitle')}`;
			const qd = document.createElement('span');
			qd.className = 'mode-card-desc';
			qd.textContent = t('modeQuickSpecDesc');
			quickBtn.appendChild(qt);
			quickBtn.appendChild(qd);
			quickBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'runSlashCommand', slashCommand: '/quick-spec' });
			});
			empty.appendChild(quickBtn);

			messagesEl.appendChild(empty);
			return;
		}

		for (const msg of msgs) {
			const wrapper = document.createElement('div');
			wrapper.className = `msg ${msg.role}`;

			if (msg.role === 'assistant') {
				const authorRow = document.createElement('div');
				authorRow.className = 'assistant-header';
				const avatar = document.createElement('span');
				avatar.className = 'assistant-avatar';
				avatar.textContent = '✦';
				const nameEl = document.createElement('span');
				nameEl.className = 'assistant-name';
				nameEl.textContent = 'Tarot';
				authorRow.appendChild(avatar);
				authorRow.appendChild(nameEl);
				wrapper.appendChild(authorRow);

				if (Array.isArray(msg.appliedSteering) && msg.appliedSteering.length > 0) {
					const sLabel = msg.appliedSteering.length === 1
						? t('steeringDoc')
						: t('steeringDocs', msg.appliedSteering.length);
					wrapper.appendChild(createDisclosure(sLabel, msg.appliedSteering).details);
				}
				if (msg.thought) {
					wrapper.appendChild(createDisclosure(t('thoughtComplete'), msg.thought).details);
				}
				if (Array.isArray(msg.tools) && msg.tools.length > 0) {
					const label = msg.tools.length === 1 ? t('toolCall') : t('toolCalls', msg.tools.length);
					wrapper.appendChild(createDisclosure(label, msg.tools).details);
				}
			}

			const body = document.createElement('div');
			body.className = 'msg-body';
			renderFormattedContent(body, msg.content || '');
			wrapper.appendChild(body);

			if (msg.role === 'assistant' && msg.content) {
				const isWorkflowNotification = /^\*\*Workflow\s+"/i.test(msg.content.trim());
				const wfRunMatch = isWorkflowNotification ? msg.content.match(/Run\s+`(run-[a-zA-Z0-9_-]{6,})`/) : null;
				if (wfRunMatch) {
					const wfActions = document.createElement('div');
					wfActions.className = 'wf-chat-card-actions';
					const openBtn = document.createElement('button');
					openBtn.type = 'button';
					openBtn.className = 'wf-chat-open-btn';
					openBtn.textContent = `Open Workflow Run (${wfRunMatch[1]})`;
					openBtn.addEventListener('click', () => {
						vscode.postMessage({ type: 'openWorkflowRun', runId: wfRunMatch[1] });
					});
					wfActions.appendChild(openBtn);
					wrapper.appendChild(wfActions);
				}
				const ceMatch = msg.content.match(/Counter-?example:\s*([^\n]+(?:\n(?!Error:|#|---|\n)[^\n]+)*)/i);
				if (ceMatch) {
					const errMatch = msg.content.match(/Error:\s*([^\n]+)/i);
					const pbtCard = document.createElement('div');
					pbtCard.className = 'pbt-card';

					const pbtHead = document.createElement('div');
					pbtHead.className = 'pbt-card-head';
					const towerSrc = window.__tarotArcana && window.__tarotArcana.icons && window.__tarotArcana.icons.error;
					if (towerSrc) {
						const iconImg = document.createElement('img');
						iconImg.className = 'pbt-card-icon';
						iconImg.src = towerSrc;
						iconImg.alt = '';
						pbtHead.appendChild(iconImg);
					}
					const pbtTitle = document.createElement('span');
					pbtTitle.textContent = t('pbtCounterExampleTitle');
					pbtHead.appendChild(pbtTitle);
					pbtCard.appendChild(pbtHead);

					const cePre = document.createElement('pre');
					cePre.className = 'pbt-counterexample';
					cePre.textContent = ceMatch[1].trim();
					pbtCard.appendChild(cePre);

					if (errMatch) {
						const errEl = document.createElement('div');
						errEl.className = 'pbt-error';
						errEl.textContent = t('errorPrefix', errMatch[1].trim());
						pbtCard.appendChild(errEl);
					}

					const saveBtn = document.createElement('button');
					saveBtn.type = 'button';
					saveBtn.className = 'pbt-save-rule-btn';
					saveBtn.textContent = t('saveRuleToSteering');
					saveBtn.addEventListener('click', () => {
						const ruleSummary = `Avoid PBT regression (${ceMatch[1].trim()}${errMatch ? ` → ${errMatch[1].trim()}` : ''})`;
						vscode.postMessage({ type: 'saveSteeringRule', ruleText: ruleSummary });
						saveBtn.textContent = t('savedToSteering');
						saveBtn.disabled = true;
					});
					pbtCard.appendChild(saveBtn);
					wrapper.appendChild(pbtCard);
				}
			}

			if (msg.role === 'assistant' && msg.taskProgress && msg.taskProgress.total > 0) {
				const card = document.createElement('div');
				card.className = 'task-progress-card';

				const head = document.createElement('div');
				head.className = 'task-progress-head';
				const titleEl = document.createElement('span');
				titleEl.className = 'task-progress-title';
				titleEl.textContent = msg.taskProgress.title || t('updatedTaskList');
				const countEl = document.createElement('span');
				countEl.className = 'task-progress-count';
				countEl.textContent = `${msg.taskProgress.done}/${msg.taskProgress.total}`;
				head.appendChild(titleEl);
				head.appendChild(countEl);
				card.appendChild(head);

				const track = document.createElement('div');
				track.className = 'task-progress-track';
				const fill = document.createElement('div');
				fill.className = 'task-progress-fill';
				const pct = Math.min(100, Math.round((msg.taskProgress.done / msg.taskProgress.total) * 100));
				fill.style.width = `${pct}%`;
				track.appendChild(fill);
				card.appendChild(track);

				const list = document.createElement('div');
				list.className = 'task-progress-list';
				for (const item of msg.taskProgress.items || []) {
					const row = document.createElement('div');
					row.className = `task-progress-item${item.completed ? ' done' : ''}`;
					const icon = document.createElement('span');
					icon.className = 'task-item-icon';
					icon.textContent = item.completed ? '✓' : '○';
					const txt = document.createElement('span');
					txt.textContent = item.label;
					row.appendChild(icon);
					row.appendChild(txt);
					list.appendChild(row);
				}
				card.appendChild(list);
				wrapper.appendChild(card);
			}

			if (msg.role === 'assistant' && msg.approvalGate) {
				const gateEl = document.createElement('div');
				gateEl.className = `spec-gate-card${msg.approvalGate.approved ? ' approved' : ''}`;
				if (msg.approvalGate.approved) {
					const doneText = document.createElement('span');
					doneText.className = 'spec-gate-approved';
					doneText.textContent = t('approved', msg.approvalGate.specSlug);
					gateEl.appendChild(doneText);
				} else {
					const btn = document.createElement('button');
					btn.type = 'button';
					btn.className = 'spec-gate-btn';
					btn.disabled = !!state.isRunning;
					btn.textContent = `✓ ${msg.approvalGate.label}`;
					btn.addEventListener('click', () => {
						vscode.postMessage({ type: 'approveSpecGate', messageId: msg.id });
					});
					gateEl.appendChild(btn);
				}
				wrapper.appendChild(gateEl);
			}

			if (msg.role === 'assistant' && msg.fileWriteGate) {
				const fwGate = msg.fileWriteGate;
				const fwEl = document.createElement('div');
				fwEl.className = `file-write-gate-card${fwGate.resolution ? ' resolved' : ''}`;

				const title = document.createElement('div');
				title.className = 'file-write-gate-title';
				title.textContent = t('fileWriteGateTitle');
				fwEl.appendChild(title);

				const list = document.createElement('ul');
				list.className = 'file-write-gate-list';
				for (const relativePath of fwGate.files || []) {
					const item = document.createElement('li');
					item.textContent = relativePath;
					list.appendChild(item);
				}
				fwEl.appendChild(list);

				if (fwGate.resolution) {
					const doneText = document.createElement('span');
					doneText.className = 'file-write-gate-resolved';
					doneText.textContent = fwGate.resolution === 'kept' ? t('fileWriteGateKept') : t('fileWriteGateReverted');
					fwEl.appendChild(doneText);
				} else {
					const actions = document.createElement('div');
					actions.className = 'file-write-gate-actions';

					const keepBtn = document.createElement('button');
					keepBtn.type = 'button';
					keepBtn.className = 'file-write-gate-btn keep';
					keepBtn.textContent = t('fileWriteGateKeep');
					keepBtn.addEventListener('click', () => {
						vscode.postMessage({ type: 'resolveFileWriteGate', messageId: msg.id, keep: true });
					});
					actions.appendChild(keepBtn);

					const revertBtn = document.createElement('button');
					revertBtn.type = 'button';
					revertBtn.className = 'file-write-gate-btn revert';
					revertBtn.textContent = t('fileWriteGateRevert');
					revertBtn.addEventListener('click', () => {
						vscode.postMessage({ type: 'resolveFileWriteGate', messageId: msg.id, keep: false });
					});
					actions.appendChild(revertBtn);

					fwEl.appendChild(actions);
				}
				wrapper.appendChild(fwEl);
			}

			if (msg.role === 'assistant' && (msg.elapsedMs || msg.checkpointId || msg.totalTokens)) {
				const footer = document.createElement('div');
				footer.className = 'msg-footer';

				const elapsed = document.createElement('span');
				const parts = [];
				if (msg.elapsedMs) {
					parts.push(t('elapsedTime', formatElapsed(msg.elapsedMs)));
				}
				if (typeof msg.totalTokens === 'number' && msg.totalTokens > 0) {
					const fmtTokens = msg.totalTokens >= 1000
						? `${(msg.totalTokens / 1000).toFixed(1)}k ${t('tokensUnit')}`
						: `${msg.totalTokens} ${t('tokensUnit')}`;
					parts.push(fmtTokens);
				}
				elapsed.textContent = parts.join(' · ');
				footer.appendChild(elapsed);

				if (msg.checkpointId) {
					const cpBtn = document.createElement('button');
					cpBtn.type = 'button';
					cpBtn.className = 'checkpoint-btn';
					cpBtn.textContent = t('restoreCheckpoint');
					cpBtn.addEventListener('click', () => {
						vscode.postMessage({ type: 'restoreCheckpoint', checkpointId: msg.checkpointId });
					});
					footer.appendChild(cpBtn);
				}

				if (msg.id) {
					const forkBtn = document.createElement('button');
					forkBtn.type = 'button';
					forkBtn.className = 'checkpoint-btn';
					forkBtn.textContent = t('forkConversation');
					forkBtn.addEventListener('click', () => {
						vscode.postMessage({ type: 'forkSession', messageId: msg.id });
					});
					footer.appendChild(forkBtn);
				}

				wrapper.appendChild(footer);
			}

			messagesEl.appendChild(wrapper);
		}
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function renderReviewBar() {
		const files = state.changedFiles || [];
		if (files.length === 0) {
			reviewBarEl.classList.add('hidden');
			return;
		}
		reviewBarEl.classList.remove('hidden');
		const totalAdded = files.reduce((acc, f) => acc + (f.added || 0), 0);
		const totalRemoved = files.reduce((acc, f) => acc + (f.removed || 0), 0);
		const arrow = reviewExpanded ? '▾' : '▸';
		reviewSummaryText.textContent = `${arrow} ${files.length} ${files.length === 1 ? t('fileChanged') : t('filesChanged')} (+${totalAdded} -${totalRemoved})`;

		reviewFileListEl.classList.toggle('hidden', !reviewExpanded);
		reviewFileListEl.textContent = '';
		if (!reviewExpanded) {
			return;
		}

		for (const file of files) {
			const row = document.createElement('div');
			row.className = 'review-file-row';

			const nameBtn = document.createElement('button');
			nameBtn.type = 'button';
			nameBtn.className = 'review-file-link';
			nameBtn.title = t('openDiff', file.relativePath);

			const badge = document.createElement('span');
			badge.className = `review-status status-${(file.status || 'M').toLowerCase()}`;
			badge.textContent = file.status || 'M';
			nameBtn.appendChild(badge);

			const pathSpan = document.createElement('span');
			pathSpan.className = 'review-file-path';
			pathSpan.textContent = file.relativePath;
			nameBtn.appendChild(pathSpan);

			const stats = document.createElement('span');
			stats.className = 'review-file-stats';
			stats.textContent = `+${file.added || 0} -${file.removed || 0}`;
			nameBtn.appendChild(stats);

			nameBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'openFileDiff', relativePath: file.relativePath, fileStatus: file.status });
			});

			const revertBtn = document.createElement('button');
			revertBtn.type = 'button';
			revertBtn.className = 'review-revert-btn';
			revertBtn.title = t('revertFile', file.relativePath);
			revertBtn.textContent = '↺';
			revertBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'revertFile', relativePath: file.relativePath, fileStatus: file.status });
			});

			row.appendChild(nameBtn);
			row.appendChild(revertBtn);
			reviewFileListEl.appendChild(row);
		}
	}

	function toggleContextMenu(force) {
		setOpenPopover(contextMenuEl, force);
	}

	function toggleSlashMenu(force, filterText) {
		const show = setOpenPopover(slashMenuEl, force);
		if (show) {
			const q = (filterText || '').toLowerCase();
			for (const item of slashMenuEl.querySelectorAll('.slash-menu-item')) {
				const cmd = (item.dataset.cmd || '').toLowerCase();
				item.classList.toggle('hidden', q.length > 0 && !cmd.startsWith(q));
			}
		}
	}

	function renderManualSteeringSlashItems() {
		for (const old of slashMenuEl.querySelectorAll('[data-dynamic="steering"]')) {
			old.remove();
		}
		const commands = Array.isArray(state.manualSteeringCommands) ? state.manualSteeringCommands : [];
		for (const entry of commands) {
			const btn = document.createElement('button');
			btn.className = 'slash-menu-item';
			btn.type = 'button';
			btn.dataset.cmd = entry.command;
			btn.dataset.dynamic = 'steering';

			const tag = document.createElement('span');
			tag.className = 'ctx-tag';
			tag.textContent = entry.command;

			const desc = document.createElement('span');
			desc.className = 'ctx-desc';
			desc.textContent = entry.description || entry.id;

			btn.appendChild(tag);
			btn.appendChild(desc);
			btn.addEventListener('click', () => {
				toggleSlashMenu(false);
				promptInput.value = '';
				autoResizeInput();
				updateSendButtonState();
				vscode.postMessage({ type: 'runSlashCommand', slashCommand: entry.command });
			});
			slashMenuEl.appendChild(btn);
		}
	}

	function sendPrompt() {
		if (state.isRunning) {
			vscode.postMessage({ type: 'cancel' });
			return;
		}
		const text = promptInput.value.trim();
		if (!text) {
			return;
		}
		toggleContextMenu(false);
		toggleSlashMenu(false);

		const knownSlash = ['/spec', '/quick-spec', '/generate-spec', '/bugfix', '/plan', '/steering', '/review', '/workflow-run', '/focus', '/clear'];
		const firstToken = text.split(/\s+/, 1)[0].toLowerCase();
		const manualCommands = Array.isArray(state.manualSteeringCommands)
			? state.manualSteeringCommands.map(c => String(c.command || '').toLowerCase())
			: [];
		if (knownSlash.includes(text.toLowerCase()) || manualCommands.includes(firstToken)) {
			promptInput.value = '';
			autoResizeInput();
			updateSendButtonState();
			vscode.postMessage({ type: 'runSlashCommand', slashCommand: text });
			return;
		}

		promptInput.value = '';
		autoResizeInput();
		updateSendButtonState();
		vscode.postMessage({ type: 'send', prompt: text });
	}

	sendBtn.addEventListener('click', sendPrompt);
	newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
	if (historyBtn) {
		historyBtn.addEventListener('click', () => vscode.postMessage({ type: 'openHistory' }));
	}
	if (contextRingEl) {
		contextRingEl.style.cursor = 'pointer';
		contextRingEl.addEventListener('click', () => vscode.postMessage({ type: 'compactSession' }));
	}
	dockEditorBtn.addEventListener('click', () => vscode.postMessage({ type: 'openInEditorTab' }));
	focusModeBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleFocusMode' }));
	attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'attachActiveFile' }));
	hashBtn.addEventListener('click', () => toggleContextMenu());
	reviewToggleBtn.addEventListener('click', () => {
		reviewExpanded = !reviewExpanded;
		renderReviewBar();
	});
	reviewRefreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refreshChangedFiles' }));

	for (const item of contextMenuEl.querySelectorAll('.context-menu-item')) {
		item.addEventListener('click', () => {
			const kind = item.dataset.kind;
			toggleContextMenu(false);
			if (promptInput.value.endsWith('#')) {
				promptInput.value = promptInput.value.slice(0, -1);
				autoResizeInput();
			}
			vscode.postMessage({ type: 'pickContextProvider', kind });
		});
	}

	for (const item of slashMenuEl.querySelectorAll('.slash-menu-item')) {
		item.addEventListener('click', () => {
			const cmd = item.dataset.cmd;
			toggleSlashMenu(false);
			promptInput.value = '';
			autoResizeInput();
			updateSendButtonState();
			vscode.postMessage({ type: 'runSlashCommand', slashCommand: cmd });
		});
	}

	modelPickerBtn.addEventListener('click', e => {
		e.stopPropagation();
		toggleModelMenu();
	});

	modePickerBtn.addEventListener('click', e => {
		e.stopPropagation();
		toggleModeMenu();
	});

	for (const item of modeMenuEl.querySelectorAll('.mode-menu-item')) {
		item.addEventListener('click', () => {
			const mode = item.dataset.mode;
			toggleModeMenu(false);
			if (mode) {
				vscode.postMessage({ type: 'setMode', mode });
			}
		});
	}

	autonomyPickerBtn.addEventListener('click', e => {
		e.stopPropagation();
		toggleAutonomyMenu();
	});

	for (const item of autonomyMenuEl.querySelectorAll('.mode-menu-item')) {
		item.addEventListener('click', () => {
			const autonomy = item.dataset.autonomy;
			toggleAutonomyMenu(false);
			if (autonomy) {
				vscode.postMessage({ type: 'setAutonomy', autonomy });
			}
		});
	}

	promptInput.addEventListener('input', () => {
		autoResizeInput();
		updateSendButtonState();
		const val = promptInput.value;
		if (val.startsWith('/') && !val.includes(' ')) {
			toggleSlashMenu(true, val);
		} else {
			toggleSlashMenu(false);
		}
		if (val === '#' || val.endsWith(' #') || val === '@' || val.endsWith(' @')) {
			toggleContextMenu(true);
		} else if (!val.includes('#') && !val.includes('@')) {
			toggleContextMenu(false);
		}
	});

	promptInput.addEventListener('keydown', e => {
		if (e.key === 'Escape') {
			toggleContextMenu(false);
			toggleSlashMenu(false);
			toggleModelMenu(false);
			toggleModeMenu(false);
			toggleAutonomyMenu(false);
			return;
		}
		if (e.key === 'Tab' && e.shiftKey) {
			e.preventDefault();
			const order = ['vibe', 'spec', 'plan'];
			const next = order[(order.indexOf(state.mode) + 1) % order.length];
			vscode.postMessage({ type: 'setMode', mode: next });
			return;
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			sendPrompt();
		}
	});

	document.addEventListener('click', e => {
		if (!contextMenuEl.contains(e.target) && e.target !== hashBtn && !hashBtn.contains(e.target)) {
			toggleContextMenu(false);
		}
		if (!slashMenuEl.contains(e.target)) {
			toggleSlashMenu(false);
		}
		if (!modelMenuEl.contains(e.target) && !modelPickerBtn.contains(e.target)) {
			toggleModelMenu(false);
		}
		if (!modeMenuEl.contains(e.target) && !modePickerBtn.contains(e.target)) {
			toggleModeMenu(false);
		}
		if (!autonomyMenuEl.contains(e.target) && !autonomyPickerBtn.contains(e.target)) {
			toggleAutonomyMenu(false);
		}
	});

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') {
			return;
		}

		switch (msg.type) {
			case 'state':
				state = msg;
				focusModeBtn.classList.toggle('active-focus', !!state.isFocusMode);
				renderSessionTabs();
				renderModelAndModePickers();
				renderManualSteeringSlashItems();
				renderContextRing();
				renderAttachments();
				renderReviewBar();
				updateSendButtonState();
				if (!state.isRunning) {
					statusRow.classList.add('hidden');
					statusEl.textContent = '';
				}
				if (!liveBubbleEl) {
					renderMessages();
				}
				break;
			case 'focusInput':
				promptInput.focus();
				break;
			case 'streamStart': {
				liveRawText = '';
				liveToolsCount = 0;
				const wrapper = document.createElement('div');
				wrapper.className = 'msg assistant';

				const disc = createDisclosure(t('zeroToolCalls'), []);
				disc.details.classList.add('hidden');
				liveToolsDetails = disc.details;
				liveToolsSummary = disc.summary;
				liveToolsBody = disc.body;
				wrapper.appendChild(disc.details);

				const body = document.createElement('div');
				body.className = 'msg-body';
				wrapper.appendChild(body);

				liveBubbleEl = wrapper;
				liveBodyEl = body;
				messagesEl.appendChild(wrapper);
				messagesEl.scrollTop = messagesEl.scrollHeight;
				break;
			}
			case 'streamChunk':
				if (liveBodyEl) {
					liveRawText += msg.content || '';
					scheduleLiveRender();
				}
				break;
			case 'streamTool':
				if (liveToolsDetails && liveToolsSummary && liveToolsBody && msg.toolName) {
					liveToolsCount += 1;
					liveToolsDetails.classList.remove('hidden');
					liveToolsSummary.textContent = liveToolsCount === 1 ? t('toolCall') : t('toolCalls', liveToolsCount);
					liveToolsBody.appendChild(createToolCallCard(msg.toolName));
				}
				break;
			case 'streamThought':
				if (msg.content) {
					statusEl.textContent = String(msg.content).trim().slice(0, 140);
					statusRow.classList.remove('hidden');
				}
				break;
			case 'streamStatus':
				if (msg.content) {
					statusEl.textContent = msg.content;
					statusRow.classList.remove('hidden');
				}
				break;
			case 'streamError':
				if (liveBubbleEl) {
					const errEl = document.createElement('div');
					errEl.className = 'msg-error';
					errEl.textContent = msg.content || t('runAgentError');
					liveBubbleEl.appendChild(errEl);
				}
				break;
			case 'streamEnd':
				if (liveRenderRaf) {
					window.cancelAnimationFrame(liveRenderRaf);
					liveRenderRaf = 0;
				}
				liveBubbleEl = null;
				liveBodyEl = null;
				liveToolsDetails = null;
				liveToolsSummary = null;
				liveToolsBody = null;
				liveToolsCount = 0;
				liveRawText = '';
				statusRow.classList.add('hidden');
				statusEl.textContent = '';
				break;
		}
	});

	autoResizeInput();
	updateSendButtonState();
	vscode.postMessage({ type: 'ready' });
})();
