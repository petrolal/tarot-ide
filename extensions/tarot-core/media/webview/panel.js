(function () {
	const vscode = acquireVsCodeApi();

	const sessionTabsEl = document.getElementById('session-tabs');
	const newSessionBtn = document.getElementById('btn-new-session');
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
	const slashBtn = document.getElementById('btn-slash');
	const attachBtn = document.getElementById('btn-attach');
	const contextRingEl = document.getElementById('context-ring');
	const contextRingArc = document.getElementById('context-ring-arc');
	const agentSelect = document.getElementById('agent-select');
	const modeSelect = document.getElementById('mode-select');
	const autopilotCheckbox = document.getElementById('autopilot-checkbox');
	const promptInput = document.getElementById('prompt-input');
	const sendBtn = document.getElementById('btn-send');
	const iconSend = document.getElementById('icon-send');
	const iconStop = document.getElementById('icon-stop');
	const attachmentsEl = document.getElementById('attachments');
	const statusRow = document.getElementById('status-row');
	const statusEl = document.getElementById('status-indicator');

	const RING_CIRCUMFERENCE = 34.56;

	let state = {
		agents: [],
		activeAgentId: 'claude',
		mode: 'vibe',
		autonomy: 'autopilot',
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
			sendBtn.title = 'Parar execução';
			iconSend.classList.add('hidden');
			iconStop.classList.remove('hidden');
			return;
		}
		sendBtn.classList.remove('stop');
		sendBtn.title = 'Enviar (Enter)';
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
				close.title = 'Fechar aba';
				close.addEventListener('click', e => {
					e.stopPropagation();
					vscode.postMessage({ type: 'closeSession', sessionId: s.id });
				});
				tab.appendChild(close);
			}

			sessionTabsEl.appendChild(tab);
		}
	}

	function renderAgents() {
		agentSelect.textContent = '';
		for (const agent of state.agents || []) {
			const opt = document.createElement('option');
			opt.value = agent.id;
			opt.textContent = agent.available ? agent.id : `${agent.id} (off)`;
			opt.disabled = !agent.available;
			if (agent.id === state.activeAgentId) {
				opt.selected = true;
			}
			agentSelect.appendChild(opt);
		}
	}

	function renderContextRing() {
		const pct = Math.max(0, Math.min(100, state.contextPercent || 0));
		const offset = RING_CIRCUMFERENCE * (1 - pct / 100);
		contextRingArc.setAttribute('stroke-dashoffset', offset.toFixed(2));
		contextRingEl.title = `Uso estimado de contexto: ${pct}%`;
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
		const inlineRegex = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
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
			} else {
				const strong = document.createElement('strong');
				strong.textContent = token.slice(2, -2);
				parent.appendChild(strong);
			}
			last = inlineRegex.lastIndex;
		}
		if (last < text.length) {
			parent.appendChild(document.createTextNode(text.slice(last)));
		}
	}

	function renderFormattedContent(container, rawText) {
		container.textContent = '';
		const fenceRegex = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
		let lastIndex = 0;
		let match;

		while ((match = fenceRegex.exec(rawText)) !== null) {
			if (match.index > lastIndex) {
				const span = document.createElement('span');
				appendInlineSegments(span, rawText.slice(lastIndex, match.index));
				container.appendChild(span);
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
			copyBtn.textContent = 'Copiar';
			copyBtn.addEventListener('click', () => {
				if (navigator.clipboard) {
					navigator.clipboard.writeText(codeText).then(() => {
						copyBtn.textContent = 'Copiado!';
						setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 1200);
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
			const tail = document.createElement('span');
			appendInlineSegments(tail, rawText.slice(lastIndex));
			container.appendChild(tail);
		}
	}

	function createDisclosure(summaryText, itemsOrText) {
		const details = document.createElement('details');
		details.className = 'msg-disclosure';

		const summary = document.createElement('summary');
		summary.textContent = summaryText;
		details.appendChild(summary);

		const body = document.createElement('div');
		body.className = 'disclosure-body';
		if (Array.isArray(itemsOrText)) {
			for (const tool of itemsOrText) {
				const row = document.createElement('div');
				row.className = 'tool-list-item';
				row.textContent = `• ${tool}`;
				body.appendChild(row);
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
			h3.textContent = 'Tarot Agent — BYOA';
			head.appendChild(h3);
			const sub = document.createElement('p');
			sub.textContent = 'Escolha o fluxo ou digite # para anexar contexto.';
			head.appendChild(sub);
			empty.appendChild(head);

			const cards = document.createElement('div');
			cards.className = 'mode-cards';

			const vibeCard = document.createElement('button');
			vibeCard.type = 'button';
			vibeCard.className = `mode-card${state.mode === 'vibe' ? ' active' : ''}`;
			const vt = document.createElement('div');
			vt.className = 'mode-card-title';
			vt.textContent = 'Vibe';
			const vd = document.createElement('div');
			vd.className = 'mode-card-desc';
			vd.textContent = 'Chat rápido para explorar, editar e depurar código.';
			vibeCard.appendChild(vt);
			vibeCard.appendChild(vd);
			vibeCard.addEventListener('click', () => {
				vscode.postMessage({ type: 'setMode', mode: 'vibe' });
				promptInput.focus();
			});

			const specCard = document.createElement('button');
			specCard.type = 'button';
			specCard.className = `mode-card${state.mode === 'spec' ? ' active' : ''}`;
			const st = document.createElement('div');
			st.className = 'mode-card-title';
			st.textContent = 'Spec';
			const sd = document.createElement('div');
			sd.className = 'mode-card-desc';
			sd.textContent = 'Planeje requirements (EARS), design e tasks antes de codar.';
			specCard.appendChild(st);
			specCard.appendChild(sd);
			specCard.addEventListener('click', () => {
				vscode.postMessage({ type: 'setMode', mode: 'spec' });
				promptInput.focus();
			});

			cards.appendChild(vibeCard);
			cards.appendChild(specCard);
			empty.appendChild(cards);

			messagesEl.appendChild(empty);
			return;
		}

		for (const msg of msgs) {
			const wrapper = document.createElement('div');
			wrapper.className = `msg ${msg.role}`;

			if (msg.role === 'assistant') {
				if (Array.isArray(msg.appliedSteering) && msg.appliedSteering.length > 0) {
					const sLabel = msg.appliedSteering.length === 1
						? '1 steering doc'
						: `${msg.appliedSteering.length} steering docs`;
					wrapper.appendChild(createDisclosure(sLabel, msg.appliedSteering).details);
				}
				if (msg.thought) {
					wrapper.appendChild(createDisclosure('Thought complete', msg.thought).details);
				}
				if (Array.isArray(msg.tools) && msg.tools.length > 0) {
					const label = msg.tools.length === 1 ? '1 tool call' : `${msg.tools.length} tool calls`;
					wrapper.appendChild(createDisclosure(label, msg.tools).details);
				}
			}

			const body = document.createElement('div');
			body.className = 'msg-body';
			renderFormattedContent(body, msg.content || '');
			wrapper.appendChild(body);

			if (msg.role === 'assistant' && msg.taskProgress && msg.taskProgress.total > 0) {
				const card = document.createElement('div');
				card.className = 'task-progress-card';

				const head = document.createElement('div');
				head.className = 'task-progress-head';
				const titleEl = document.createElement('span');
				titleEl.className = 'task-progress-title';
				titleEl.textContent = msg.taskProgress.title || 'Updated task list';
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
					doneText.textContent = `✓ Approved · ${msg.approvalGate.specSlug}`;
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

			if (msg.role === 'assistant' && (msg.elapsedMs || msg.checkpointId)) {
				const footer = document.createElement('div');
				footer.className = 'msg-footer';

				const elapsed = document.createElement('span');
				elapsed.textContent = msg.elapsedMs ? `Elapsed time: ${formatElapsed(msg.elapsedMs)}` : '';
				footer.appendChild(elapsed);

				if (msg.checkpointId) {
					const cpBtn = document.createElement('button');
					cpBtn.type = 'button';
					cpBtn.className = 'checkpoint-btn';
					cpBtn.textContent = '↺ Restore Checkpoint';
					cpBtn.addEventListener('click', () => {
						vscode.postMessage({ type: 'restoreCheckpoint', checkpointId: msg.checkpointId });
					});
					footer.appendChild(cpBtn);
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
		reviewSummaryText.textContent = `${arrow} ${files.length} ${files.length === 1 ? 'file changed' : 'files changed'} (+${totalAdded} -${totalRemoved})`;

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
			nameBtn.title = `Abrir diff: ${file.relativePath}`;

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
			revertBtn.title = `Reverter ${file.relativePath}`;
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
		const show = typeof force === 'boolean' ? force : contextMenuEl.classList.contains('hidden');
		contextMenuEl.classList.toggle('hidden', !show);
		if (show) {
			slashMenuEl.classList.add('hidden');
		}
	}

	function toggleSlashMenu(force, filterText) {
		const show = typeof force === 'boolean' ? force : slashMenuEl.classList.contains('hidden');
		slashMenuEl.classList.toggle('hidden', !show);
		if (show) {
			contextMenuEl.classList.add('hidden');
			const q = (filterText || '').toLowerCase();
			for (const item of slashMenuEl.querySelectorAll('.slash-menu-item')) {
				const cmd = (item.dataset.cmd || '').toLowerCase();
				item.classList.toggle('hidden', q.length > 0 && !cmd.startsWith(q));
			}
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

		const knownSlash = ['/spec', '/bugfix', '/plan', '/steering', '/review', '/focus', '/clear'];
		if (knownSlash.includes(text.toLowerCase())) {
			promptInput.value = '';
			autoResizeInput();
			updateSendButtonState();
			vscode.postMessage({ type: 'runSlashCommand', slashCommand: text.toLowerCase() });
			return;
		}

		promptInput.value = '';
		autoResizeInput();
		updateSendButtonState();
		vscode.postMessage({ type: 'send', prompt: text });
	}

	sendBtn.addEventListener('click', sendPrompt);
	newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
	dockEditorBtn.addEventListener('click', () => vscode.postMessage({ type: 'openInEditorTab' }));
	focusModeBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleFocusMode' }));
	attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'attachActiveFile' }));
	hashBtn.addEventListener('click', () => toggleContextMenu());
	slashBtn.addEventListener('click', () => toggleSlashMenu());
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

	agentSelect.addEventListener('change', () => {
		vscode.postMessage({ type: 'selectAgent', agentId: agentSelect.value });
	});

	modeSelect.addEventListener('change', () => {
		vscode.postMessage({ type: 'setMode', mode: modeSelect.value });
	});

	autopilotCheckbox.addEventListener('change', () => {
		vscode.postMessage({
			type: 'setAutonomy',
			autonomy: autopilotCheckbox.checked ? 'autopilot' : 'supervised',
		});
	});

	promptInput.addEventListener('input', () => {
		autoResizeInput();
		updateSendButtonState();
		const val = promptInput.value;
		if (val.startsWith('/') && !val.includes(' ')) {
			toggleSlashMenu(true, val);
		} else {
			toggleSlashMenu(false);
		}
		if (val === '#' || val.endsWith(' #')) {
			toggleContextMenu(true);
		} else if (!val.includes('#')) {
			toggleContextMenu(false);
		}
	});

	promptInput.addEventListener('keydown', e => {
		if (e.key === 'Escape') {
			toggleContextMenu(false);
			toggleSlashMenu(false);
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
		if (!contextMenuEl.contains(e.target) && e.target !== hashBtn) {
			toggleContextMenu(false);
		}
		if (!slashMenuEl.contains(e.target) && e.target !== slashBtn) {
			toggleSlashMenu(false);
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
				modeSelect.value = state.mode || 'vibe';
				autopilotCheckbox.checked = state.autonomy !== 'supervised';
				focusModeBtn.classList.toggle('active-focus', !!state.isFocusMode);
				renderSessionTabs();
				renderAgents();
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

				const disc = createDisclosure('0 tool calls', []);
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
					renderFormattedContent(liveBodyEl, liveRawText);
					messagesEl.scrollTop = messagesEl.scrollHeight;
				}
				break;
			case 'streamTool':
				if (liveToolsDetails && liveToolsSummary && liveToolsBody && msg.toolName) {
					liveToolsCount += 1;
					liveToolsDetails.classList.remove('hidden');
					liveToolsSummary.textContent = liveToolsCount === 1 ? '1 tool call' : `${liveToolsCount} tool calls`;
					const row = document.createElement('div');
					row.className = 'tool-list-item';
					row.textContent = `• ${msg.toolName}`;
					liveToolsBody.appendChild(row);
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
					errEl.textContent = msg.content || 'Erro ao executar agente.';
					liveBubbleEl.appendChild(errEl);
				}
				break;
			case 'streamEnd':
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
