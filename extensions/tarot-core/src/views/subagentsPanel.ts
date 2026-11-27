/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import {
	runSubagentDag,
	SubagentNode,
	SubagentNodeResult,
	validateSubagentDag,
} from '../agents/subagentManager';
import { TarotCheckpointService } from '../checkpoints/checkpointService';
import { TarotPermissionsService } from '../permissions/permissionsService';
import { reviewFileWritesForTurn } from '../review/fileWriteReviewGate';

const DEFAULT_DAG_NODES: readonly SubagentNode[] = [
	{
		id: 'gather-context',
		kind: 'context-gathering',
		prompt: 'Mapeie a estrutura relevante do repositório e liste os arquivos-chave para a tarefa solicitada.',
	},
	{
		id: 'implement',
		kind: 'general-purpose',
		dependsOn: ['gather-context'],
		prompt: 'Com base no contexto coletado, proponha ou implemente a solução de forma limpa e modular.',
	},
	{
		id: 'validate',
		kind: 'validation',
		dependsOn: ['implement'],
		prompt: 'Revise a entrega quanto a regressões, segurança e cobertura de testes.',
	},
];

/**
 * Interactive Sub-agent DAG Orchestrator WebviewPanel (closes optional visual gap on M3.8b
 * `subagentManager.ts`). Enforces strict CSP with nonce and zero unsafe HTML injection.
 */
export class TarotSubagentsDagPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	private running = false;

	constructor(
		private readonly runtimeManager: AgentRuntimeManager,
		private readonly outputChannel: vscode.OutputChannel,
		private readonly checkpointService: TarotCheckpointService,
		private readonly permissionsService: TarotPermissionsService,
	) { }

	show(): void {
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel(
				'tarot.subagentsDag',
				vscode.l10n.t('Sub-agents DAG Orchestrator'),
				vscode.ViewColumn.Active,
				{ enableScripts: true, retainContextWhenHidden: true },
			);
			this.panel.onDidDispose(() => {
				this.panel = undefined;
			}, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(async msg => {
				if (!msg || typeof msg !== 'object') {
					return;
				}
				const m = msg as { type?: string; task?: string; nodesJson?: string };
				if (m.type === 'validate' && typeof m.nodesJson === 'string') {
					this.postValidation(m.nodesJson);
				} else if (m.type === 'run' && typeof m.nodesJson === 'string') {
					await this.executeDag(m.nodesJson, typeof m.task === 'string' ? m.task : '');
				}
			}, null, this.disposables);
			this.panel.webview.html = this.buildHtml(this.panel.webview);
		} else {
			this.panel.reveal(vscode.ViewColumn.Active);
		}

		void this.panel.webview.postMessage({
			type: 'init',
			defaultNodesJson: JSON.stringify(DEFAULT_DAG_NODES, null, 2),
		});
	}

	private parseNodes(nodesJson: string): { nodes?: SubagentNode[]; error?: string } {
		try {
			const parsed = JSON.parse(nodesJson);
			if (!Array.isArray(parsed) || parsed.length === 0) {
				return { error: 'Provide a non-empty JSON array of SubagentNode definitions.' };
			}
			return { nodes: parsed as SubagentNode[] };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}

	private postValidation(nodesJson: string): void {
		const { nodes, error } = this.parseNodes(nodesJson);
		if (error || !nodes) {
			void this.panel?.webview.postMessage({ type: 'validation', valid: false, errors: [error ?? 'Invalid JSON'], waves: [] });
			return;
		}
		const val = validateSubagentDag(nodes);
		void this.panel?.webview.postMessage({
			type: 'validation',
			valid: val.valid,
			errors: [...val.errors],
			waves: val.waves.map(w => w.map(n => ({ id: n.id, kind: n.kind }))),
		});
	}

	private async executeDag(nodesJson: string, task: string): Promise<void> {
		if (this.running) {
			return;
		}
		if (!vscode.workspace.isTrusted) {
			vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace to run Sub-agent DAGs.'));
			return;
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder first.'));
			return;
		}
		const { nodes, error } = this.parseNodes(nodesJson);
		if (error || !nodes) {
			this.postValidation(nodesJson);
			return;
		}
		const validation = validateSubagentDag(nodes);
		if (!validation.valid) {
			void this.panel?.webview.postMessage({
				type: 'validation',
				valid: false,
				errors: [...validation.errors],
				waves: [],
			});
			return;
		}
		const adapter = this.runtimeManager.getAdapter();
		if (!adapter) {
			vscode.window.showWarningMessage(vscode.l10n.t('No local AI agent CLI available.'));
			return;
		}

		this.running = true;
		void this.panel?.webview.postMessage({
			type: 'running',
			waves: validation.waves.map(w => w.map(n => ({ id: n.id, kind: n.kind }))),
		});

		const cts = new vscode.CancellationTokenSource();
		try {
			const summary = await runSubagentDag(nodes, async (node, depOutputs) => {
				// depOutputs is a Map — Object.entries() on it always returns [] (TD-08), which
				// silently dropped every dependency's output from downstream prompts.
				const depContext = Array.from(depOutputs.entries())
					.map(([k, v]) => `### Dependency (${k})\n${v}`)
					.join('\n\n');
				const prompt = [
					task.trim() ? `Tarefa principal: ${task.trim()}` : '',
					`Sub-agente: ${node.id} (${node.kind})`,
					node.prompt,
					depContext,
				].filter(Boolean).join('\n\n');

				// Headless DAG run — checkpoint before writes so the fs_write policy can be
				// re-checked afterward, same as the chat/Schedule/Crew paths (TD-02).
				const nodeCheckpointSessionId = `subagent-dag-${node.id}-${Date.now()}`;
				const nodeCheckpointId = await this.checkpointService.createCheckpoint(root, nodeCheckpointSessionId);

				let fullText = '';
				let hadError = false;
				await adapter.run(
					{
						prompt,
						mode: node.kind === 'context-gathering' ? 'plan' : 'vibe',
						autonomy: 'acceptFileChanges',
						cwd: root,
						timeoutMs: 300_000,
					},
					ev => {
						if (ev.type === 'text' && ev.content) {
							fullText += ev.content;
						} else if (ev.type === 'error' && ev.content) {
							hadError = true;
							fullText += `\n[Error] ${ev.content}`;
						}
					},
					cts.token,
				);
				if (!hadError && nodeCheckpointId) {
					await reviewFileWritesForTurn(
						{ checkpointService: this.checkpointService, permissionsService: this.permissionsService, outputChannel: this.outputChannel },
						{ cwd: root, sessionId: nodeCheckpointSessionId, checkpointId: nodeCheckpointId, autonomy: 'acceptFileChanges', headless: true },
					);
				}
				this.outputChannel.appendLine(`[Subagent DAG] Node "${node.id}" finished (ok=${!hadError}).`);
				return { ok: !hadError, output: fullText.trim() || '(no output)' };
			});

			void this.panel?.webview.postMessage({
				type: 'results',
				results: summary.results as readonly SubagentNodeResult[],
			});
		} finally {
			cts.dispose();
			this.running = false;
		}
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource} 'nonce-${nonce}'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 22px 26px; max-width: 920px; line-height: 1.5; color-scheme: dark; }
	body.vscode-light { color-scheme: light; }
	h1 { margin: 0 0 6px; font-size: 20px; }
	.desc { color: var(--vscode-descriptionForeground); margin: 0 0 16px; font-size: 12.5px; }
	label { display: block; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 12px 0 6px; }
	input, textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, rgba(255, 255, 255, 0.14)); border-radius: 6px; padding: 8px 10px; font-family: var(--vscode-editor-font-family); font-size: 12px; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
	input:focus, textarea:focus { outline: none; border-color: #8B5CF6; box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.25); }
	textarea { min-height: 180px; resize: vertical; }
	.actions { display: flex; gap: 8px; margin-top: 12px; }
	button { border: none; border-radius: 6px; padding: 7px 14px; cursor: pointer; font-size: 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	.wave-card, .res-card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px 12px; margin-top: 10px; }
	.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-right: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.err { color: #FCA5A5; font-size: 12px; }
	pre { white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: 12px; margin: 6px 0 0; }
</style>
</head>
<body>
<h1>Sub-agents DAG Orchestrator</h1>
<p class="desc">Validate and run parallel dependency waves of local BYOA sub-agents with strict permission inheritance.</p>
<label for="task-input">Task Objective</label>
<input id="task-input" type="text" placeholder="Describe the overall goal passed to all sub-agent waves..." />
<label for="nodes-input">DAG Definition (JSON)</label>
<textarea id="nodes-input"></textarea>
<div class="actions">
	<button id="btn-validate" class="secondary" type="button">Validate Waves</button>
	<button id="btn-run" type="button">Run Sub-agent DAG</button>
</div>
<div id="status-area"></div>
<div id="results-area"></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const taskInput = document.getElementById('task-input');
	const nodesInput = document.getElementById('nodes-input');
	const statusArea = document.getElementById('status-area');
	const resultsArea = document.getElementById('results-area');

	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = String(text);
		return n;
	}

	document.getElementById('btn-validate').addEventListener('click', () => {
		vscode.postMessage({ type: 'validate', nodesJson: nodesInput.value });
	});
	document.getElementById('btn-run').addEventListener('click', () => {
		vscode.postMessage({ type: 'run', task: taskInput.value, nodesJson: nodesInput.value });
	});

	function renderWaves(waves) {
		const frag = document.createDocumentFragment();
		waves.forEach((w, idx) => {
			const card = el('div', 'wave-card');
			card.appendChild(el('div', '', 'Wave ' + (idx + 1)));
			for (const n of w) {
				card.appendChild(el('span', 'pill', n.id + ' (' + n.kind + ')'));
			}
			frag.appendChild(card);
		});
		statusArea.replaceChildren(frag);
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg) return;
		if (msg.type === 'init') {
			nodesInput.value = msg.defaultNodesJson || '[]';
		} else if (msg.type === 'validation') {
			if (!msg.valid) {
				const frag = document.createDocumentFragment();
				for (const e of (msg.errors || [])) frag.appendChild(el('div', 'err', '✗ ' + e));
				statusArea.replaceChildren(frag);
			} else {
				renderWaves(msg.waves || []);
			}
		} else if (msg.type === 'running') {
			renderWaves(msg.waves || []);
			resultsArea.replaceChildren(el('p', 'desc', 'Running sub-agent waves...'));
		} else if (msg.type === 'results') {
			const frag = document.createDocumentFragment();
			for (const r of (msg.results || [])) {
				const card = el('div', 'res-card');
				card.appendChild(el('span', 'pill', r.id + ' · ' + r.status + ' (iter ' + r.iterations + ')'));
				card.appendChild(el('pre', '', r.output || ''));
				frag.appendChild(card);
			}
			resultsArea.replaceChildren(frag);
		}
	});
</script>
</body>
</html>`;
	}

	dispose(): void {
		this.panel?.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
