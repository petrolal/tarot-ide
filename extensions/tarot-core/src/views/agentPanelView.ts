/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { TarotSessionStore } from '../agents/sessionStore';
import {
	AgentId,
	AgentMode,
	AgentModelOption,
	AttachedContext,
	AutonomyMode,
	ContextProviderKind,
	FileWriteApprovalGate,
	ReasoningEffort,
	SpecApprovalGate,
	TaskProgressCard,
} from '../agents/types';
import { TarotCheckpointService } from '../checkpoints/checkpointService';
import { getTarotConfig } from '../config/tarotConfig';
import { resolveContextProvider } from '../context/contextProviders';
import { ChangedFileInfo, TarotGitReviewService } from '../git/gitReviewService';
import { runHooksForTrigger, selectHooksForTrigger, TarotHookEngine } from '../hooks/hookEngine';
import { runHookCommand } from '../hooks/hookRunner';
import { HookDefinition } from '../hooks/hookTypes';
import { TarotPermissionsService } from '../permissions/permissionsService';
import { describeAdvisoryTranslation, getEnforcementKind } from '../permissions/policyEngine';
import { SpecCreationKind, SpecPhase, TarotSpecService } from '../specs/specService';
import { mergeTasksMarkdown } from '../specs/specSync';
import { recordTaskCheckpoint } from '../specs/specTaskCheckpoints';
import { markTaskCompletedInFile, SpecTask } from '../specs/taskParser';
import { runTaskWaves } from '../specs/taskRunner';
import { TarotSteeringService } from '../steering/steeringService';
import { getPanelStrings } from './panelStrings';

interface WebviewIncomingMessage {
	readonly type:
		| 'ready'
		| 'send'
		| 'cancel'
		| 'selectAgent'
		| 'setModel'
		| 'setEffort'
		| 'setMode'
		| 'setAutonomy'
		| 'attachActiveFile'
		| 'pickContextProvider'
		| 'removeAttachment'
		| 'newSession'
		| 'selectSession'
		| 'closeSession'
		| 'restoreCheckpoint'
		| 'approveSpecGate'
		| 'resolveFileWriteGate'
		| 'openInEditorTab'
		| 'toggleFocusMode'
		| 'openFileDiff'
		| 'revertFile'
		| 'refreshChangedFiles'
		| 'runSlashCommand'
		| 'saveSteeringRule'
		| 'refreshAgents';
	readonly prompt?: string;
	readonly ruleText?: string;
	readonly agentId?: AgentId;
	readonly model?: string;
	readonly effort?: ReasoningEffort;
	readonly mode?: AgentMode;
	readonly autonomy?: AutonomyMode;
	readonly kind?: ContextProviderKind;
	readonly sessionId?: string;
	readonly checkpointId?: string;
	readonly messageId?: string;
	readonly relativePath?: string;
	readonly fileStatus?: ChangedFileInfo['status'];
	readonly keep?: boolean;
	readonly slashCommand?: string;
	readonly index?: number;
}

const SELECTED_MODEL_STATE_KEY = 'tarot.selectedModel';
const SELECTED_EFFORT_STATE_KEY = 'tarot.selectedEffort';
const VALID_EFFORTS: readonly ReasoningEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

export class TarotAgentPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'tarot.views.agentPanel';

	private view: vscode.WebviewView | undefined;
	private editorPanel: vscode.WebviewPanel | undefined;
	private isFocusMode = false;
	private mode: AgentMode = 'vibe';
	private autonomy: AutonomyMode = 'acceptFileChanges';
	private readonly runGatedHookCommand: typeof runHookCommand;
	private selectedModel = 'auto';
	private selectedEffort: ReasoningEffort = 'auto';
	private availableModels: readonly AgentModelOption[] = [];
	private attachments: AttachedContext[] = [];
	private changedFiles: ChangedFileInfo[] = [];
	private activeCancellation: vscode.CancellationTokenSource | undefined;
	private runningSessionId: string | undefined;
	private readonly queuedHookPrompts: string[] = [];
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly runtimeManager: AgentRuntimeManager,
		private readonly sessionStore: TarotSessionStore,
		private readonly checkpointService: TarotCheckpointService,
		private readonly steeringService: TarotSteeringService,
		private readonly specService: TarotSpecService,
		private readonly gitReviewService: TarotGitReviewService,
		private readonly hookEngine: TarotHookEngine,
		private readonly permissionsService: TarotPermissionsService,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.runGatedHookCommand = this.permissionsService.createGatedRunCommand(this.outputChannel);
		// Restores the last model/effort the user picked (falls back to the 'auto' field
		// initializer above when nothing was saved yet, same pattern as
		// `runtimeManager.ts`'s ACTIVE_AGENT_STATE_KEY).
		const savedModel = this.context.globalState.get<string>(SELECTED_MODEL_STATE_KEY);
		if (savedModel && savedModel.trim()) {
			this.selectedModel = savedModel.trim();
		}
		const savedEffort = this.context.globalState.get<ReasoningEffort>(SELECTED_EFFORT_STATE_KEY);
		if (savedEffort && VALID_EFFORTS.includes(savedEffort)) {
			this.selectedEffort = savedEffort;
		}
		this.disposables.push(
			this.runtimeManager.onDidChangeAgents(() => { void this.refreshAvailableModels().then(() => this.postState()); }),
			this.runtimeManager.onDidChangeActiveAgent(() => { void this.refreshAvailableModels().then(() => this.postState()); }),
			vscode.workspace.onDidSaveTextDocument(() => { void this.refreshChangedFiles(); }),
		);
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'media'),
				vscode.Uri.joinPath(this.extensionUri, 'icons'),
			],
		};
		webviewView.webview.html = this.buildHtml(webviewView.webview);

		const msgSub = webviewView.webview.onDidReceiveMessage((msg: WebviewIncomingMessage) => {
			void this.handleMessage(msg);
		});
		const disposeSub = webviewView.onDidDispose(() => {
			this.cancelActiveRun();
			this.view = undefined;
		});
		this.disposables.push(msgSub, disposeSub);
	}

	async setMode(mode: AgentMode): Promise<void> {
		this.mode = mode;
		const session = this.sessionStore.getActiveSession(this.runtimeManager.getActiveAgentId(), this.mode, this.autonomy);
		session.mode = mode;
		this.postState();
	}

	async runExternalPrompt(prompt: string, mode?: AgentMode): Promise<void> {
		if (mode) {
			await this.setMode(mode);
		}
		await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		await this.runPrompt(prompt);
	}

	async openInEditorTab(): Promise<void> {
		if (this.editorPanel) {
			this.editorPanel.reveal(vscode.ViewColumn.Active);
			this.postState();
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'tarot.agentEditorTab',
			'Tarot Agent',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
			},
		);
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
		panel.webview.html = this.buildHtml(panel.webview);
		this.editorPanel = panel;

		panel.webview.onDidReceiveMessage((msg: WebviewIncomingMessage) => {
			void this.handleMessage(msg);
		});
		panel.onDidDispose(() => {
			this.editorPanel = undefined;
			if (this.isFocusMode) {
				this.isFocusMode = false;
				this.postState();
			}
		});
		await this.refreshChangedFiles();
		this.postState();
	}

	async toggleAgentFocusMode(): Promise<void> {
		this.isFocusMode = !this.isFocusMode;
		if (this.isFocusMode) {
			await this.openInEditorTab();
			await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
		} else {
			if (this.editorPanel) {
				this.editorPanel.dispose();
				this.editorPanel = undefined;
			}
			await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		}
		this.postState();
	}

	async attachSelectionAndFocus(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const fsPath = editor.document.uri.fsPath;
			const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
			if (!editor.selection.isEmpty) {
				const startLine = editor.selection.start.line + 1;
				const endLine = editor.selection.end.line + 1;
				const selectionText = editor.document.getText(editor.selection);
				this.addAttachment({
					kind: 'file',
					label: `${relPath}:${startLine}-${endLine}`,
					path: fsPath,
					selection: selectionText,
				});
			} else {
				this.addAttachment({
					kind: 'file',
					label: relPath,
					path: fsPath,
					content: editor.document.getText().slice(0, 12_000),
				});
			}
		}
		if (this.editorPanel) {
			this.editorPanel.reveal(vscode.ViewColumn.Active);
		} else {
			await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		}
		this.postMessage({ type: 'focusInput' });
	}

	async refreshChangedFiles(): Promise<void> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) {
			this.changedFiles = [];
			return;
		}
		this.changedFiles = await this.gitReviewService.getChangedFiles(cwd);
		this.postState();
	}

	async introduceSpecInPanel(specDir: string, slug: string, creationKind: SpecCreationKind): Promise<void> {
		const activeAgent = this.runtimeManager.getActiveAgentId();
		const session = this.sessionStore.createSession(activeAgent, 'spec', this.autonomy);
		session.title = vscode.l10n.t('Spec: {0}', slug);
		this.mode = 'spec';

		const targetPhase: 'requirements' | 'design' = creationKind === 'feature-design-first' ? 'requirements' : 'design';
		const label = creationKind === 'feature-design-first'
			? vscode.l10n.t('Approve Design & Generate Requirements (EARS)')
			: creationKind === 'bugfix'
				? vscode.l10n.t('Approve Bugfix (EARS) & Generate Root Cause Design')
				: vscode.l10n.t('Approve Requirements (EARS) & Generate Design');

		await this.sessionStore.appendMessage(session, {
			role: 'assistant',
			agentId: activeAgent,
			mode: 'spec',
			content: vscode.l10n.t(
				'Spec **{0}** ({1}) created in `.tarot/specs/{0}/`. Review the file opened in the editor and click below when you are ready to advance to the next phase.',
				slug,
				creationKind,
			),
			approvalGate: {
				specDir,
				specSlug: slug,
				targetPhase,
				label,
				approved: false,
			},
		});

		await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		this.postState();
	}

	async runAnalyzeRequirements(specDir: string): Promise<void> {
		const spec = await this.specService.loadSpecContext(specDir);
		await this.setMode('spec');
		await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		await this.runPrompt(this.specService.buildAnalyzeRequirementsPrompt(spec), {
			displayPrompt: vscode.l10n.t('🔍 Analyze Requirements · {0}', spec.slug),
		});
	}

	async runQuickSpec(specDir: string, description: string): Promise<void> {
		const spec = await this.specService.loadSpecContext(specDir);
		const activeAgent = this.runtimeManager.getActiveAgentId();
		const session = this.sessionStore.createSession(activeAgent, 'spec', this.autonomy);
		session.title = vscode.l10n.t('Quick Spec: {0}', spec.slug);
		this.mode = 'spec';
		await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		this.postState();
		await this.runPrompt(this.specService.buildQuickSpecPrompt(spec, description), {
			displayPrompt: vscode.l10n.t('⚡ Quick Spec ({0}): {1}', spec.slug, description),
		});
	}

	async runBatchPrompt(prompt: string, displayPrompt: string): Promise<void> {
		await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		await this.runPrompt(prompt, { displayPrompt });
	}

	async generateSpecFromActiveSession(): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			vscode.window.showWarningMessage(vscode.l10n.t('Open a folder/workspace to generate a Spec.'));
			return;
		}
		const activeAgent = this.runtimeManager.getActiveAgentId();
		const session = this.sessionStore.getActiveSession(activeAgent, this.mode, this.autonomy);
		const confirm = await vscode.window.showInformationMessage(
			vscode.l10n.t('Start a new Spec session reusing the current conversation context?'),
			{ modal: false },
			vscode.l10n.t('Generate Spec'),
		);
		if (!confirm) {
			return;
		}
		const rawSlug = await vscode.window.showInputBox({
			title: vscode.l10n.t('Generate Spec from Session'),
			prompt: vscode.l10n.t('Slug for the new Spec under .tarot/specs/'),
			placeHolder: 'feature-from-chat',
			validateInput: v => (/^[a-z0-9][a-z0-9-_]*$/i.test(v.trim()) ? null : vscode.l10n.t('Use only letters, numbers, hyphens, and underscores.')),
		});
		if (!rawSlug) {
			return;
		}
		const slug = rawSlug.trim().toLowerCase();
		const transcript = session.messages
			.slice(-8)
			.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1200)}`)
			.join('\n\n') || vscode.l10n.t('(New session)');
		const { entryFilePath } = await this.specService.createSpec(root, slug, 'feature-requirements-first');
		const doc = await vscode.workspace.openTextDocument(entryFilePath);
		await vscode.window.showTextDocument(doc, { preview: false });

		const specSession = this.sessionStore.createSession(activeAgent, 'spec', this.autonomy);
		specSession.title = vscode.l10n.t('Spec: {0}', slug);
		this.mode = 'spec';
		await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		this.postState();
		await this.runPrompt(this.specService.buildGenerateSpecFromChatPrompt(slug, transcript), {
			displayPrompt: vscode.l10n.t('📋 Generate Spec: {0}', slug),
		});
	}

	async runSpecTask(specDir: string, lineIndex: number, overrideAgentId?: AgentId): Promise<void> {
		if (overrideAgentId) {
			await this.runtimeManager.setActiveAgent(overrideAgentId);
		}
		const spec = await this.specService.loadSpecContext(specDir);
		const task = spec.taskSummary.tasks.find(t => t.lineIndex === lineIndex);
		if (!task) {
			vscode.window.showWarningMessage(vscode.l10n.t('Task not found in tasks.md.'));
			return;
		}
		await this.runSpecTaskInternal(specDir, task);
	}

	/**
	 * Runs **Run all Tasks**: groups incomplete, mandatory (unless `includeOptional`) tasks into
	 * dependency-ordered waves (`taskGraph`/`taskRunner`) and executes them one by one — true
	 * parallel execution needs multiple concurrent agent sessions, reused from `worktreeManager`
	 * once M3.8c/M3.9a land multi-session support.
	 */
	async runAllSpecTasks(specDir: string, includeOptional: boolean): Promise<void> {
		const spec = await this.specService.loadSpecContext(specDir);
		const pending = spec.taskSummary.tasks.filter(t => !t.completed && (includeOptional || !t.optional));
		if (pending.length === 0) {
			vscode.window.showInformationMessage(vscode.l10n.t('No pending tasks to run in {0}.', spec.slug));
			return;
		}

		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Tarot — Run all Tasks ({0})', spec.slug), cancellable: true },
			async (progress, token) => {
				let runIndex = 0;
				const summary = await runTaskWaves(
					pending,
					async task => {
						runIndex++;
						if (token.isCancellationRequested) {
							return false;
						}
						progress.report({ message: vscode.l10n.t('Task #{0}: {1} ({2}/{3})', task.index, task.title, runIndex, pending.length) });
						return this.runSpecTaskInternal(specDir, task);
					},
					{ includeOptional },
				);
				const failed = summary.results.filter(r => r.status !== 'succeeded').length;
				if (failed > 0) {
					vscode.window.showWarningMessage(vscode.l10n.t('Run all Tasks finished with {0} task(s) failed or skipped (dependency not satisfied).', failed));
				}
			},
		);
	}

	async runSyncFiles(specDir: string): Promise<void> {
		const spec = await this.specService.loadSpecContext(specDir);
		await this.setMode('spec');
		await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);

		const tasksFilePath = path.join(specDir, 'tasks.md');
		const previousTasksContent = await fs.readFile(tasksFilePath, 'utf8').catch(() => undefined);

		await this.runPrompt(this.specService.buildSyncFilesPrompt(spec), {
			displayPrompt: vscode.l10n.t('↻ Sync Files · {0}', spec.slug),
			onCompleted: async () => {
				if (previousTasksContent !== undefined) {
					const regenerated = await fs.readFile(tasksFilePath, 'utf8').catch(() => undefined);
					if (regenerated !== undefined && regenerated !== previousTasksContent) {
						const merged = mergeTasksMarkdown(previousTasksContent, regenerated);
						if (merged.content !== regenerated) {
							await fs.writeFile(tasksFilePath, merged.content, 'utf8');
						}
					}
				}
				const reloaded = await this.specService.loadSpecContext(specDir);
				if (reloaded.taskSummary.total === 0) {
					return undefined;
				}
				return {
					title: vscode.l10n.t('Synced task list · {0}', reloaded.slug),
					done: reloaded.taskSummary.done,
					total: reloaded.taskSummary.total,
					items: reloaded.taskSummary.tasks.map(t => ({ label: t.title, completed: t.completed })),
				};
			},
		});
	}

	private async runSpecTaskInternal(specDir: string, task: SpecTask): Promise<boolean> {
		const spec = await this.specService.loadSpecContext(specDir);
		const taskKey = task.numberLabel ?? String(task.index);
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const workspaceHooks = vscode.workspace.isTrusted ? await this.hookEngine.discover(cwd) : [];

		if (workspaceHooks.length > 0) {
			const pre = await runHooksForTrigger(workspaceHooks, 'PreTaskExecution', { cwd, tool_name: taskKey }, { matchInput: taskKey, runCommand: this.runGatedHookCommand });
			this.logHookWarnings(pre.warnings);
			if (pre.blocked) {
				vscode.window.showWarningMessage(vscode.l10n.t('Hook "{0}" blocked Task #{1}: {2}', pre.blockedBy?.name ?? '?', task.index, pre.blockReason ?? ''));
				return false;
			}
		}

		await this.setMode('spec');
		await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);

		const prompt = this.specService.buildTaskExecutionPrompt(spec, task);
		const tasksFilePath = path.join(specDir, 'tasks.md');

		const succeeded = await this.runPrompt(prompt, {
			displayPrompt: vscode.l10n.t('▶ Run Task #{0} ({1}): {2}', task.index, spec.slug, task.title),
			onCheckpointCreated: async (checkpointId, sessionId) => {
				if (checkpointId) {
					await recordTaskCheckpoint(specDir, taskKey, { sessionId, checkpointId, createdAt: new Date().toISOString() });
				}
			},
			onCompleted: async () => {
				const updated = await markTaskCompletedInFile(tasksFilePath, task.lineIndex);
				return {
					title: vscode.l10n.t('Updated task list · {0}', spec.slug),
					done: updated.done,
					total: updated.total,
					items: updated.tasks.map(t => ({ label: t.title, completed: t.completed })),
				};
			},
		});

		if (workspaceHooks.length > 0) {
			const post = await runHooksForTrigger(workspaceHooks, 'PostTaskExecution', { cwd, tool_name: taskKey }, { matchInput: taskKey, runCommand: this.runGatedHookCommand });
			this.logHookWarnings(post.warnings);
			for (const action of post.agentActions) {
				this.queuedHookPrompts.push(action.prompt);
			}
			await this.drainQueuedHookPrompts();
		}

		return succeeded;
	}

	private async handleMessage(msg: WebviewIncomingMessage): Promise<void> {
		const activeAgent = this.runtimeManager.getActiveAgentId();
		switch (msg.type) {
			case 'ready':
				await this.refreshChangedFiles();
				await this.refreshAvailableModels();
				this.postState();
				break;
			case 'refreshAgents':
				await this.runtimeManager.refresh();
				await this.refreshAvailableModels();
				this.postState();
				break;
			case 'selectAgent':
				if (msg.agentId) {
					await this.runtimeManager.setActiveAgent(msg.agentId);
					const session = this.sessionStore.getActiveSession(msg.agentId, this.mode, this.autonomy);
					session.activeAgentId = msg.agentId;
					this.selectedModel = 'auto';
					await this.context.globalState.update(SELECTED_MODEL_STATE_KEY, this.selectedModel);
					await this.refreshAvailableModels();
					this.postState();
				}
				break;
			case 'setModel':
				if (typeof msg.model === 'string' && msg.model.trim()) {
					this.selectedModel = msg.model.trim();
					await this.context.globalState.update(SELECTED_MODEL_STATE_KEY, this.selectedModel);
					this.postState();
				}
				break;
			case 'setEffort':
				if (msg.effort && VALID_EFFORTS.includes(msg.effort)) {
					this.selectedEffort = msg.effort;
					await this.context.globalState.update(SELECTED_EFFORT_STATE_KEY, this.selectedEffort);
					this.postState();
				}
				break;
			case 'setMode':
				if (msg.mode === 'vibe' || msg.mode === 'spec' || msg.mode === 'plan') {
					await this.setMode(msg.mode);
				}
				break;
			case 'setAutonomy':
				if (msg.autonomy === 'supervised' || msg.autonomy === 'acceptFileChanges' || msg.autonomy === 'approveForMe') {
					this.autonomy = msg.autonomy;
					const session = this.sessionStore.getActiveSession(activeAgent, this.mode, this.autonomy);
					session.autonomy = this.autonomy;
					this.postState();
				}
				break;
			case 'attachActiveFile':
				await this.attachActiveEditor();
				break;
			case 'pickContextProvider':
				if (msg.kind) {
					const resolved = await resolveContextProvider(msg.kind);
					if (resolved) {
						this.addAttachment(resolved);
					}
				}
				break;
			case 'removeAttachment':
				if (typeof msg.index === 'number' && msg.index >= 0 && msg.index < this.attachments.length) {
					this.attachments.splice(msg.index, 1);
					this.postState();
				}
				break;
			case 'newSession':
				this.attachments = [];
				this.sessionStore.createSession(activeAgent, this.mode, this.autonomy);
				this.postState();
				break;
			case 'selectSession':
				if (msg.sessionId) {
					const selected = this.sessionStore.selectSession(msg.sessionId);
					if (selected) {
						this.mode = selected.mode;
						this.autonomy = selected.autonomy;
						this.postState();
					}
				}
				break;
			case 'closeSession':
				if (msg.sessionId) {
					if (this.runningSessionId === msg.sessionId) {
						this.cancelActiveRun();
					}
					const next = this.sessionStore.closeSession(msg.sessionId, activeAgent);
					this.mode = next.mode;
					this.autonomy = next.autonomy;
					this.postState();
				}
				break;
			case 'restoreCheckpoint':
				if (msg.checkpointId) {
					const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					const session = this.sessionStore.getActiveSession(activeAgent, this.mode, this.autonomy);
					if (cwd) {
						await this.checkpointService.restoreCheckpoint(cwd, session.id, msg.checkpointId);
					}
				}
				break;
			case 'approveSpecGate':
				if (msg.messageId) {
					await this.handleApproveSpecGate(msg.messageId);
				}
				break;
			case 'resolveFileWriteGate':
				if (msg.messageId && typeof msg.keep === 'boolean') {
					await this.handleResolveFileWriteGate(msg.messageId, msg.keep);
				}
				break;
			case 'openInEditorTab':
				await this.openInEditorTab();
				break;
			case 'toggleFocusMode':
				await this.toggleAgentFocusMode();
				break;
			case 'openFileDiff':
				if (msg.relativePath && msg.fileStatus) {
					const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (cwd) {
						await this.gitReviewService.openFileDiff(cwd, msg.relativePath, msg.fileStatus);
					}
				}
				break;
			case 'revertFile':
				if (msg.relativePath && msg.fileStatus) {
					const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (cwd) {
						const reverted = await this.gitReviewService.revertFile(cwd, msg.relativePath, msg.fileStatus);
						if (reverted) {
							await this.refreshChangedFiles();
						}
					}
				}
				break;
			case 'refreshChangedFiles':
				await this.refreshChangedFiles();
				break;
			case 'runSlashCommand':
				if (msg.slashCommand) {
					await this.handleSlashCommand(msg.slashCommand);
				}
				break;
			case 'saveSteeringRule':
				if (msg.ruleText && msg.ruleText.trim()) {
					await this.saveLearnedSteeringRule(msg.ruleText.trim());
				}
				break;
			case 'cancel':
				this.cancelActiveRun();
				break;
			case 'send':
				if (msg.prompt && msg.prompt.trim().length > 0) {
					await this.runPrompt(msg.prompt.trim());
				}
				break;
		}
	}

	private addAttachment(att: AttachedContext): void {
		const exists = this.attachments.some(a => a.kind === att.kind && a.label === att.label);
		if (!exists) {
			this.attachments.push(att);
			this.postState();
		}
	}

	private async attachActiveEditor(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			const picked = await resolveContextProvider('file');
			if (picked) {
				this.addAttachment(picked);
			}
			return;
		}
		const fsPath = editor.document.uri.fsPath;
		const relPath = vscode.workspace.asRelativePath(editor.document.uri, false);
		const selectionText = editor.selection.isEmpty ? undefined : editor.document.getText(editor.selection);
		const content = selectionText ? undefined : editor.document.getText().slice(0, 12_000);

		this.addAttachment({
			kind: 'file',
			label: selectionText ? vscode.l10n.t('{0} (selection)', relPath) : relPath,
			path: fsPath,
			selection: selectionText,
			content,
		});
	}

	private cancelActiveRun(): void {
		if (this.activeCancellation) {
			this.activeCancellation.cancel();
			this.activeCancellation.dispose();
			this.activeCancellation = undefined;
		}
	}

	private collectActiveFilePaths(attachments: readonly AttachedContext[]): string[] {
		const files = new Set<string>();
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor && activeEditor.document.uri.scheme === 'file') {
			files.add(activeEditor.document.uri.fsPath);
		}
		for (const att of attachments) {
			if (att.kind === 'file' && att.path) {
				files.add(att.path);
			}
		}
		return [...files];
	}

	private async handleSlashCommand(cmd: string): Promise<void> {
		const activeAgent = this.runtimeManager.getActiveAgentId();
		switch (cmd) {
			case '/spec':
				await vscode.commands.executeCommand('tarot.specs.create');
				break;
			case '/quick-spec':
				await vscode.commands.executeCommand('tarot.specs.quickSpec');
				break;
			case '/generate-spec':
				await this.generateSpecFromActiveSession();
				break;
			case '/bugfix':
				await vscode.commands.executeCommand('tarot.specs.create');
				break;
			case '/plan':
				await this.setMode('plan');
				break;
			case '/steering':
				await vscode.commands.executeCommand('tarot.steering.generate');
				break;
			case '/focus':
				await this.toggleAgentFocusMode();
				break;
			case '/clear':
				this.sessionStore.createSession(activeAgent, this.mode, this.autonomy);
				this.attachments = [];
				this.postState();
				break;
			case '/review': {
				const diffAtt = await resolveContextProvider('gitDiff');
				const probAtt = await resolveContextProvider('problems');
				if (diffAtt) {
					this.addAttachment(diffAtt);
				}
				if (probAtt) {
					this.addAttachment(probAtt);
				}
				await this.runPrompt('Revise as alterações atuais (#Git Diff) e quaisquer erros em #Problems. Aponte bugs, riscos de segurança e melhorias objetivas.');
				break;
			}
		}
	}

	private async handleApproveSpecGate(messageId: string): Promise<void> {
		const activeAgent = this.runtimeManager.getActiveAgentId();
		const session = this.sessionStore.getActiveSession(activeAgent, this.mode, this.autonomy);
		const msg = session.messages.find(m => m.id === messageId);
		if (!msg?.approvalGate || msg.approvalGate.approved) {
			return;
		}
		msg.approvalGate.approved = true;
		await this.sessionStore.saveSession(session);
		this.postState();

		const gate = msg.approvalGate;
		const spec = await this.specService.loadSpecContext(gate.specDir);
		const phasePrompt = this.specService.buildPhaseAdvancePrompt(spec, gate.targetPhase as SpecPhase);

		let nextGate: SpecApprovalGate | undefined;
		if (gate.targetPhase === 'design' || gate.targetPhase === 'requirements') {
			nextGate = {
				specDir: gate.specDir,
				specSlug: gate.specSlug,
				targetPhase: 'tasks',
				label: vscode.l10n.t('Approve & Generate Tasks Checklist'),
				approved: false,
			};
		}

		await this.runPrompt(phasePrompt, {
			displayPrompt: vscode.l10n.t('✓ {0}', gate.label),
			nextApprovalGate: nextGate,
			onCompleted: gate.targetPhase === 'tasks'
				? async () => {
					const reloaded = await this.specService.loadSpecContext(gate.specDir);
					if (reloaded.taskSummary.total === 0) {
						return undefined;
					}
					return {
						title: vscode.l10n.t('Updated task list · {0}', reloaded.slug),
						done: reloaded.taskSummary.done,
						total: reloaded.taskSummary.total,
						items: reloaded.taskSummary.tasks.map(t => ({ label: t.title, completed: t.completed })),
					};
				}
				: undefined,
		});
	}

	private async handleResolveFileWriteGate(messageId: string, keep: boolean): Promise<void> {
		const activeAgent = this.runtimeManager.getActiveAgentId();
		const session = this.sessionStore.getActiveSession(activeAgent, this.mode, this.autonomy);
		const msg = session.messages.find(m => m.id === messageId);
		if (!msg?.fileWriteGate || msg.fileWriteGate.resolution) {
			return;
		}
		const gate = msg.fileWriteGate;
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!keep && cwd) {
			await this.checkpointService.restoreCheckpointFiles(cwd, gate.sessionId, gate.checkpointId, gate.files);
			await this.refreshChangedFiles();
		}
		gate.resolution = keep ? 'kept' : 'reverted';
		await this.sessionStore.saveSession(session);
		this.postState();
	}

	private async runPrompt(
		prompt: string,
		options?: {
			displayPrompt?: string;
			nextApprovalGate?: SpecApprovalGate;
			onCompleted?: () => Promise<TaskProgressCard | undefined>;
			onCheckpointCreated?: (checkpointId: string | undefined, sessionId: string) => Promise<void>;
		},
	): Promise<boolean> {
		if (this.runningSessionId) {
			return false;
		}

		const agentId = this.runtimeManager.getActiveAgentId();
		const adapter = this.runtimeManager.getAdapter(agentId);
		if (!adapter) {
			this.postMessage({ type: 'streamError', content: vscode.l10n.t('No adapter found for {0}.', agentId) });
			return false;
		}

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const session = this.sessionStore.getActiveSession(agentId, this.mode, this.autonomy);
		session.activeAgentId = agentId;
		session.mode = this.mode;
		session.autonomy = this.autonomy;

		const workspaceHooks = vscode.workspace.isTrusted ? await this.hookEngine.discover(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) : [];
		let effectivePrompt = prompt;
		if (workspaceHooks.length > 0) {
			const promptSubmit = await runHooksForTrigger(
				workspaceHooks,
				'PromptSubmit',
				{ cwd, session_id: session.id, user_prompt: prompt },
				{ matchInput: prompt, inlineAgentPrompts: true, runCommand: this.runGatedHookCommand },
			);
			if (promptSubmit.blocked) {
				this.postMessage({ type: 'streamError', content: vscode.l10n.t('Blocked by hook "{0}": {1}', promptSubmit.blockedBy?.name ?? '?', promptSubmit.blockReason ?? '') });
				return false;
			}
			if (promptSubmit.contextAppend.length > 0) {
				effectivePrompt = `${prompt}\n\n${promptSubmit.contextAppend.join('\n\n')}`;
			}
			this.logHookWarnings(promptSubmit.warnings);
		}

		const historySnapshot = [...session.messages];
		const requestAttachments = [...this.attachments];
		this.attachments = [];

		await this.sessionStore.appendMessage(session, {
			role: 'user',
			mode: this.mode,
			content: options?.displayPrompt ?? prompt,
			attachments: requestAttachments,
		});

		const checkpointId = vscode.workspace.workspaceFolders?.[0]
			? await this.checkpointService.createCheckpoint(cwd, session.id)
			: undefined;
		if (options?.onCheckpointCreated) {
			await options.onCheckpointCreated(checkpointId, session.id);
		}

		const startedAt = Date.now();
		this.runningSessionId = session.id;
		this.activeCancellation = new vscode.CancellationTokenSource();
		this.postState();
		this.postMessage({ type: 'streamStart', agentId, agentName: adapter.displayName, sessionId: session.id });

		// Steering lives under .tarot/steering/ — never loaded in an untrusted workspace (AGENTS.md
		// §2d / MIGRATION_PLAN.md M3.8a), since a cloned repo could otherwise prompt-inject instructions.
		const steeringResolution = vscode.workspace.isTrusted
			? await this.steeringService.resolveForTurn({
				workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
				prompt,
				activeFiles: this.collectActiveFilePaths(requestAttachments),
				attachments: requestAttachments,
			})
			: { applied: [] };
		const steeringContext = steeringResolution.formattedContext;
		const appliedSteering = steeringResolution.applied.map(item => item.label);
		// Same Workspace Trust gate as Steering above — a cloned repo's .tarot/specs/** must not
		// auto-inject content before the user has trusted the workspace.
		const specContext = vscode.workspace.isTrusted ? await this.resolveActiveSpecContext(cwd) : undefined;
		let accumulatedText = '';
		let accumulatedThought = '';
		let hadError = false;
		let totalTokens: number | undefined;
		const usedTools: string[] = [];
		let runSucceeded = false;

		this.outputChannel.appendLine(
			`[AgentPanel] Running ${adapter.id} (${this.mode}/${this.autonomy}) in ${cwd}` +
			(appliedSteering.length > 0 ? ` | steering: ${appliedSteering.join(', ')}` : '')
		);

		try {
			await adapter.run(
				{
					prompt: effectivePrompt,
					mode: this.mode,
					autonomy: this.autonomy,
					model: this.selectedModel,
					effort: this.selectedEffort,
					cwd,
					systemContext: steeringContext,
					specContext,
					attachments: requestAttachments,
					conversationHistory: historySnapshot,
					timeoutMs: getTarotConfig().timeoutMs,
				},
				event => {
					if (event.type === 'text' && event.content) {
						accumulatedText += event.content;
						this.postMessage({ type: 'streamChunk', content: event.content });
					} else if (event.type === 'thought' && event.content) {
						accumulatedThought += event.content;
						this.postMessage({ type: 'streamThought', content: event.content });
					} else if (event.type === 'tool_start' && event.toolName) {
						usedTools.push(event.toolName);
						this.postMessage({ type: 'streamTool', toolName: event.toolName });
						if (workspaceHooks.length > 0) {
							void this.runPreToolUseHook(workspaceHooks, event.toolName, cwd, session.id);
						}
					} else if (event.type === 'tool_end' && event.toolName && workspaceHooks.length > 0) {
						void this.runPostToolUseHook(workspaceHooks, event.toolName, cwd, session.id);
					} else if (event.type === 'status') {
						const usage = event.metadata?.usage as { total_tokens?: number } | undefined;
						if (usage && typeof usage.total_tokens === 'number' && usage.total_tokens > 0) {
							totalTokens = usage.total_tokens;
						}
						if (event.content) {
							this.postMessage({ type: 'streamStatus', content: event.content });
						}
					} else if (event.type === 'error' && event.content) {
						hadError = true;
						accumulatedText += (accumulatedText ? '\n\n' : '') + vscode.l10n.t('[Error] {0}', event.content);
						this.postMessage({ type: 'streamError', content: event.content });
					}
				},
				this.activeCancellation.token,
			);
		} finally {
			const wasCancelled = this.activeCancellation?.token.isCancellationRequested ?? false;
			runSucceeded = !wasCancelled && !hadError;
			const elapsedMs = Date.now() - startedAt;
			this.runningSessionId = undefined;
			if (this.activeCancellation) {
				this.activeCancellation.dispose();
				this.activeCancellation = undefined;
			}

			let taskProgress: TaskProgressCard | undefined;
			if (!wasCancelled && !hadError && options?.onCompleted) {
				try {
					taskProgress = await options.onCompleted();
				} catch {
					// Non-fatal
				}
			}

			const fileWriteGate = !wasCancelled && !hadError && checkpointId
				? await this.reviewFileWritesForTurn(cwd, session.id, checkpointId)
				: undefined;

			if (accumulatedText.trim().length > 0 || usedTools.length > 0 || taskProgress || fileWriteGate) {
				await this.sessionStore.appendMessage(session, {
					role: 'assistant',
					agentId,
					mode: this.mode,
					content: accumulatedText || vscode.l10n.t('(Run completed with no additional output.)'),
					thought: accumulatedThought || undefined,
					tools: usedTools.length > 0 ? usedTools : undefined,
					appliedSteering: appliedSteering.length > 0 ? appliedSteering : undefined,
					taskProgress,
					approvalGate: !wasCancelled && !hadError ? options?.nextApprovalGate : undefined,
					fileWriteGate,
					elapsedMs,
					totalTokens,
					checkpointId,
				});
			}

			this.postMessage({ type: 'streamEnd' });
			await this.refreshChangedFiles();
			this.postState();

			if (!wasCancelled && workspaceHooks.length > 0) {
				void this.runStopHooks(workspaceHooks, cwd, session.id);
			}
		}

		return runSucceeded;
	}

	private async runPreToolUseHook(hooks: readonly HookDefinition[], toolName: string, cwd: string, sessionId: string): Promise<void> {
		const result = await runHooksForTrigger(hooks, 'PreToolUse', { cwd, session_id: sessionId, tool_name: toolName }, { matchInput: toolName, runCommand: this.runGatedHookCommand });
		this.logHookWarnings(result.warnings);
		if (result.blocked) {
			this.outputChannel.appendLine(`[Hooks] PreToolUse "${result.blockedBy?.name}" denied tool "${toolName}" — cancelling the run.`);
			this.postMessage({ type: 'streamError', content: vscode.l10n.t('Hook "{0}" blocked tool "{1}"; stopping the agent.', result.blockedBy?.name ?? '?', toolName) });
			this.cancelActiveRun();
		}
		for (const agentAction of result.agentActions) {
			this.queuedHookPrompts.push(agentAction.prompt);
		}
	}

	private async runPostToolUseHook(hooks: readonly HookDefinition[], toolName: string, cwd: string, sessionId: string): Promise<void> {
		const result = await runHooksForTrigger(hooks, 'PostToolUse', { cwd, session_id: sessionId, tool_name: toolName }, { matchInput: toolName, runCommand: this.runGatedHookCommand });
		this.logHookWarnings(result.warnings);
		for (const action of result.agentActions) {
			this.queuedHookPrompts.push(action.prompt);
		}
	}

	private async runStopHooks(hooks: readonly HookDefinition[], cwd: string, sessionId: string): Promise<void> {
		const selected = selectHooksForTrigger(hooks, 'Stop');
		for (const hook of selected) {
			if (hook.action.type === 'command' && hook.action.confirm) {
				await this.runStopHookWithConfirm(hook, cwd, sessionId);
				continue;
			}
			if (hook.action.type === 'command' && hook.action.command) {
				const outcome = await this.runGatedHookCommand(hook.action.command, { cwd, session_id: sessionId, hook_event_name: 'Stop' }, hook.timeout);
				if (outcome.kind === 'warn') {
					this.logHookWarnings([{ hook, message: outcome.stderr || `Hook "${hook.name}" exited with code ${outcome.exitCode}.` }]);
				}
			} else if (hook.action.type === 'agent' && hook.action.prompt) {
				this.queuedHookPrompts.push(hook.action.prompt);
			}
		}

		await this.drainQueuedHookPrompts();
	}

	private async drainQueuedHookPrompts(): Promise<void> {
		if (this.queuedHookPrompts.length > 0 && !this.runningSessionId) {
			const next = this.queuedHookPrompts.shift()!;
			await this.runBatchPrompt(next, vscode.l10n.t('🪝 Hook follow-up'));
		}
	}

	private async runStopHookWithConfirm(hook: HookDefinition, cwd: string, sessionId: string): Promise<void> {
		const confirm = hook.action.confirm!;
		const picked = await vscode.window.showInformationMessage(
			confirm.question,
			{ modal: false },
			...confirm.options.map(o => o.label),
		);
		const option = confirm.options.find(o => o.label === picked);
		if (!option) {
			return;
		}
		const command = option.run ?? hook.action.command;
		if (!command) {
			return;
		}
		const outcome = await this.runGatedHookCommand(command, { cwd, session_id: sessionId, hook_event_name: 'Stop' }, hook.timeout);
		if (outcome.kind === 'warn') {
			this.logHookWarnings([{ hook, message: outcome.stderr || `Hook "${hook.name}" exited with code ${outcome.exitCode}.` }]);
		}
	}

	private logHookWarnings(warnings: readonly { hook: HookDefinition; message: string }[]): void {
		for (const w of warnings) {
			this.outputChannel.appendLine(`[Hooks] "${w.hook.name}" (${w.hook.trigger}): ${w.message}`);
		}
	}

	private estimateContextPercent(messages: readonly { content: string }[], attachments: readonly AttachedContext[]): number {
		let chars = 0;
		for (const m of messages) {
			chars += m.content.length;
		}
		for (const a of attachments) {
			chars += (a.content?.length ?? 0) + (a.selection?.length ?? 0) + 120;
		}
		// Rough visual estimate against ~120k chars context window
		return Math.min(100, Math.round((chars / 120_000) * 100));
	}

	private async saveLearnedSteeringRule(ruleText: string): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before writing rules to .tarot/steering/.'));
			return;
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return;
		}
		const steeringDir = path.join(root, '.tarot', 'steering');
		const filePath = path.join(steeringDir, 'pbt-rules.md');
		await fs.mkdir(steeringDir, { recursive: true });
		let existing = '';
		try {
			existing = await fs.readFile(filePath, 'utf8');
		} catch {
			existing = `---\ninclusion: always\n---\n\n# Learned Correctness & PBT Rules\n\n`;
		}
		const entry = `- ${ruleText.replace(/\r?\n/g, ' ')}\n`;
		await fs.writeFile(filePath, existing.endsWith('\n') ? `${existing}${entry}` : `${existing}\n${entry}`, 'utf8');
		vscode.window.showInformationMessage(vscode.l10n.t('Saved learned rule to .tarot/steering/pbt-rules.md.'));
	}

	private async refreshAvailableModels(): Promise<void> {
		this.availableModels = await this.runtimeManager.listModelsForAgent();
	}

	/**
	 * Post-hoc `fs_write` enforcement for a completed turn (gap found in code review,
	 * 2026-11-22): `fs_write` was defined in the policy schema but never evaluated anywhere, so
	 * nothing ever actually gated what a BYOA agent wrote to disk. Tarot cannot deny the write
	 * before it happens (`policyEngine.ts::getEnforcementKind`), but it CAN enforce the final
	 * state — every file this turn's checkpoint diff shows as changed is evaluated: `deny`
	 * reverts it immediately and silently (logged, not surfaced as a card — the policy already
	 * said no), `ask` surfaces a real approval card naming the files, with a revert path that
	 * actually works (`checkpointService.restoreCheckpointFiles`, scoped to exactly those files).
	 */
	private async reviewFileWritesForTurn(cwd: string, sessionId: string, checkpointId: string): Promise<FileWriteApprovalGate | undefined> {
		const diff = await this.checkpointService.getCheckpointDiff(cwd, sessionId, checkpointId);
		if (diff.length === 0) {
			return undefined;
		}
		const denied: string[] = [];
		const asked: string[] = [];
		for (const entry of diff) {
			const decision = await this.permissionsService.evaluate('fs_write', entry.relativePath);
			if (decision.effect === 'deny') {
				denied.push(entry.relativePath);
			} else if (decision.effect === 'ask') {
				// An explicit rule (a Tarot invariant like `.git/**`, or something the user wrote
				// into permissions.yaml) always asks, regardless of autonomy mode — that is the
				// point of configuring it. The bare "ask when nothing matches" default only asks
				// in Supervised: Accept File Changes/Approve For Me chose to skip per-edit review
				// for ordinary files, and this gate must not quietly reintroduce it for every turn.
				if (!decision.defaulted || this.autonomy === 'supervised') {
					asked.push(entry.relativePath);
				}
			}
		}
		if (denied.length > 0) {
			await this.checkpointService.restoreCheckpointFiles(cwd, sessionId, checkpointId, denied);
			this.outputChannel.appendLine(`[Permissions] fs_write denied, auto-reverted: ${denied.join(', ')}`);
		}
		if (asked.length === 0) {
			return undefined;
		}
		return { sessionId, checkpointId, files: asked };
	}

	/**
	 * Surfaces `.tarot/specs/**` content automatically, the same way Steering is auto-resolved,
	 * so a plain chat turn is aware of an existing Spec instead of asking questions the user
	 * already answered in requirements.md (gap found in code review, 2026-11-22). Prefers the
	 * Spec that owns the active editor's file; falls back to the only Spec in the workspace when
	 * there is exactly one; with 2+ unrelated Specs, lists their names instead of guessing which
	 * one applies.
	 */
	private async resolveActiveSpecContext(root: string): Promise<string | undefined> {
		const specs = await this.specService.listSpecs(root);
		if (specs.length === 0) {
			return undefined;
		}
		const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
		const activeSpec = activeFilePath
			? specs.find(s => activeFilePath === s.dirPath || activeFilePath.startsWith(s.dirPath + path.sep))
			: undefined;
		const target = activeSpec ?? (specs.length === 1 ? specs[0] : undefined);
		if (target) {
			const loaded = await this.specService.loadSpecContext(target.dirPath);
			return loaded.contextText;
		}
		const list = specs.map(s => `- ${s.slug} (${s.taskSummary.done}/${s.taskSummary.total} tasks)`).join('\n');
		return `Multiple Specs exist in this workspace and none matches the active editor. Ask the user which one applies instead of assuming:\n${list}`;
	}

	private postState(): void {
		const activeAgentId = this.runtimeManager.getActiveAgentId();
		const activeSession = this.sessionStore.getActiveSession(activeAgentId, this.mode, this.autonomy);
		const sessions = this.sessionStore.listSessions().map(s => ({
			id: s.id,
			title: s.title,
			mode: s.mode,
			isRunning: this.runningSessionId === s.id,
		}));

		this.postMessage({
			type: 'state',
			agents: this.runtimeManager.getStatuses(),
			activeAgentId,
			models: this.availableModels,
			selectedModel: this.selectedModel,
			selectedEffort: this.selectedEffort,
			mode: this.mode,
			autonomy: this.autonomy,
			permissionEnforcement: { kind: getEnforcementKind(activeAgentId), detail: describeAdvisoryTranslation(activeAgentId) },
			isFocusMode: this.isFocusMode,
			isRunning: Boolean(this.runningSessionId),
			activeSessionId: activeSession.id,
			sessions,
			attachments: this.attachments.map(a => ({ kind: a.kind, label: a.label })),
			changedFiles: this.changedFiles,
			messages: activeSession.messages,
			contextPercent: this.estimateContextPercent(activeSession.messages, this.attachments),
		});
	}

	private postMessage(payload: Record<string, unknown>): void {
		if (this.view) {
			void this.view.webview.postMessage(payload);
		}
		if (this.editorPanel) {
			void this.editorPanel.webview.postMessage(payload);
		}
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'panel.css'));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'panel.js'));
		const arcanaArt = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'arcana', file)).toString();
		const arcanaSvg = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'icons', 'arcana', file)).toString();
		const arcanaPayload = JSON.stringify({
			art: {
				vibe: arcanaArt('00-the-fool.png'),
				spec: arcanaArt('05-the-hierophant.png'),
				plan: arcanaArt('09-the-hermit.png'),
				bugfix: arcanaArt('16-the-tower.png'),
			},
			icons: {
				newSession: arcanaSvg('00-the-fool.svg'),
				plan: arcanaSvg('09-the-hermit.svg'),
				error: arcanaSvg('16-the-tower.svg'),
				checkpoint: arcanaSvg('17-the-star.svg'),
			},
		}).replace(/</g, '\\u003c');
		const s = getPanelStrings();
		// Catalog consumed by media/webview/panel.js for strings it renders at runtime.
		// `<` escaping keeps the JSON safe to embed inside a <script> element.
		const l10nPayload = JSON.stringify(s).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${cssUri}" />
	<title>Tarot Agent</title>
</head>
<body>
	<div class="tarot-shell">
		<header class="session-tabbar">
			<span class="tabbar-brand">TAROT</span>
			<div id="session-tabs" class="session-tabs" role="tablist"></div>
			<button id="btn-new-session" class="tabbar-add-btn" type="button" title="${s.newSession}">
				<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
			</button>
			<button id="btn-dock-editor" class="tabbar-add-btn tabbar-secondary-btn" type="button" title="${s.dockEditorTab}">
				<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M9.5 2.5h4v4M13.5 2.5L8.5 7.5M6.5 13.5h-4v-4M2.5 13.5l5-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
			</button>
			<button id="btn-focus-mode" class="tabbar-add-btn tabbar-secondary-btn" type="button" title="${s.toggleFocusMode}">
				<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="12" height="11" rx="1.8" stroke="currentColor" stroke-width="1.4"/><path d="M6 2.5v11" stroke="currentColor" stroke-width="1.3"/></svg>
			</button>
		</header>

		<main id="messages" class="tarot-messages" aria-live="polite"></main>

		<footer class="tarot-composer-wrap">
			<div id="review-bar" class="review-bar hidden">
				<div class="review-bar-header">
					<button id="btn-review-toggle" class="review-toggle-btn" type="button">
						<span id="review-summary-text">0 ${s.filesChanged}</span>
					</button>
					<button id="btn-review-refresh" class="review-mini-btn" type="button" title="${s.refreshGitDiff}">↻</button>
				</div>
				<div id="review-file-list" class="review-file-list hidden"></div>
			</div>

			<div id="context-menu" class="context-popup hidden" role="menu">
				<div class="context-popup-header">${s.contextProvidersTitle}</div>
				<button class="context-menu-item" type="button" data-kind="file"><span class="ctx-tag">#File</span><span class="ctx-desc">${s.contextFileDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="folder"><span class="ctx-tag">#Folder</span><span class="ctx-desc">${s.contextFolderDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="spec"><span class="ctx-tag">#Spec</span><span class="ctx-desc">${s.contextSpecDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="problems"><span class="ctx-tag">#Problems</span><span class="ctx-desc">${s.contextProblemsDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="gitDiff"><span class="ctx-tag">#Git Diff</span><span class="ctx-desc">${s.contextGitDiffDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="codebase"><span class="ctx-tag">#Codebase</span><span class="ctx-desc">${s.contextCodebaseDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="terminal"><span class="ctx-tag">#Terminal</span><span class="ctx-desc">${s.contextTerminalDesc}</span></button>
				<button class="context-menu-item" type="button" data-kind="steering"><span class="ctx-tag">#Steering</span><span class="ctx-desc">${s.contextSteeringDesc}</span></button>
			</div>

			<div id="slash-menu" class="context-popup hidden" role="menu">
				<div class="context-popup-header">${s.slashCommandsTitle}</div>
				<button class="slash-menu-item" type="button" data-cmd="/spec"><span class="ctx-tag">/spec</span><span class="ctx-desc">${s.slashSpecDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/quick-spec"><span class="ctx-tag">/quick-spec</span><span class="ctx-desc">${s.slashQuickSpecDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/generate-spec"><span class="ctx-tag">/generate-spec</span><span class="ctx-desc">${s.slashGenerateSpecDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/plan"><span class="ctx-tag">/plan</span><span class="ctx-desc">${s.slashPlanDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/steering"><span class="ctx-tag">/steering</span><span class="ctx-desc">${s.slashSteeringDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/review"><span class="ctx-tag">/review</span><span class="ctx-desc">${s.slashReviewDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/focus"><span class="ctx-tag">/focus</span><span class="ctx-desc">${s.slashFocusDesc}</span></button>
				<button class="slash-menu-item" type="button" data-cmd="/clear"><span class="ctx-tag">/clear</span><span class="ctx-desc">${s.slashClearDesc}</span></button>
			</div>

			<div id="model-menu" class="context-popup model-popover hidden" role="menu">
				<div class="popover-section">
					<div class="context-popup-header">Agent CLI</div>
					<div id="model-agent-pills" class="pill-row"></div>
				</div>
				<div class="popover-section">
					<div class="context-popup-header">Model</div>
					<div id="model-options-list" class="model-options-list"></div>
				</div>
				<div class="popover-section">
					<div class="context-popup-header">Reasoning Effort</div>
					<div id="effort-pills" class="pill-row effort-row"></div>
				</div>
			</div>

			<div id="mode-menu" class="context-popup mode-popover hidden" role="menu">
				<div class="context-popup-header">Mode (Shift+Tab)</div>
				<button class="mode-menu-item" type="button" data-mode="vibe"><span class="ctx-tag">Default</span><span class="ctx-desc">${s.modeVibeDesc}</span></button>
				<button class="mode-menu-item" type="button" data-mode="spec"><span class="ctx-tag">Spec</span><span class="ctx-desc">${s.modeSpecDesc}</span></button>
				<button class="mode-menu-item" type="button" data-mode="plan"><span class="ctx-tag">Plan</span><span class="ctx-desc">${s.slashPlanDesc}</span></button>
			</div>

			<div id="autonomy-menu" class="context-popup mode-popover hidden" role="menu">
				<div class="context-popup-header">${s.autonomyMenuHeader}</div>
				<button class="mode-menu-item" type="button" data-autonomy="supervised"><span class="ctx-tag">${s.autonomySupervisedTitle}</span><span class="ctx-desc">${s.autonomySupervisedDesc}</span></button>
				<button class="mode-menu-item" type="button" data-autonomy="acceptFileChanges"><span class="ctx-tag">${s.autonomyAcceptTitle}</span><span class="ctx-desc">${s.autonomyAcceptDesc}</span></button>
				<button class="mode-menu-item" type="button" data-autonomy="approveForMe"><span class="ctx-tag">${s.autonomyApproveTitle}</span><span class="ctx-desc">${s.autonomyApproveDesc}</span></button>
			</div>

			<div id="status-row" class="status-row hidden">
				<span class="status-dot"></span>
				<span id="status-indicator" class="status-text"></span>
			</div>

			<div class="composer-card">
				<div id="attachments" class="attachments-bar hidden"></div>

				<div class="composer-input-row">
					<textarea
						id="prompt-input"
						rows="1"
						placeholder="${s.promptPlaceholder}"
					></textarea>
					<button id="btn-send" class="action-icon-btn" type="button" title="${s.send}" disabled>
						<svg id="icon-send" width="14" height="14" viewBox="0 0 16 16" fill="none">
							<path d="M8 12.5V3.5M4 7.5L8 3.5L12 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
						<svg id="icon-stop" class="hidden" width="11" height="11" viewBox="0 0 16 16" fill="none">
							<rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/>
						</svg>
					</button>
				</div>

				<div class="composer-bottom">
					<div class="composer-left">
						<button id="btn-hash" class="tool-icon-btn" type="button" title="${s.contextProvidersHint}">
							<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6.2 2.5L4.8 13.5M11.2 2.5L9.8 13.5M2.8 6h10.8M2.4 10h10.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
						</button>
						<button id="btn-attach" class="tool-icon-btn" type="button" title="${s.attachActiveFile}">
							<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10.5 4.5L5.8 9.2a1.75 1.75 0 1 0 2.48 2.48l5.3-5.3a3 3 0 0 0-4.24-4.24l-5.5 5.5a4.25 4.25 0 0 0 6.01 6.01l4.4-4.4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>
						</button>
						<span id="context-ring" class="context-ring">
							<svg width="14" height="14" viewBox="0 0 16 16">
								<circle class="context-ring-track" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.7"/>
								<circle id="context-ring-arc" class="context-ring-fill" cx="8" cy="8" r="5.5" fill="none" stroke-width="1.7" stroke-dasharray="34.56" stroke-dashoffset="34.56" stroke-linecap="round" transform="rotate(-90 8 8)"/>
							</svg>
						</span>
						<button id="btn-model-picker" class="picker-trigger-btn" type="button" aria-label="${s.localAgentAria}">
							<span id="model-picker-label">Auto</span>
							<svg class="picker-chevron" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4.5 6.2L8 9.8l3.5-3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
						</button>
					</div>

					<div class="composer-right">
						<button id="btn-mode-picker" class="picker-trigger-btn" type="button" aria-label="${s.modeAria}">
							<span id="mode-picker-label">Default</span>
							<svg class="picker-chevron" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4.5 6.2L8 9.8l3.5-3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
						</button>
						<button id="btn-autonomy-picker" class="picker-trigger-btn" type="button" aria-label="${s.autonomyAria}" title="${s.autonomyAria}">
							<span id="autonomy-enforcement-dot" class="enforcement-dot" title=""></span>
							<span id="autonomy-picker-label">${s.autonomyAcceptTitle}</span>
							<svg class="picker-chevron" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4.5 6.2L8 9.8l3.5-3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
						</button>
					</div>
				</div>
			</div>
		</footer>
	</div>
	<script nonce="${nonce}">window.__tarotL10n = ${l10nPayload};window.__tarotArcana = ${arcanaPayload};</script>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}

	dispose(): void {
		this.cancelActiveRun();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
