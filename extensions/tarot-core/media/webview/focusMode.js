(function () {
	const vscode = acquireVsCodeApi();
	const L10N = window.__tarotFocusL10n || {};

	function t(key, ...args) {
		const tpl = L10N[key] || key;
		return tpl.replace(/\{(\d+)\}/g, (m, idx) => (args[Number(idx)] === undefined ? m : String(args[Number(idx)])));
	}

	const leftPane = document.getElementById('pane-sessions');
	const rightPane = document.getElementById('pane-inspector');
	const collapseLeftBtn = document.getElementById('btn-collapse-left');
	const expandLeftBtn = document.getElementById('btn-expand-left');
	const toggleRightBtn = document.getElementById('btn-toggle-right');
	const exitFocusBtn = document.getElementById('btn-exit-focus');
	const refreshBtn = document.getElementById('btn-refresh');
	const newSessionBtn = document.getElementById('btn-new-session');
	const searchInput = document.getElementById('session-search');
	const filtersEl = document.getElementById('session-filters');
	const sessionListEl = document.getElementById('session-list');
	const activeTitleEl = document.getElementById('active-session-title');
	const transcriptEl = document.getElementById('transcript');
	const promptInput = document.getElementById('focus-prompt');
	const sendBtn = document.getElementById('btn-send');
	const contextBtn = document.getElementById('btn-context');
	const repoSelect = document.getElementById('select-repo');
	const worktreeSelect = document.getElementById('select-worktree');
	const agentSelect = document.getElementById('select-agent');
	const modeSelect = document.getElementById('select-mode');
	const autonomySelect = document.getElementById('select-autonomy');
	const specsListEl = document.getElementById('inspector-specs');
	const filesListEl = document.getElementById('inspector-files');
	const runsListEl = document.getElementById('inspector-runs');

	let state = null;
	let currentFilter = 'all';
	let searchQuery = '';

	function formatTime(iso) {
		if (!iso) { return ''; }
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function matchesFilter(card) {
		if (currentFilter === 'active' && card.status !== 'running') { return false; }
		if (currentFilter === 'needsInput' && card.status !== 'needsInput' && card.status !== 'parked') { return false; }
		if (currentFilter === 'spec' && card.mode !== 'spec') { return false; }
		if (!searchQuery) { return true; }
		const q = searchQuery.toLowerCase();
		return (card.title || '').toLowerCase().includes(q)
			|| (card.summary || '').toLowerCase().includes(q)
			|| (card.repoName || '').toLowerCase().includes(q)
			|| (card.activeAgentId || '').toLowerCase().includes(q);
	}

	function renderSessionCard(card, isActive) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'session-card' + (isActive ? ' active' : '');

		const top = document.createElement('div');
		top.className = 'session-card-top';
		const title = document.createElement('span');
		title.className = 'session-card-title';
		title.textContent = card.title;
		const time = document.createElement('span');
		time.className = 'session-card-time';
		time.textContent = formatTime(card.updatedAt);
		top.appendChild(title);
		top.appendChild(time);
		btn.appendChild(top);

		if (card.summary) {
			const summary = document.createElement('div');
			summary.className = 'session-card-summary';
			summary.textContent = card.summary;
			btn.appendChild(summary);
		}

		const meta = document.createElement('div');
		meta.className = 'session-card-meta';
		const repoBadge = document.createElement('span');
		repoBadge.className = 'meta-badge repo-badge';
		repoBadge.textContent = card.repoName || 'workspace';
		meta.appendChild(repoBadge);

		if (card.worktreeBranch) {
			const wtBadge = document.createElement('span');
			wtBadge.className = 'meta-badge wt-badge';
			wtBadge.textContent = `⎇ ${card.worktreeBranch}`;
			meta.appendChild(wtBadge);
		}

		if (card.status === 'parked') {
			const b = document.createElement('span');
			b.className = 'meta-badge warn-badge';
			b.textContent = t('parkedLabel', card.parkedApprovals || 1);
			meta.appendChild(b);
		} else if (card.status === 'needsInput') {
			const b = document.createElement('span');
			b.className = 'meta-badge warn-badge';
			b.textContent = t('needsInputBadge');
			meta.appendChild(b);
		} else if (card.status === 'running') {
			const b = document.createElement('span');
			b.className = 'meta-badge running-badge';
			b.textContent = t('runningBadge');
			meta.appendChild(b);
		}
		btn.appendChild(meta);

		btn.addEventListener('click', () => {
			vscode.postMessage({ type: 'selectSession', sessionId: card.id });
		});
		return btn;
	}

	function renderSessions() {
		sessionListEl.textContent = '';
		if (!state) { return; }
		const active = (state.sessions || []).filter(matchesFilter);
		const older = (state.olderSessions || []).filter(matchesFilter);

		if (active.length === 0 && older.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'empty-note';
			empty.textContent = t('emptySessions');
			sessionListEl.appendChild(empty);
			return;
		}

		for (const card of active) {
			sessionListEl.appendChild(renderSessionCard(card, card.id === state.activeSessionId));
		}

		if (older.length > 0) {
			const details = document.createElement('details');
			details.className = 'older-sessions-group';
			const summary = document.createElement('summary');
			summary.textContent = `${t('olderSessions')} (${older.length})`;
			details.appendChild(summary);
			for (const card of older) {
				details.appendChild(renderSessionCard(card, false));
			}
			sessionListEl.appendChild(details);
		}
	}

	function renderTranscript() {
		transcriptEl.textContent = '';
		const activeSession = state && state.activeSession;
		if (!activeSession) { return; }
		activeTitleEl.textContent = activeSession.title || 'Tarot Agent';

		const messages = activeSession.messages || [];
		if (messages.length === 0) {
			const emptyWrap = document.createElement('div');
			emptyWrap.className = 'empty-transcript';
			const heading = document.createElement('div');
			heading.className = 'empty-heading';
			heading.textContent = t('emptyTranscript');
			emptyWrap.appendChild(heading);

			const grid = document.createElement('div');
			grid.className = 'mode-picker-grid';
			const starters = [
				{ mode: 'spec', title: 'Spec', desc: 'Structured EARS requirements, design & tasks' },
				{ mode: 'plan', title: 'Plan', desc: 'Read-only investigation & architecture plan' },
				{ mode: 'vibe', title: 'Bug Fix', desc: 'Diagnose root cause, patch & verify tests', promptPrefix: 'Investigue e corrija o bug: ' },
				{ mode: 'spec', title: 'Quick Spec', desc: 'Fast requirements + tasks in a single pass', promptPrefix: 'Crie uma Quick Spec para: ' },
			];
			for (const st of starters) {
				const card = document.createElement('button');
				card.type = 'button';
				card.className = 'mode-card';
				const ct = document.createElement('div');
				ct.className = 'mode-card-title';
				ct.textContent = st.title;
				const cd = document.createElement('div');
				cd.className = 'mode-card-desc';
				cd.textContent = st.desc;
				card.appendChild(ct);
				card.appendChild(cd);
				card.addEventListener('click', () => {
					vscode.postMessage({ type: 'setMode', mode: st.mode });
					if (st.promptPrefix) {
						promptInput.value = st.promptPrefix;
					}
					promptInput.focus();
				});
				grid.appendChild(card);
			}
			emptyWrap.appendChild(grid);
			transcriptEl.appendChild(emptyWrap);
			return;
		}

		for (const msg of messages) {
			const item = document.createElement('article');
			item.className = `msg-item ${msg.role}`;

			if (msg.thought) {
				const d = document.createElement('details');
				d.className = 'disclosure';
				const s = document.createElement('summary');
				s.textContent = t('thoughtLabel');
				const b = document.createElement('pre');
				b.className = 'disclosure-content';
				b.textContent = msg.thought;
				d.appendChild(s);
				d.appendChild(b);
				item.appendChild(d);
			}

			if (Array.isArray(msg.tools) && msg.tools.length > 0) {
				const d = document.createElement('details');
				d.className = 'disclosure';
				const s = document.createElement('summary');
				s.textContent = t('stepsLabel', msg.tools.length);
				const ul = document.createElement('ul');
				ul.className = 'tools-list';
				for (const tool of msg.tools) {
					const li = document.createElement('li');
					li.textContent = tool;
					ul.appendChild(li);
				}
				d.appendChild(s);
				d.appendChild(ul);
				item.appendChild(d);
			}

			const body = document.createElement('div');
			body.className = 'msg-content';
			if (msg.role === 'assistant' && window.TarotSafeMarkdown) {
				window.TarotSafeMarkdown.render(body, msg.content || '');
			} else {
				body.textContent = msg.content || '';
			}
			item.appendChild(body);
			transcriptEl.appendChild(item);
		}
		transcriptEl.scrollTop = transcriptEl.scrollHeight;
	}

	function renderComposerControls() {
		if (!state) { return; }
		const activeSession = state.activeSession || {};

		repoSelect.textContent = '';
		for (const r of state.repos || []) {
			const opt = document.createElement('option');
			opt.value = r.path;
			opt.textContent = r.name;
			opt.selected = r.path === activeSession.repoRoot;
			repoSelect.appendChild(opt);
		}

		worktreeSelect.textContent = '';
		const baseOpt = document.createElement('option');
		baseOpt.value = '';
		baseOpt.textContent = t('currentBranch');
		baseOpt.selected = !activeSession.worktreePath;
		worktreeSelect.appendChild(baseOpt);
		for (const wt of state.worktrees || []) {
			const opt = document.createElement('option');
			opt.value = wt.path;
			opt.dataset.branch = wt.branch;
			opt.textContent = `⎇ ${wt.branch}`;
			opt.selected = wt.path === activeSession.worktreePath;
			worktreeSelect.appendChild(opt);
		}
		const createOpt = document.createElement('option');
		createOpt.value = '__create__';
		createOpt.textContent = t('createWorktree');
		worktreeSelect.appendChild(createOpt);

		agentSelect.textContent = '';
		for (const a of state.agents || []) {
			const opt = document.createElement('option');
			opt.value = a.id;
			opt.disabled = !a.available;
			opt.textContent = a.available ? a.displayName : `${a.displayName} (off)`;
			opt.selected = a.id === state.activeAgentId;
			agentSelect.appendChild(opt);
		}

		modeSelect.value = activeSession.mode || 'vibe';
		autonomySelect.value = activeSession.autonomy || 'acceptFileChanges';
		sendBtn.textContent = state.isRunning ? t('stop') : t('send');
	}

	function renderInspector() {
		if (!state) { return; }

		specsListEl.textContent = '';
		for (const sp of state.specs || []) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'inspector-row';
			btn.textContent = `${sp.slug} · ${sp.done}/${sp.total}`;
			btn.addEventListener('click', () => vscode.postMessage({ type: 'openSpec', dirPath: sp.dirPath }));
			specsListEl.appendChild(btn);
		}

		filesListEl.textContent = '';
		for (const f of state.changedFiles || []) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'inspector-row';
			btn.textContent = `[${f.status}] ${f.relativePath}`;
			btn.addEventListener('click', () => vscode.postMessage({ type: 'openDiff', relativePath: f.relativePath }));
			filesListEl.appendChild(btn);
		}

		runsListEl.textContent = '';
		for (const r of state.workflowRuns || []) {
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'inspector-row';
			btn.textContent = `${r.recipeName} · ${r.status}`;
			btn.addEventListener('click', () => vscode.postMessage({ type: 'openWorkflowRun', runId: r.id }));
			runsListEl.appendChild(btn);
		}
	}

	collapseLeftBtn.addEventListener('click', () => {
		leftPane.classList.add('collapsed');
		expandLeftBtn.classList.remove('hidden');
	});
	expandLeftBtn.addEventListener('click', () => {
		leftPane.classList.remove('collapsed');
		expandLeftBtn.classList.add('hidden');
	});
	toggleRightBtn.addEventListener('click', () => rightPane.classList.toggle('collapsed'));
	exitFocusBtn.addEventListener('click', () => vscode.postMessage({ type: 'exitFocusMode' }));
	refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
	newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
	contextBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickContext' }));

	document.getElementById('btn-shortcut-schedule').addEventListener('click', () => vscode.postMessage({ type: 'openSchedule' }));
	document.getElementById('btn-shortcut-config').addEventListener('click', () => vscode.postMessage({ type: 'openAgentConfig' }));
	document.getElementById('btn-shortcut-settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

	searchInput.addEventListener('input', () => {
		searchQuery = searchInput.value.trim();
		renderSessions();
	});

	for (const pill of filtersEl.querySelectorAll('.filter-pill')) {
		pill.addEventListener('click', () => {
			currentFilter = pill.dataset.filter || 'all';
			for (const p of filtersEl.querySelectorAll('.filter-pill')) {
				p.classList.toggle('active', p === pill);
			}
			renderSessions();
		});
	}

	for (const chip of document.querySelectorAll('.chip-btn')) {
		chip.addEventListener('click', () => {
			const text = chip.dataset.followup || chip.textContent || '';
			if (text) {
				vscode.postMessage({ type: 'send', prompt: text });
			}
		});
	}

	repoSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectRepo', repoRoot: repoSelect.value }));
	worktreeSelect.addEventListener('change', () => {
		const selected = worktreeSelect.options[worktreeSelect.selectedIndex];
		vscode.postMessage({
			type: 'selectWorktree',
			worktreePath: worktreeSelect.value,
			branch: selected ? selected.dataset.branch : undefined,
		});
	});
	agentSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectAgent', agentId: agentSelect.value }));
	modeSelect.addEventListener('change', () => vscode.postMessage({ type: 'setMode', mode: modeSelect.value }));
	autonomySelect.addEventListener('change', () => vscode.postMessage({ type: 'setAutonomy', autonomy: autonomySelect.value }));

	function submit() {
		if (state && state.isRunning) {
			vscode.postMessage({ type: 'cancel' });
			return;
		}
		const text = promptInput.value.trim();
		if (!text) { return; }
		promptInput.value = '';
		vscode.postMessage({ type: 'send', prompt: text });
	}

	sendBtn.addEventListener('click', submit);
	promptInput.addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			submit();
		}
	});

	let liveArticle = null;
	let liveBodyEl = null;
	let liveToolsEl = null;
	let liveBuffer = '';

	function handleLiveStream(payload) {
		if (!payload || typeof payload.type !== 'string') { return; }
		if (payload.type === 'streamStart') {
			liveBuffer = '';
			liveArticle = document.createElement('article');
			liveArticle.className = 'msg-item assistant streaming';
			liveToolsEl = document.createElement('div');
			liveToolsEl.className = 'live-tools-strip';
			liveBodyEl = document.createElement('div');
			liveBodyEl.className = 'msg-content';
			liveBodyEl.textContent = '…';
			liveArticle.appendChild(liveToolsEl);
			liveArticle.appendChild(liveBodyEl);
			transcriptEl.appendChild(liveArticle);
			sendBtn.textContent = t('stop');
			transcriptEl.scrollTop = transcriptEl.scrollHeight;
		} else if (payload.type === 'streamChunk' && liveBodyEl && payload.content) {
			liveBuffer += String(payload.content);
			if (window.TarotSafeMarkdown) {
				window.TarotSafeMarkdown.render(liveBodyEl, liveBuffer);
			} else {
				liveBodyEl.textContent = liveBuffer;
			}
			transcriptEl.scrollTop = transcriptEl.scrollHeight;
		} else if (payload.type === 'streamTool' && liveToolsEl && payload.toolName) {
			const pill = document.createElement('span');
			pill.className = 'meta-badge running-badge';
			pill.textContent = `⚙ ${payload.toolName}`;
			liveToolsEl.appendChild(pill);
			transcriptEl.scrollTop = transcriptEl.scrollHeight;
		} else if (payload.type === 'streamEnd') {
			liveArticle = null;
			liveBodyEl = null;
			liveToolsEl = null;
			liveBuffer = '';
		}
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') { return; }
		if (msg.type === 'state') {
			state = msg;
			liveArticle = null;
			liveBodyEl = null;
			liveToolsEl = null;
			liveBuffer = '';
			renderSessions();
			renderTranscript();
			renderComposerControls();
			renderInspector();
		} else if (msg.type === 'stream') {
			handleLiveStream(msg.payload);
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
