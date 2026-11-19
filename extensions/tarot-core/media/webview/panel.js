(function () {
	const vscode = acquireVsCodeApi();

	const messagesEl = document.getElementById('messages');
	const agentSelect = document.getElementById('agent-select');
	const promptInput = document.getElementById('prompt-input');
	const sendBtn = document.getElementById('btn-send');
	const attachBtn = document.getElementById('btn-attach');
	const newSessionBtn = document.getElementById('btn-new-session');
	const refreshAgentsBtn = document.getElementById('btn-refresh-agents');
	const attachmentsEl = document.getElementById('attachments');
	const statusEl = document.getElementById('status-indicator');
	const modeButtons = document.querySelectorAll('.mode-btn');

	let state = {
		agents: [],
		activeAgentId: 'claude',
		mode: 'vibe',
		isRunning: false,
		attachments: [],
		messages: [],
	};

	let liveBubbleEl = null;
	let liveBodyEl = null;
	let liveToolsEl = null;

	function renderAgents() {
		agentSelect.textContent = '';
		for (const agent of state.agents) {
			const opt = document.createElement('option');
			opt.value = agent.id;
			opt.textContent = agent.available
				? `${agent.displayName} (${agent.version || 'ok'})`
				: `${agent.displayName} — não instalado`;
			opt.disabled = !agent.available;
			if (agent.id === state.activeAgentId) {
				opt.selected = true;
			}
			agentSelect.appendChild(opt);
		}
	}

	function renderModes() {
		for (const btn of modeButtons) {
			btn.classList.toggle('active', btn.dataset.mode === state.mode);
		}
	}

	function renderAttachments() {
		attachmentsEl.textContent = '';
		state.attachments.forEach((att, idx) => {
			const chip = document.createElement('span');
			chip.className = 'attachment-chip';

			const label = document.createElement('span');
			label.textContent = att.label;
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

	function createMessageBubble(role, title, text, tools) {
		const wrapper = document.createElement('div');
		wrapper.className = `msg ${role}`;

		const meta = document.createElement('div');
		meta.className = 'msg-meta';
		meta.textContent = title;
		wrapper.appendChild(meta);

		const toolsWrap = document.createElement('div');
		toolsWrap.className = 'msg-tools';
		if (Array.isArray(tools) && tools.length > 0) {
			for (const t of tools) {
				const b = document.createElement('span');
				b.className = 'tool-badge';
				b.textContent = t;
				toolsWrap.appendChild(b);
			}
		}
		wrapper.appendChild(toolsWrap);

		const body = document.createElement('div');
		body.className = 'msg-body';
		body.textContent = text;
		wrapper.appendChild(body);

		return { wrapper, body, toolsWrap };
	}

	function renderMessages() {
		messagesEl.textContent = '';
		if (!state.messages || state.messages.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'empty-state';

			const h3 = document.createElement('h3');
			h3.textContent = '✦ Tarot Agent — BYOA';
			empty.appendChild(h3);

			const p1 = document.createElement('p');
			p1.textContent = 'Orquestre seus agentes locais (claude-code, agy, codex) em Vibe Mode ou Spec Mode.';
			empty.appendChild(p1);

			const p2 = document.createElement('p');
			p2.textContent = 'Regras em .tarot/steering/*.md são injetadas automaticamente.';
			empty.appendChild(p2);

			messagesEl.appendChild(empty);
			return;
		}

		for (const msg of state.messages) {
			const label = msg.role === 'user'
				? `Você · ${msg.mode.toUpperCase()}`
				: `${msg.agentId || 'Agent'} · ${msg.mode.toUpperCase()}`;
			const { wrapper } = createMessageBubble(msg.role, label, msg.content, msg.tools);
			messagesEl.appendChild(wrapper);
		}
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function renderRunButton() {
		if (state.isRunning) {
			sendBtn.textContent = 'Parar';
			sendBtn.classList.add('stop');
		} else {
			sendBtn.textContent = 'Enviar';
			sendBtn.classList.remove('stop');
			statusEl.textContent = '';
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
		promptInput.value = '';
		vscode.postMessage({ type: 'send', prompt: text });
	}

	sendBtn.addEventListener('click', sendPrompt);
	promptInput.addEventListener('keydown', e => {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			sendPrompt();
		}
	});
	attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'attachActiveFile' }));
	newSessionBtn.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
	refreshAgentsBtn.addEventListener('click', () => vscode.postMessage({ type: 'refreshAgents' }));
	agentSelect.addEventListener('change', () => {
		vscode.postMessage({ type: 'selectAgent', agentId: agentSelect.value });
	});
	for (const btn of modeButtons) {
		btn.addEventListener('click', () => {
			vscode.postMessage({ type: 'setMode', mode: btn.dataset.mode });
		});
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') {
			return;
		}

		switch (msg.type) {
			case 'state':
				state = msg;
				renderAgents();
				renderModes();
				renderAttachments();
				renderRunButton();
				if (!liveBubbleEl) {
					renderMessages();
				}
				break;
			case 'streamStart': {
				const { wrapper, body, toolsWrap } = createMessageBubble('assistant', `${msg.agentName || msg.agentId} · ${state.mode.toUpperCase()}`, '', []);
				liveBubbleEl = wrapper;
				liveBodyEl = body;
				liveToolsEl = toolsWrap;
				messagesEl.appendChild(wrapper);
				messagesEl.scrollTop = messagesEl.scrollHeight;
				break;
			}
			case 'streamChunk':
				if (liveBodyEl) {
					liveBodyEl.textContent += msg.content || '';
					messagesEl.scrollTop = messagesEl.scrollHeight;
				}
				break;
			case 'streamTool':
				if (liveToolsEl && msg.toolName) {
					const b = document.createElement('span');
					b.className = 'tool-badge';
					b.textContent = msg.toolName;
					liveToolsEl.appendChild(b);
				}
				break;
			case 'streamStatus':
				statusEl.textContent = msg.content || '';
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
				liveToolsEl = null;
				break;
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
