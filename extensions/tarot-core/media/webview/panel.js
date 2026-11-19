(function () {
	const vscode = acquireVsCodeApi();

	const messagesEl = document.getElementById('messages');
	const agentSelect = document.getElementById('agent-select');
	const promptInput = document.getElementById('prompt-input');
	const sendBtn = document.getElementById('btn-send');
	const iconSend = document.getElementById('icon-send');
	const iconStop = document.getElementById('icon-stop');
	const attachBtn = document.getElementById('btn-attach');
	const newSessionBtn = document.getElementById('btn-new-session');
	const refreshAgentsBtn = document.getElementById('btn-refresh-agents');
	const attachmentsEl = document.getElementById('attachments');
	const statusRow = document.getElementById('status-row');
	const statusEl = document.getElementById('status-indicator');
	const modeButtons = document.querySelectorAll('.mode-pill');

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
	let liveRawText = '';

	function autoResizeInput() {
		promptInput.style.height = 'auto';
		const next = Math.min(promptInput.scrollHeight, 180);
		promptInput.style.height = `${Math.max(next, 36)}px`;
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

	function renderAgents() {
		agentSelect.textContent = '';
		for (const agent of state.agents) {
			const opt = document.createElement('option');
			opt.value = agent.id;
			opt.textContent = agent.available
				? `✦ ${agent.displayName}`
				: `${agent.displayName} (indisponível)`;
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

	/**
	 * Safely renders plain text and fenced code blocks without innerHTML.
	 */
	function renderFormattedContent(container, rawText) {
		container.textContent = '';
		const fenceRegex = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
		let lastIndex = 0;
		let match;

		while ((match = fenceRegex.exec(rawText)) !== null) {
			if (match.index > lastIndex) {
				const textPart = document.createElement('span');
				textPart.textContent = rawText.slice(lastIndex, match.index);
				container.appendChild(textPart);
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
			tail.textContent = rawText.slice(lastIndex);
			container.appendChild(tail);
		}
	}

	function createMessageBubble(role, title, mode, text, tools) {
		const wrapper = document.createElement('div');
		wrapper.className = `msg ${role}`;

		const meta = document.createElement('div');
		meta.className = 'msg-meta';
		const titleSpan = document.createElement('span');
		titleSpan.textContent = title;
		meta.appendChild(titleSpan);

		if (mode) {
			const modeTag = document.createElement('span');
			modeTag.className = 'msg-mode-tag';
			modeTag.textContent = mode;
			meta.appendChild(modeTag);
		}
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
		renderFormattedContent(body, text || '');
		wrapper.appendChild(body);

		return { wrapper, body, toolsWrap };
	}

	function renderMessages() {
		messagesEl.textContent = '';
		if (!state.messages || state.messages.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'empty-state';

			const sigil = document.createElement('div');
			sigil.className = 'empty-sigil';
			sigil.textContent = '✦';
			empty.appendChild(sigil);

			const h3 = document.createElement('h3');
			h3.textContent = 'Tarot Agent';
			empty.appendChild(h3);

			const p1 = document.createElement('p');
			p1.textContent = 'Use Vibe para mudanças rápidas ou Spec para planejar requirements, design e tasks.';
			empty.appendChild(p1);

			const p2 = document.createElement('p');
			p2.textContent = 'Regras em .tarot/steering/*.md são injetadas automaticamente.';
			empty.appendChild(p2);

			messagesEl.appendChild(empty);
			return;
		}

		for (const msg of state.messages) {
			const label = msg.role === 'user' ? 'Você' : (msg.agentId || 'Agent');
			const { wrapper } = createMessageBubble(msg.role, label, msg.mode, msg.content, msg.tools);
			messagesEl.appendChild(wrapper);
		}
		messagesEl.scrollTop = messagesEl.scrollHeight;
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
		autoResizeInput();
		updateSendButtonState();
		vscode.postMessage({ type: 'send', prompt: text });
	}

	sendBtn.addEventListener('click', sendPrompt);
	promptInput.addEventListener('input', () => {
		autoResizeInput();
		updateSendButtonState();
	});
	promptInput.addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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
				updateSendButtonState();
				if (!state.isRunning) {
					statusRow.classList.add('hidden');
					statusEl.textContent = '';
				}
				if (!liveBubbleEl) {
					renderMessages();
				}
				break;
			case 'streamStart': {
				liveRawText = '';
				const { wrapper, body, toolsWrap } = createMessageBubble('assistant', msg.agentName || msg.agentId, state.mode, '', []);
				liveBubbleEl = wrapper;
				liveBodyEl = body;
				liveToolsEl = toolsWrap;
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
				if (liveToolsEl && msg.toolName) {
					const b = document.createElement('span');
					b.className = 'tool-badge';
					b.textContent = msg.toolName;
					liveToolsEl.appendChild(b);
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
				liveToolsEl = null;
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
