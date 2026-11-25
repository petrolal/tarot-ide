/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { TarotWorkflowRunStore } from '../workflows/runStore';
import { WorkflowNode, WorkflowRecipe, WorkflowRunState } from '../workflows/workflowTypes';

export interface WorkflowRunControlCallbacks {
	readonly onPause: (runId: string) => void;
	readonly onResume: (runId: string, answerText?: string, targetStepId?: string) => Promise<void>;
	readonly onStop: (runId: string) => void;
	readonly onAddLoops: (runId: string, extraIterations: number) => Promise<void>;
}

export interface FlattenedWorkflowTreeItem {
	readonly id: string;
	readonly type: WorkflowNode['type'];
	readonly depth: number;
	readonly agent?: string;
	readonly badge?: string;
	readonly modelId?: string;
	readonly effortLevel?: string;
}

/** Flattens a recipe's AST into an indented tree list with `[loop ×N]` / `[parallel]` badges. */
export function flattenRecipeTree(nodes: readonly WorkflowNode[], depth = 0): FlattenedWorkflowTreeItem[] {
	const items: FlattenedWorkflowTreeItem[] = [];
	for (const node of nodes) {
		if (node.type === 'step') {
			items.push({
				id: node.id,
				type: 'step',
				depth,
				agent: node.agent,
				modelId: node.modelId,
				effortLevel: node.effortLevel,
			});
		} else if (node.type === 'sequence') {
			items.push({ id: node.id, type: 'sequence', depth });
			items.push(...flattenRecipeTree(node.steps, depth + 1));
		} else if (node.type === 'repeat') {
			items.push({ id: node.id, type: 'repeat', depth, badge: `[loop ×${node.maxIterations}]` });
			items.push(...flattenRecipeTree(node.steps, depth + 1));
		} else if (node.type === 'parallel') {
			items.push({ id: node.id, type: 'parallel', depth, badge: '[parallel]' });
			items.push(...flattenRecipeTree(node.branches, depth + 1));
		} else if (node.type === 'watch') {
			items.push({ id: node.id, type: 'watch', depth, badge: `[watch:${node.handler}]` });
		}
	}
	return items;
}

/**
 * Manages `"Workflow: <name>"` WebviewPanel editor tabs (MIGRATION_PLAN.md M3.9b):
 * docked step tree + step transcript + Go to active / Follow / Pause / Resume / Stop / Add loops
 * + "Message this step's agent" two-way steering. Strict CSP with nonce and safe DOM construction.
 */
export class TarotWorkflowRunEditorManager implements vscode.Disposable {
	private readonly panels = new Map<string, vscode.WebviewPanel>();
	private readonly recipesByRunId = new Map<string, WorkflowRecipe>();

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly runStore: TarotWorkflowRunStore,
		private readonly controls: WorkflowRunControlCallbacks,
	) { }

	async openRun(workspaceRoot: string, runId: string, recipe?: WorkflowRecipe, focusStepId?: string): Promise<void> {
		if (recipe) {
			this.recipesByRunId.set(runId, recipe);
		}
		const run = await this.runStore.loadRun(workspaceRoot, runId);
		if (!run) {
			vscode.window.showWarningMessage(vscode.l10n.t('Workflow run "{0}" not found.', runId));
			return;
		}

		const existing = this.panels.get(runId);
		if (existing) {
			existing.reveal(vscode.ViewColumn.Active);
			this.postRunState(existing, run, focusStepId);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'tarot.workflowRunEditor',
			vscode.l10n.t('Workflow: {0}', run.recipeName),
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(this.extensionUri, 'media'),
					vscode.Uri.joinPath(this.extensionUri, 'icons'),
				],
			},
		);
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
		panel.webview.html = this.buildHtml(panel.webview, run.recipeName);
		this.panels.set(runId, panel);

		panel.webview.onDidReceiveMessage(async (msg: { type?: string; stepId?: string; message?: string }) => {
			if (!msg || typeof msg !== 'object') {
				return;
			}
			switch (msg.type) {
				case 'ready': {
					const latest = await this.runStore.loadRun(workspaceRoot, runId);
					if (latest) {
						this.postRunState(panel, latest, focusStepId);
					}
					break;
				}
				case 'pause':
					this.controls.onPause(runId);
					break;
				case 'resume':
					await this.controls.onResume(runId);
					break;
				case 'stop':
					this.controls.onStop(runId);
					break;
				case 'addLoops':
					await this.controls.onAddLoops(runId, 2);
					break;
				case 'messageStep':
					if (typeof msg.message === 'string' && msg.message.trim()) {
						await this.controls.onResume(runId, msg.message.trim(), msg.stepId);
					}
					break;
			}
		});

		panel.onDidDispose(() => {
			this.panels.delete(runId);
		});

		this.postRunState(panel, run, focusStepId);
	}

	updateOpenRun(run: WorkflowRunState, recipe?: WorkflowRecipe): void {
		if (recipe) {
			this.recipesByRunId.set(run.id, recipe);
		}
		const panel = this.panels.get(run.id);
		if (panel) {
			this.postRunState(panel, run);
		}
	}

	private postRunState(panel: vscode.WebviewPanel, run: WorkflowRunState, focusStepId?: string): void {
		const recipe = this.recipesByRunId.get(run.id);
		const tree = recipe
			? flattenRecipeTree(recipe.steps)
			: Object.values(run.stepStates).map(s => ({
				id: s.id,
				type: 'step' as const,
				depth: 0,
				agent: s.agent,
			}));
		void panel.webview.postMessage({
			type: 'runState',
			run,
			tree,
			focusStepId,
		});
	}

	private buildHtml(webview: vscode.Webview, recipeName: string): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'workflow.css'));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'workflow.js'));
		const l10nPayload = JSON.stringify({
			goToActive: vscode.l10n.t('Go to active'),
			follow: vscode.l10n.t('Follow'),
			pause: vscode.l10n.t('Pause'),
			resume: vscode.l10n.t('Resume'),
			stop: vscode.l10n.t('Stop'),
			addLoops: vscode.l10n.t('+ Add loops'),
			messagePlaceholder: vscode.l10n.t("Message this step's agent (answers a paused step or steers the next turn)..."),
			send: vscode.l10n.t('Send'),
			noOutputYet: vscode.l10n.t('No output captured for this step yet.'),
			selectStepHint: vscode.l10n.t('Select a step on the left to inspect its transcript.'),
		}).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${cssUri}" />
	<title>Workflow: ${recipeName.replace(/</g, '&lt;')}</title>
</head>
<body>
	<div class="wf-shell">
		<header class="wf-header">
			<div class="wf-header-left">
				<span id="wf-title" class="wf-title"></span>
				<span id="wf-status-pill" class="wf-pill"></span>
			</div>
			<div class="wf-controls">
				<button id="btn-go-active" class="wf-btn" type="button"></button>
				<label class="wf-follow-toggle"><input id="chk-follow" type="checkbox" checked /><span id="lbl-follow"></span></label>
				<button id="btn-pause" class="wf-btn" type="button"></button>
				<button id="btn-resume" class="wf-btn primary hidden" type="button"></button>
				<button id="btn-add-loops" class="wf-btn accent hidden" type="button"></button>
				<button id="btn-stop" class="wf-btn danger" type="button"></button>
			</div>
		</header>
		<div class="wf-body">
			<aside id="wf-step-tree" class="wf-tree" role="tree"></aside>
			<section class="wf-transcript-pane">
				<div id="wf-step-header" class="wf-step-header"></div>
				<pre id="wf-step-output" class="wf-step-output"></pre>
				<div class="wf-composer">
					<input id="wf-msg-input" class="wf-msg-input" type="text" />
					<button id="wf-msg-send" class="wf-btn primary" type="button"></button>
				</div>
			</section>
		</div>
	</div>
	<script nonce="${nonce}">window.__tarotWfL10n = ${l10nPayload};</script>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}

	dispose(): void {
		for (const panel of this.panels.values()) {
			panel.dispose();
		}
		this.panels.clear();
	}
}
