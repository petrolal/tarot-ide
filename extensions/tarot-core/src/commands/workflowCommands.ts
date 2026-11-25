/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { TarotCheckpointService } from '../checkpoints/checkpointService';
import { TarotPermissionsService } from '../permissions/permissionsService';
import { parseYamlLite } from '../permissions/yamlLite';
import { TarotAgentPanelProvider } from '../views/agentPanelView';
import { TarotWorkflowRunEditorManager } from '../views/workflowRunEditor';
import { WorkflowRunsTreeProvider } from '../views/workflowRunsView';
import { TarotRecipeLoader } from '../workflows/recipeLoader';
import { validateWorkflow } from '../workflows/recipeValidator';
import { TarotWorkflowRunStore } from '../workflows/runStore';
import { runWatchPoll } from '../workflows/watchHandlers';
import { composeWorkflowStepPrompt, extractArtifactsFromOutput } from '../workflows/workflowAgentProfiles';
import { TarotWorkflowEngine } from '../workflows/workflowEngine';
import { LoadedRecipe, WorkflowNode, WorkflowRecipe, WorkflowRunState } from '../workflows/workflowTypes';

export interface WorkflowCommandsDeps {
	readonly extensionUri: vscode.Uri;
	readonly runtimeManager: AgentRuntimeManager;
	readonly checkpointService: TarotCheckpointService;
	readonly permissionsService: TarotPermissionsService;
	readonly recipeLoader: TarotRecipeLoader;
	readonly workflowRunStore: TarotWorkflowRunStore;
	readonly workflowEngine: TarotWorkflowEngine;
	readonly workflowRunsProvider: WorkflowRunsTreeProvider;
	readonly getAgentPanelProvider: () => TarotAgentPanelProvider;
	readonly ensureWorkspaceFolder: () => Promise<string | undefined>;
	readonly outputChannel: vscode.OutputChannel;
}

function bumpRepeatLimits(nodes: readonly WorkflowNode[], extra: number): WorkflowNode[] {
	return nodes.map(n => {
		if (n.type === 'repeat') {
			return { ...n, maxIterations: n.maxIterations + extra, steps: bumpRepeatLimits(n.steps, extra) };
		}
		if (n.type === 'sequence') {
			return { ...n, steps: bumpRepeatLimits(n.steps, extra) };
		}
		if (n.type === 'parallel') {
			return { ...n, branches: bumpRepeatLimits(n.branches, extra) };
		}
		return n;
	});
}

async function ensureWorkflowsEnabled(): Promise<boolean> {
	const enabled = vscode.workspace.getConfiguration('tarot.workflows').get<boolean>('enabled', false);
	if (enabled) {
		return true;
	}
	const enableLabel = vscode.l10n.t('Enable Workflows');
	const pick = await vscode.window.showInformationMessage(
		vscode.l10n.t('Workflows are opt-in (tarot.workflows.enabled). Enable them now?'),
		enableLabel,
	);
	if (pick !== enableLabel) {
		return false;
	}
	await vscode.workspace.getConfiguration('tarot.workflows').update('enabled', true, vscode.ConfigurationTarget.Global);
	return true;
}

async function confirmWorkflowApproval(loaded: LoadedRecipe): Promise<boolean> {
	const approveLabel = vscode.l10n.t('Run Workflow');
	const confirm = await vscode.window.showInformationMessage(
		vscode.l10n.t('Approve running workflow "{0}" ({1})?', loaded.name, loaded.scope),
		{ modal: true },
		approveLabel,
	);
	return confirm === approveLabel;
}

export function registerWorkflowCommands(deps: WorkflowCommandsDeps): {
	readonly workflowRunEditor: TarotWorkflowRunEditorManager;
	readonly disposables: vscode.Disposable[];
} {
	const activeWorkflowFlags = new Map<string, { pause: boolean; abort: boolean; recipe: WorkflowRecipe }>();

	const executeWorkflowRun = async (
		root: string,
		recipe: WorkflowRecipe,
		inputs: Record<string, string>,
		existingRun?: WorkflowRunState,
	): Promise<WorkflowRunState> => {
		const run = existingRun ?? deps.workflowEngine.createRunState(recipe, inputs);
		const flags = { pause: false, abort: false, recipe };
		activeWorkflowFlags.set(run.id, flags);
		await deps.workflowRunStore.saveRun(root, run);
		deps.workflowRunsProvider.refresh();
		await workflowRunEditor.openRun(root, run.id, recipe);

		const activeAgentId = deps.runtimeManager.getActiveAgentId();
		try {
			const finalState = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Workflow: {0}', recipe.name), cancellable: true },
				async (progress, token) => deps.workflowEngine.run(
					recipe,
					root,
					inputs,
					{
						shouldPause: () => flags.pause,
						shouldAbort: () => flags.abort || token.isCancellationRequested,
						onStateChange: updated => {
							workflowRunEditor.updateOpenRun(updated, recipe);
							deps.workflowRunsProvider.refresh();
						},
						executeWatch: async (node, currentRun) => {
							if (node.handler === 'command') {
								const cmd = String(node.config.command ?? '');
								const evalRes = await deps.permissionsService.evaluateShellCommand(cmd, { headless: true });
								if (evalRes.decision.effect === 'deny') {
									const msg = evalRes.decision.reason ?? vscode.l10n.t('Watch command denied by permissions policy.');
									deps.outputChannel.appendLine(`[Permissions] workflow watch "${node.id}" denied: ${cmd} — ${msg}`);
									return { outcome: 'idle', cursor: currentRun.watchCursors[node.id], error: msg };
								}
							}
							return runWatchPoll(node, {
								workspacePath: root,
								cursor: currentRun.watchCursors[node.id],
								config: node.config,
							});
						},
						executeStep: async req => {
							progress.report({ message: vscode.l10n.t('Step {0} ({1})', req.step.id, req.step.agent) });
							const targetAdapter = deps.runtimeManager.getAdapter(req.step.agent) ?? deps.runtimeManager.getAdapter(activeAgentId);
							if (!targetAdapter) {
								return { ok: false, output: `No agent adapter available for "${req.step.agent}".` };
							}
							const cpId = await deps.checkpointService.createCheckpoint(req.workspaceRoot, req.runId);
							const stepPrompt = composeWorkflowStepPrompt(req.step.agent, req.resolvedPrompt, req.step.artifacts);
							let output = '';
							let hadErr = false;
							await targetAdapter.run(
								{
									prompt: stepPrompt,
									mode: 'vibe',
									autonomy: 'acceptFileChanges',
									model: req.modelId,
									effort: req.effortLevel,
									cwd: req.workspaceRoot,
									timeoutMs: vscode.workspace.getConfiguration('tarot.agents').get<number>('timeoutMs', 300_000),
								},
								ev => {
									if (ev.type === 'text' && ev.content) {
										output += ev.content;
									} else if (ev.type === 'error' && ev.content) {
										hadErr = true;
										output += `\n[Error] ${ev.content}`;
									}
								},
								token,
							);
							if (cpId) {
								const diff = await deps.checkpointService.getCheckpointDiff(req.workspaceRoot, req.runId, cpId);
								const deniedPaths: string[] = [];
								for (const entry of diff) {
									const decision = await deps.permissionsService.evaluate('fs_write', entry.relativePath, { headless: true });
									if (decision.effect === 'deny') {
										deniedPaths.push(entry.relativePath);
									}
								}
								if (deniedPaths.length > 0) {
									const rev = await deps.checkpointService.restoreCheckpointFiles(req.workspaceRoot, req.runId, cpId, deniedPaths);
									deps.outputChannel.appendLine(`[Permissions] workflow step "${req.step.id}" fs_write denied, reverted: ${rev.reverted.join(', ') || '(none)'}`);
								}
							}
							const trimmedOutput = output.trim();
							const artifacts = extractArtifactsFromOutput(trimmedOutput, req.step.artifacts);
							return {
								ok: !hadErr && !token.isCancellationRequested,
								output: trimmedOutput,
								artifacts: Object.keys(artifacts).length > 0 ? artifacts : undefined,
							};
						},
					},
					run,
				),
			);
			const completedSteps = Object.values(finalState.stepStates).filter(s => s.status === 'completed').length;
			const totalSteps = Object.values(finalState.stepStates).length;
			await deps.getAgentPanelProvider().postWorkflowNotification(
				vscode.l10n.t('Workflow "{0}" — {1}', finalState.recipeName, finalState.status),
				vscode.l10n.t('Run `{0}` · {1}/{2} step(s) completed.{3}', finalState.id, completedSteps, totalSteps, finalState.lastError ? `\n\nError: ${finalState.lastError}` : ''),
			);
			return finalState;
		} finally {
			activeWorkflowFlags.delete(run.id);
			deps.workflowRunsProvider.refresh();
		}
	};

	const loadSavedRunAndRecipe = async (runId: string): Promise<{ root: string; saved: WorkflowRunState; loaded: LoadedRecipe } | undefined> => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return undefined;
		}
		const saved = await deps.workflowRunStore.loadRun(root, runId);
		if (!saved) {
			return undefined;
		}
		const discovery = await deps.recipeLoader.discover(vscode.workspace.isTrusted ? root : undefined);
		const loaded = discovery.recipes.find(r => r.name === saved.recipeName);
		if (!loaded) {
			return undefined;
		}
		return { root, saved, loaded };
	};

	const workflowRunEditor = new TarotWorkflowRunEditorManager(deps.extensionUri, deps.workflowRunStore, {
		onPause: runId => {
			const f = activeWorkflowFlags.get(runId);
			if (f) { f.pause = true; }
		},
		onStop: runId => {
			const f = activeWorkflowFlags.get(runId);
			if (f) { f.abort = true; }
		},
		onResume: async (runId, answerText, targetStepId) => {
			if (activeWorkflowFlags.has(runId)) {
				vscode.window.showInformationMessage(vscode.l10n.t('This workflow run is already active.'));
				return;
			}
			const ctx = await loadSavedRunAndRecipe(runId);
			if (!ctx || ctx.saved.status !== 'paused') {
				return;
			}
			const nextInputs: Record<string, string> = { ...ctx.saved.inputs };
			if (answerText) {
				nextInputs.user_reply = answerText;
				if (targetStepId && ctx.saved.stepStates[targetStepId]?.status === 'paused') {
					ctx.saved.stepStates[targetStepId].status = 'pending';
					ctx.saved.outputs[targetStepId] = `${ctx.saved.outputs[targetStepId] ?? ''}\n\n[User answer]: ${answerText}`.trim();
				}
			}
			await executeWorkflowRun(ctx.root, ctx.loaded.recipe, nextInputs, ctx.saved);
		},
		onAddLoops: async (runId, extraIterations) => {
			if (activeWorkflowFlags.has(runId)) {
				return;
			}
			const ctx = await loadSavedRunAndRecipe(runId);
			if (!ctx) {
				return;
			}
			const extended: WorkflowRecipe = { ...ctx.loaded.recipe, steps: bumpRepeatLimits(ctx.loaded.recipe.steps, extraIterations) };
			await executeWorkflowRun(ctx.root, extended, { ...ctx.saved.inputs }, ctx.saved);
		},
	});

	const disposables: vscode.Disposable[] = [
		workflowRunEditor,

		vscode.commands.registerCommand('tarot.workflows.validate', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage(vscode.l10n.t('Open a .workflow.json or .workflow.yaml file to validate.'));
				return;
			}
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			try {
				const fsPath = editor.document.uri.fsPath.toLowerCase();
				let raw: WorkflowRecipe | undefined;
				if (fsPath.endsWith('.json')) {
					raw = JSON.parse(editor.document.getText()) as WorkflowRecipe;
				} else if (fsPath.endsWith('.yaml') || fsPath.endsWith('.yml')) {
					raw = parseYamlLite(editor.document.getText()) as WorkflowRecipe;
				}
				if (!raw) {
					vscode.window.showWarningMessage(vscode.l10n.t('Open a .workflow.json, .workflow.yaml or .workflow.yml file to validate.'));
					return;
				}
				const result = validateWorkflow(raw, root);
				if (result.valid) {
					vscode.window.showInformationMessage(vscode.l10n.t('Workflow "{0}" is valid ({1} steps, depth {2}).', raw.name, result.staticStepCount, result.maxDepth));
				} else {
					deps.outputChannel.appendLine(`[Workflows] Validation errors in ${editor.document.fileName}:\n${result.errors.join('\n')}`);
					vscode.window.showErrorMessage(vscode.l10n.t('Workflow validation failed with {0} error(s). See Tarot IDE output channel.', result.errors.length));
				}
			} catch (err) {
				vscode.window.showErrorMessage(vscode.l10n.t('Invalid workflow file: {0}', err instanceof Error ? err.message : String(err)));
			}
		}),

		vscode.commands.registerCommand('tarot.workflows.run', async () => {
			if (!(await ensureWorkflowsEnabled())) {
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const discovery = await deps.recipeLoader.discover(vscode.workspace.isTrusted ? root : undefined);
			if (discovery.recipes.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No workflow recipes found.'));
				return;
			}
			const picked = await vscode.window.showQuickPick(
				discovery.recipes.map(r => ({
					label: r.name,
					description: r.scope,
					detail: r.recipe.description,
					loaded: r,
				})),
				{ title: vscode.l10n.t('Run Workflow Recipe') },
			);
			if (!picked) {
				return;
			}
			const taskInput = await vscode.window.showInputBox({
				title: vscode.l10n.t('Workflow "{0}" — Task Input', picked.loaded.name),
				prompt: vscode.l10n.t('Describe the task for this workflow run'),
			});
			if (!taskInput?.trim() || !(await confirmWorkflowApproval(picked.loaded))) {
				return;
			}

			const runState = await executeWorkflowRun(root, picked.loaded.recipe, { task: taskInput.trim(), input: taskInput.trim() });
			deps.outputChannel.appendLine(`[Workflows] Run ${runState.id} (${runState.recipeName}) finished with status: ${runState.status}`);
			vscode.window.showInformationMessage(vscode.l10n.t('Workflow "{0}" finished: {1}.', runState.recipeName, runState.status));
		}),

		vscode.commands.registerCommand('tarot.workflows.runRecipe', async (item?: { loadedRecipe?: LoadedRecipe }) => {
			const loaded = item?.loadedRecipe;
			if (!loaded) {
				await vscode.commands.executeCommand('tarot.workflows.run');
				return;
			}
			if (!(await ensureWorkflowsEnabled())) {
				return;
			}
			const root = await deps.ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const taskInput = await vscode.window.showInputBox({
				title: vscode.l10n.t('Workflow "{0}" — Task Input', loaded.name),
				prompt: vscode.l10n.t('Describe the task for this workflow run'),
			});
			if (!taskInput?.trim() || !(await confirmWorkflowApproval(loaded))) {
				return;
			}
			await executeWorkflowRun(root, loaded.recipe, { task: taskInput.trim(), input: taskInput.trim() });
		}),

		vscode.commands.registerCommand('tarot.workflows.openRun', async (runId?: string, stepId?: string) => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root || !runId) {
				return;
			}
			const run = await deps.workflowRunStore.loadRun(root, runId);
			if (!run) {
				return;
			}
			const discovery = await deps.recipeLoader.discover(vscode.workspace.isTrusted ? root : undefined);
			const loaded = discovery.recipes.find(r => r.name === run.recipeName);
			await workflowRunEditor.openRun(root, runId, loaded?.recipe, stepId);
		}),

		vscode.commands.registerCommand('tarot.workflows.searchRuns', async () => {
			const query = await vscode.window.showInputBox({
				title: vscode.l10n.t('Search Workflow Runs'),
				prompt: vscode.l10n.t('Filter by recipe name, status, or run ID (leave empty to clear)'),
				value: deps.workflowRunsProvider.getSearchQuery(),
			});
			if (query !== undefined) {
				deps.workflowRunsProvider.setSearchQuery(query);
			}
		}),
	];

	return { workflowRunEditor, disposables };
}
