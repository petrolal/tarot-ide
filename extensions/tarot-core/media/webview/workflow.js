(function () {
	const vscode = acquireVsCodeApi();
	const L = window.__tarotWfL10n || {};

	const titleEl = document.getElementById('wf-title');
	const subtitleEl = document.getElementById('wf-subtitle');
	const stepsHeadingEl = document.getElementById('wf-steps-heading');
	const pillEl = document.getElementById('wf-status-pill');
	const goActiveBtn = document.getElementById('btn-go-active');
	const followChk = document.getElementById('chk-follow');
	const followLbl = document.getElementById('lbl-follow');
	const pauseBtn = document.getElementById('btn-pause');
	const resumeBtn = document.getElementById('btn-resume');
	const addLoopsBtn = document.getElementById('btn-add-loops');
	const stopBtn = document.getElementById('btn-stop');
	const treeEl = document.getElementById('wf-step-tree');
	const inspectorEl = document.getElementById('wf-inspector');
	const closeInspectorBtn = document.getElementById('btn-close-inspector');
	const stepHeaderEl = document.getElementById('wf-step-header');
	const stepOutputEl = document.getElementById('wf-step-output');
	const msgInput = document.getElementById('wf-msg-input');
	const msgSendBtn = document.getElementById('wf-msg-send');
	const fabEl = document.getElementById('wf-fab');

	goActiveBtn.textContent = L.goToActive || 'Go to active';
	followLbl.textContent = L.follow || 'Follow';
	pauseBtn.textContent = L.pause || 'Pause';
	resumeBtn.textContent = L.resume || 'Resume';
	addLoopsBtn.textContent = L.addLoops || '+ Add loops';
	stopBtn.textContent = L.stop || 'Stop';
	closeInspectorBtn.textContent = L.closeInspector || 'Close';
	msgInput.placeholder = L.messagePlaceholder || "Message this step's agent...";
	msgSendBtn.textContent = L.send || 'Send';

	let currentRun = null;
	let currentTree = [];
	let selectedStepId = null;
	let inspectorOpen = false;

	function findActiveStepId(run, tree) {
		const states = (run && run.stepStates) || {};
		for (const item of tree) {
			const st = states[item.id];
			if (st && (st.status === 'running' || st.status === 'paused')) {
				return item.id;
			}
		}
		for (let i = tree.length - 1; i >= 0; i--) {
			if (states[tree[i].id]) {
				return tree[i].id;
			}
		}
		return tree[0] ? tree[0].id : null;
	}

	function extractVerdict(output, status) {
		if (status === 'failed') { return { label: 'Failed', tone: 'err' }; }
		if (status === 'paused') { return { label: 'Needs input', tone: 'warn' }; }
		const text = String(output || '');
		if (!text) { return null; }
		if (/\bCHANGES[_\s]+REQUESTED\b/i.test(text)) { return { label: 'Changes requested', tone: 'warn' }; }
		if (/\bAPPROVED\b/i.test(text)) { return { label: 'Approved', tone: 'ok' }; }
		if (/\b(PASSED|GOAL_ACHIEVED)\b/i.test(text)) { return { label: 'Passed', tone: 'ok' }; }
		return null;
	}

	function computeGroupStatus(tree, idx, states) {
		const parentDepth = tree[idx].depth || 0;
		const childStatuses = [];
		for (let j = idx + 1; j < tree.length; j++) {
			if ((tree[j].depth || 0) <= parentDepth) { break; }
			if (tree[j].type === 'step') {
				const st = states[tree[j].id];
				childStatuses.push(st ? st.status : 'pending');
			}
		}
		if (childStatuses.length === 0) { return 'pending'; }
		if (childStatuses.includes('running')) { return 'running'; }
		if (childStatuses.includes('paused')) { return 'paused'; }
		if (childStatuses.includes('failed')) { return 'failed'; }
		if (childStatuses.every(s => s === 'completed')) { return 'completed'; }
		return 'pending';
	}

	function render() {
		if (!currentRun) { return; }
		const states = currentRun.stepStates || {};
		const topLevelNodes = currentTree.filter(n => (n.depth || 0) === 0);
		const stepNodes = currentTree.filter(n => n.type === 'step');
		const doneSteps = stepNodes.filter(n => states[n.id] && states[n.id].status === 'completed').length;
		const loopNodes = currentTree.filter(n => n.type === 'repeat');

		titleEl.textContent = currentRun.recipeName;
		const subParts = [`${topLevelNodes.length} steps`];
		if (loopNodes.length > 0) {
			subParts.push(`${loopNodes[0].id} max ${loopNodes[0].maxIterations || 2}`);
		}
		subtitleEl.textContent = subParts.join(' · ');
		stepsHeadingEl.textContent = `Steps (${topLevelNodes.length})`;

		let pillText = currentRun.status;
		if (currentRun.status === 'completed') {
			pillText = '✓ Completed';
		} else if (currentRun.status === 'running') {
			pillText = `↻ Running · step ${Math.min(doneSteps + 1, Math.max(1, stepNodes.length))} of ${stepNodes.length}`;
		} else if (currentRun.status === 'paused') {
			pillText = currentRun.pauseReason === 'needs_input'
				? '⏸ Paused · Needs input'
				: currentRun.pauseReason === 'iteration_cap'
					? '⏸ Paused · Iteration cap'
					: '⏸ Paused';
		}
		pillEl.textContent = pillText;
		pillEl.className = `wf-pill status-${currentRun.status}`;

		const isRunning = currentRun.status === 'running';
		const isPaused = currentRun.status === 'paused';
		pauseBtn.classList.toggle('hidden', !isRunning);
		resumeBtn.classList.toggle('hidden', !isPaused);
		addLoopsBtn.classList.toggle('hidden', !(isPaused && currentRun.pauseReason === 'iteration_cap'));
		stopBtn.disabled = !(isRunning || isPaused);

		// Floating circular purple FAB (Pause when running, Resume when paused)
		if (isRunning) {
			fabEl.textContent = '⏸';
			fabEl.title = L.pause || 'Pause';
			fabEl.classList.remove('hidden');
		} else if (isPaused) {
			fabEl.textContent = '▶';
			fabEl.title = L.resume || 'Resume';
			fabEl.classList.remove('hidden');
		} else {
			fabEl.classList.add('hidden');
		}

		// Render Kiro-style vertical timeline
		treeEl.textContent = '';
		let topIndex = 0;
		for (let idx = 0; idx < currentTree.length; idx++) {
			const item = currentTree[idx];
			const depth = item.depth || 0;
			const st = states[item.id];
			const effectiveStatus = item.type === 'step'
				? (st ? st.status : 'pending')
				: computeGroupStatus(currentTree, idx, states);

			const row = document.createElement('button');
			row.type = 'button';
			row.className = `wf-row${depth > 0 ? ' nested' : ''}${item.id === selectedStepId && inspectorOpen ? ' selected' : ''}`;
			if (depth > 0) {
				row.style.paddingLeft = `${12 + depth * 26}px`;
				row.style.setProperty('--connector-x', `${23 + (depth - 1) * 26}px`);
			}

			if (depth === 0) {
				topIndex++;
				const circle = document.createElement('span');
				circle.className = `wf-circle st-${effectiveStatus}`;
				circle.textContent = effectiveStatus === 'completed'
					? '✓'
					: effectiveStatus === 'failed'
						? '✗'
						: String(topIndex);
				row.appendChild(circle);
			} else {
				const subIcon = document.createElement('span');
				subIcon.className = `wf-sub-icon st-${effectiveStatus}`;
				subIcon.textContent = effectiveStatus === 'completed'
					? '✓'
					: effectiveStatus === 'failed'
						? '✗'
						: effectiveStatus === 'paused'
							? '⊗'
							: effectiveStatus === 'running'
								? '●'
								: '○';
				row.appendChild(subIcon);
			}

			const nameSpan = document.createElement('span');
			nameSpan.className = 'wf-step-name';
			nameSpan.textContent = item.id;
			row.appendChild(nameSpan);

			if (item.type === 'parallel') {
				const b = document.createElement('span');
				b.className = 'wf-badge parallel';
				b.textContent = 'parallel';
				row.appendChild(b);
			} else if (item.badge) {
				const b = document.createElement('span');
				b.className = 'wf-badge';
				b.textContent = item.badge.replace(/^\[|\]$/g, '');
				row.appendChild(b);
			}

			if (item.type === 'repeat') {
				const iter = (currentRun.repeatProgress && currentRun.repeatProgress[item.id]) || 0;
				if (iter > 0) {
					const passSpan = document.createElement('span');
					passSpan.className = 'wf-pass-label';
					passSpan.textContent = `pass ${iter} of ${item.maxIterations || iter}`;
					row.appendChild(passSpan);
				}
			}

			if (item.agent) {
				const agentSpan = document.createElement('span');
				agentSpan.className = 'wf-agent-tag';
				agentSpan.textContent = item.agent;
				row.appendChild(agentSpan);
			}

			if (item.type === 'step') {
				const verdict = extractVerdict(st && st.output, st && st.status);
				if (verdict) {
					const v = document.createElement('span');
					v.className = `wf-verdict ${verdict.tone}`;
					v.textContent = verdict.label;
					row.appendChild(v);
				}
			}

			row.addEventListener('click', () => {
				selectedStepId = item.id;
				inspectorOpen = true;
				render();
			});
			treeEl.appendChild(row);
		}

		// Inspector Drawer
		inspectorEl.classList.toggle('hidden', !inspectorOpen);
		if (inspectorOpen) {
			const activeState = selectedStepId ? states[selectedStepId] : null;
			const activeItem = currentTree.find(i => i.id === selectedStepId);
			if (activeItem) {
				const metaParts = [activeItem.id];
				if (activeItem.agent) { metaParts.push(activeItem.agent); }
				if (activeState) { metaParts.push(activeState.status); }
				if (activeState && activeState.iterations > 1) { metaParts.push(`pass ${activeState.iterations}`); }
				stepHeaderEl.textContent = metaParts.join(' · ');

				const content = (activeState && activeState.output)
					? activeState.output
					: (L.noOutputYet || 'No output captured for this step yet.');
				if (window.TarotSafeMarkdown) {
					window.TarotSafeMarkdown.render(stepOutputEl, content);
				} else {
					stepOutputEl.textContent = content;
				}
			} else {
				stepHeaderEl.textContent = '';
				stepOutputEl.textContent = L.selectStepHint || '';
			}
		}
	}

	goActiveBtn.addEventListener('click', () => {
		selectedStepId = findActiveStepId(currentRun, currentTree);
		inspectorOpen = true;
		render();
	});
	closeInspectorBtn.addEventListener('click', () => {
		inspectorOpen = false;
		render();
	});
	pauseBtn.addEventListener('click', () => vscode.postMessage({ type: 'pause' }));
	resumeBtn.addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
	addLoopsBtn.addEventListener('click', () => vscode.postMessage({ type: 'addLoops' }));
	stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
	fabEl.addEventListener('click', () => {
		if (!currentRun) { return; }
		if (currentRun.status === 'running') {
			vscode.postMessage({ type: 'pause' });
		} else if (currentRun.status === 'paused') {
			vscode.postMessage({ type: 'resume' });
		}
	});

	function sendStepMessage() {
		const text = msgInput.value.trim();
		if (!text) { return; }
		msgInput.value = '';
		vscode.postMessage({ type: 'messageStep', stepId: selectedStepId, message: text });
	}
	msgSendBtn.addEventListener('click', sendStepMessage);
	msgInput.addEventListener('keydown', e => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendStepMessage();
		}
	});

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg || msg.type !== 'runState') { return; }
		currentRun = msg.run;
		currentTree = msg.tree || [];
		if (msg.focusStepId) {
			selectedStepId = msg.focusStepId;
			inspectorOpen = true;
		} else if (followChk.checked || !selectedStepId) {
			selectedStepId = findActiveStepId(currentRun, currentTree);
			if (currentRun.status === 'paused') {
				inspectorOpen = true;
			}
		}
		render();
	});

	vscode.postMessage({ type: 'ready' });
})();
