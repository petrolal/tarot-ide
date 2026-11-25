(function () {
	const vscode = acquireVsCodeApi();
	const L = window.__tarotWfL10n || {};

	const titleEl = document.getElementById('wf-title');
	const pillEl = document.getElementById('wf-status-pill');
	const goActiveBtn = document.getElementById('btn-go-active');
	const followChk = document.getElementById('chk-follow');
	const followLbl = document.getElementById('lbl-follow');
	const pauseBtn = document.getElementById('btn-pause');
	const resumeBtn = document.getElementById('btn-resume');
	const addLoopsBtn = document.getElementById('btn-add-loops');
	const stopBtn = document.getElementById('btn-stop');
	const treeEl = document.getElementById('wf-step-tree');
	const stepHeaderEl = document.getElementById('wf-step-header');
	const stepOutputEl = document.getElementById('wf-step-output');
	const msgInput = document.getElementById('wf-msg-input');
	const msgSendBtn = document.getElementById('wf-msg-send');

	goActiveBtn.textContent = L.goToActive || 'Go to active';
	followLbl.textContent = L.follow || 'Follow';
	pauseBtn.textContent = L.pause || 'Pause';
	resumeBtn.textContent = L.resume || 'Resume';
	addLoopsBtn.textContent = L.addLoops || '+ Add loops';
	stopBtn.textContent = L.stop || 'Stop';
	msgInput.placeholder = L.messagePlaceholder || "Message this step's agent...";
	msgSendBtn.textContent = L.send || 'Send';

	let currentRun = null;
	let currentTree = [];
	let selectedStepId = null;

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

	function render() {
		if (!currentRun) {
			return;
		}
		const states = currentRun.stepStates || {};
		const stepNodes = currentTree.filter(n => n.type === 'step');
		const doneCount = stepNodes.filter(n => states[n.id] && states[n.id].status === 'completed').length;

		titleEl.textContent = `${currentRun.recipeName} · ${stepNodes.length} steps`;

		let pillText = currentRun.status;
		if (currentRun.status === 'completed') {
			pillText = '✓ Completed';
		} else if (currentRun.status === 'running') {
			pillText = `Running · step ${Math.min(doneCount + 1, Math.max(1, stepNodes.length))} of ${stepNodes.length}`;
		} else if (currentRun.status === 'paused') {
			pillText = currentRun.pauseReason === 'needs_input'
				? 'Paused · Needs input'
				: currentRun.pauseReason === 'iteration_cap'
					? 'Paused · Iteration cap'
					: 'Paused';
		}
		pillEl.textContent = pillText;
		pillEl.className = `wf-pill status-${currentRun.status}`;

		const isRunning = currentRun.status === 'running';
		const isPaused = currentRun.status === 'paused';
		pauseBtn.classList.toggle('hidden', !isRunning);
		resumeBtn.classList.toggle('hidden', !isPaused);
		addLoopsBtn.classList.toggle('hidden', !(isPaused && currentRun.pauseReason === 'iteration_cap'));
		stopBtn.disabled = !(isRunning || isPaused);

		treeEl.textContent = '';
		for (const item of currentTree) {
			const st = states[item.id];
			const row = document.createElement('button');
			row.type = 'button';
			row.className = `wf-tree-item${item.id === selectedStepId ? ' selected' : ''}`;
			row.style.paddingLeft = `${10 + (item.depth || 0) * 14}px`;

			const statusChar = !st ? '○'
				: st.status === 'completed' ? '✓'
					: st.status === 'failed' ? '✗'
						: st.status === 'paused' ? '⏸'
							: st.status === 'running' ? '●'
								: '○';

			const iconSpan = document.createElement('span');
			iconSpan.className = `wf-step-icon st-${st ? st.status : 'pending'}`;
			iconSpan.textContent = statusChar;
			row.appendChild(iconSpan);

			const nameSpan = document.createElement('span');
			nameSpan.className = 'wf-step-name';
			nameSpan.textContent = item.id;
			row.appendChild(nameSpan);

			if (item.badge) {
				const badge = document.createElement('span');
				badge.className = 'wf-badge';
				badge.textContent = item.badge;
				row.appendChild(badge);
			}
			if (item.agent) {
				const agentSpan = document.createElement('span');
				agentSpan.className = 'wf-agent-tag';
				agentSpan.textContent = item.agent;
				row.appendChild(agentSpan);
			}

			row.title = [
				`${item.id} (${st ? st.status : 'pending'})`,
				item.agent ? `Agent: ${item.agent}` : '',
				item.modelId ? `Model: ${item.modelId}` : '',
				item.effortLevel ? `Effort: ${item.effortLevel}` : '',
			].filter(Boolean).join('\n');

			row.addEventListener('click', () => {
				selectedStepId = item.id;
				render();
			});
			treeEl.appendChild(row);
		}

		const activeState = selectedStepId ? states[selectedStepId] : null;
		const activeItem = currentTree.find(i => i.id === selectedStepId);
		if (activeItem) {
			const metaParts = [activeItem.id];
			if (activeItem.agent) { metaParts.push(activeItem.agent); }
			if (activeState) { metaParts.push(activeState.status); }
			if (activeState && activeState.iterations > 1) { metaParts.push(`pass ${activeState.iterations}`); }
			stepHeaderEl.textContent = metaParts.join(' · ');
			stepOutputEl.textContent = (activeState && activeState.output)
				? activeState.output
				: (L.noOutputYet || 'No output captured for this step yet.');
		} else {
			stepHeaderEl.textContent = '';
			stepOutputEl.textContent = L.selectStepHint || 'Select a step on the left to inspect its transcript.';
		}
	}

	goActiveBtn.addEventListener('click', () => {
		selectedStepId = findActiveStepId(currentRun, currentTree);
		render();
	});
	pauseBtn.addEventListener('click', () => vscode.postMessage({ type: 'pause' }));
	resumeBtn.addEventListener('click', () => vscode.postMessage({ type: 'resume' }));
	addLoopsBtn.addEventListener('click', () => vscode.postMessage({ type: 'addLoops' }));
	stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

	function sendStepMessage() {
		const text = msgInput.value.trim();
		if (!text) {
			return;
		}
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
		if (!msg || msg.type !== 'runState') {
			return;
		}
		currentRun = msg.run;
		currentTree = Array.isArray(msg.tree) ? msg.tree : [];
		if (msg.focusStepId) {
			selectedStepId = msg.focusStepId;
		} else if (!selectedStepId || followChk.checked) {
			selectedStepId = findActiveStepId(currentRun, currentTree);
		}
		render();
	});

	vscode.postMessage({ type: 'ready' });
})();
