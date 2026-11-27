/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BUILT_IN_AGENT_PROFILES, CustomAgentProfile, TarotCustomAgentService } from '../agents/customAgentService';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { checkSessionConcurrency } from '../agents/sessionConcurrency';
import { TarotSessionStore } from '../agents/sessionStore';
import {
	AgentId,
	AgentMode,
	AgentModelOption,
	AttachedContext,
	AutonomyMode,
	FileWriteApprovalGate,
	ReasoningEffort,
	SpecApprovalGate,
	TaskProgressCard,
} from '../agents/types';
import { CheckpointDiffEntry, TarotCheckpointService } from '../checkpoints/checkpointService';
import { reviewFileWritesForTurn } from '../review/fileWriteReviewGate';
import { TarotReviewSessionService } from '../review/reviewSessionService';
import { getTarotConfig } from '../config/tarotConfig';
import {
	ActiveFileSnapshot,
	buildAutoActiveFileAttachment,
	buildAutoActiveFileChip,
} from '../context/activeFileContext';
import { compactConversationMessages, computeContextMeter, formatSessionExportBundle, formatSessionExportMarkdown } from '../context/compactionService';
import { resolveContextProvider } from '../context/contextProviders';
import { ChangedFileInfo, TarotGitReviewService } from '../git/gitReviewService';
import { TarotWorktree, TarotWorktreeManager } from '../git/worktreeManager';
import { runHooksForTrigger, selectHooksForTrigger, TarotHookEngine } from '../hooks/hookEngine';
import { runHookCommand } from '../hooks/hookRunner';
import { HookDefinition } from '../hooks/hookTypes';
import { TarotMcpConfigService } from '../mcp/mcpConfigService';
import { TarotPermissionsService } from '../permissions/permissionsService';
import { describeAdvisoryTranslation, getEnforcementKind } from '../permissions/policyEngine';
import { TarotPowersService } from '../powers/powersService';
import { TarotSkillsService } from '../skills/skillsService';
import { SpecCreationKind, SpecPhase, TarotSpecService } from '../specs/specService';
import { mergeTasksMarkdown } from '../specs/specSync';
import { computeTaskCheckpointKey, recordTaskCheckpoint } from '../specs/specTaskCheckpoints';
import { markTaskCompletedInFile, SpecTask } from '../specs/taskParser';
import { runTaskWaves } from '../specs/taskRunner';
import { TarotSteeringService } from '../steering/steeringService';
import { buildAgentPanelHtml } from './panelHtml';
import { isWebviewIncomingMessage, WebviewIncomingMessage } from './panelProtocol';
import { assembleTurnSystemContext } from './turnContextBuilder';

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
	private agentProfiles: CustomAgentProfile[] = [...BUILT_IN_AGENT_PROFILES];
	private activeProfileId = 'default';
	private manualSteeringCommands: Array<{ command: string; id: string; description: string }> = [];
	private attachments: AttachedContext[] = [];
	private changedFiles: ChangedFileInfo[] = [];
	private activeCancellation: vscode.CancellationTokenSource | undefined;
	private runningSessionId: string | undefined;
	private readonly queuedHookPrompts: string[] = [];
	private reviewSessionService: TarotReviewSessionService | undefined;
	private lastActiveFileEditor: vscode.TextEditor | undefined;
	private autoContextDismissedForPath: string | undefined;
	private lastAutoActiveChipKey: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	setReviewSessionService(service: TarotReviewSessionService): void {
		this.reviewSessionService = service;
		this.disposables.push(service.onDidChangeState(() => {
			void this.handleReviewSessionStateChanged();
		}));
	}

	private async handleReviewSessionStateChanged(): Promise<void> {
		if (!this.reviewSessionService?.hasPendingReview()) {
			const activeSession = this.sessionStore.getActiveSession(this.runtimeManager.getActiveAgentId(), this.mode, this.autonomy);
			let dirty = false;
			for (const msg of activeSession.messages) {
				if (msg.fileWriteGate && !msg.fileWriteGate.resolution) {
					msg.fileWriteGate.resolution = 'kept';
					dirty = true;
				}
			}
			if (dirty) {
				await this.sessionStore.saveSession(activeSession);
			}
		}
		await this.refreshChangedFiles();
	}

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
		private readonly worktreeManager: TarotWorktreeManager,
		private readonly skillsService: TarotSkillsService,
		private readonly customAgentService: TarotCustomAgentService,
		private readonly powersService: TarotPowersService,
		private readonly mcpConfigService: TarotMcpConfigService,
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
		if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
			this.lastActiveFileEditor = vscode.window.activeTextEditor;
		} else {
			this.lastActiveFileEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
		}
		this.disposables.push(
			this.runtimeManager.onDidChangeAgents(() => { void this.refreshAvailableModels().then(() => this.postState()); }),
			this.runtimeManager.onDidChangeActiveAgent(() => { void this.refreshAvailableModels().then(() => this.postState()); }),
			vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.refreshDynamicCatalogs().then(() => this.postState()); }),
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor && editor.document.uri.scheme === 'file') {
					const nextPath = editor.document.uri.fsPath;
					if (this.autoContextDismissedForPath && this.autoContextDismissedForPath !== nextPath) {
						this.autoContextDismissedForPath = undefined;
					}
					this.lastActiveFileEditor = editor;
				}
				this.syncAutoActiveFileState();
			}),
			vscode.window.onDidChangeTextEditorSelection(e => {
				if (e.textEditor.document.uri.scheme === 'file') {
					this.lastActiveFileEditor = e.textEditor;
					this.syncAutoActiveFileState();
				}
			}),
			vscode.workspace.onDidSaveTextDocument(doc => {
				void this.refreshChangedFiles();
				const norm = doc.uri.fsPath.replace(/\\/g, '/');
				if (norm.includes('/.tarot/steering/') || norm.includes('/.tarot/skills/') || norm.includes('/.tarot/agents/')) {
					void this.refreshDynamicCatalogs().then(() => this.postState());
				}
			}),
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

		const msgSub = webviewView.webview.onDidReceiveMessage((msg: unknown) => {
			if (!isWebviewIncomingMessage(msg)) {
				return;
			}
			void this.handleMessage(msg).catch(err => {
				this.outputChannel.appendLine(`[AgentPanel] Unhandled message error: ${err instanceof Error ? err.message : String(err)}`);
			});
		});
		const disposeSub = webviewView.onDidDispose(() => {
			this.cancelActiveRun();
			this.view = undefined;
			msgSub.dispose();
			disposeSub.dispose();
		});
	}

	/**
	 * `activeProfileId` is panel-wide, not per-session (TD-06): resync it to the mode's default
	 * profile whenever the active session changes, so a turn never silently runs with another
	 * session's explicitly-picked custom profile (tools/permissions/system-prompt).
	 */
	private resetActiveProfileForMode(mode: AgentMode): void {
		this.activeProfileId = mode === 'vibe' ? 'default' : mode;
	}

	async setMode(mode: AgentMode): Promise<void> {
		this.mode = mode;
		this.resetActiveProfileForMode(mode);
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
				localResourceRoots: [
					vscode.Uri.joinPath(this.extensionUri, 'media'),
					vscode.Uri.joinPath(this.extensionUri, 'icons'),
				],
			},
		);
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png');
		panel.webview.html = this.buildHtml(panel.webview);
		this.editorPanel = panel;

		const panelMsgSub = panel.webview.onDidReceiveMessage((msg: unknown) => {
			if (!isWebviewIncomingMessage(msg)) {
				return;
			}
			void this.handleMessage(msg).catch(err => {
				this.outputChannel.appendLine(`[AgentPanel] Unhandled editor tab message error: ${err instanceof Error ? err.message : String(err)}`);
			});
		});
		const panelDisposeSub = panel.onDidDispose(() => {
			panelMsgSub.dispose();
			panelDisposeSub.dispose();
			this.editorPanel = undefined;
			if (this.isFocusMode) {
				this.isFocusMode = false;
				this.postState();
			}
		});
		await this.refreshChangedFiles();
		this.postState();
	}

	private focusModeToggleHandler: (() => Promise<boolean>) | undefined;
	private stateChangeListener: (() => void) | undefined;
	private streamEventListener: ((payload: Record<string, unknown>) => void) | undefined;

	setFocusModeHooks(
		onToggle: () => Promise<boolean>,
		onStateChange: () => void,
		onStreamEvent?: (payload: Record<string, unknown>) => void,
	): void {
		this.focusModeToggleHandler = onToggle;
		this.stateChangeListener = onStateChange;
		this.streamEventListener = onStreamEvent;
	}

	getRunningSessionId(): string | undefined {
		return this.runningSessionId;
	}

	getMode(): AgentMode {
		return this.mode;
	}

	getAutonomy(): AutonomyMode {
		return this.autonomy;
	}

	setAutonomy(autonomy: AutonomyMode): void {
		this.autonomy = autonomy;
		const session = this.sessionStore.getActiveSession(this.runtimeManager.getActiveAgentId(), this.mode, this.autonomy);
		session.autonomy = autonomy;
		this.postState();
	}

	createNewSession(mode?: AgentMode): void {
		const nextMode = mode ?? this.mode;
		this.mode = nextMode;
		this.attachments = [];
		this.sessionStore.createSession(this.runtimeManager.getActiveAgentId(), nextMode, this.autonomy);
		this.postState();
	}

	async openSessionById(sessionId: string): Promise<void> {
		let found = this.sessionStore.selectSession(sessionId);
		if (!found && vscode.workspace.isTrusted) {
			const persisted = await this.sessionStore.listPersistedSessions();
			const target = persisted.find(s => s.id === sessionId);
			if (target) {
				found = this.sessionStore.openPersistedSession(target);
			}
		}
		if (found) {
			this.mode = found.mode;
			this.autonomy = found.autonomy;
			this.resetActiveProfileForMode(found.mode);
			await this.runtimeManager.setActiveAgent(found.activeAgentId);
			this.postState();
		}
	}

	async pickContextFromUi(): Promise<void> {
		const picked = await resolveContextProvider('file');
		if (picked) {
			this.addAttachment(picked);
		}
	}

	async openChangedFileDiff(relativePath: string): Promise<void> {
		if (this.reviewSessionService?.hasPendingFile(relativePath)) {
			await this.reviewSessionService.openFile(relativePath);
			return;
		}
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) {
			return;
		}
		const file = this.changedFiles.find(f => f.relativePath === relativePath);
		await this.gitReviewService.openFileDiff(cwd, relativePath, file?.status ?? 'M');
	}

	async toggleAgentFocusMode(): Promise<void> {
		if (this.focusModeToggleHandler) {
			this.isFocusMode = await this.focusModeToggleHandler();
			this.postState();
			return;
		}
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

	async attachSelectionAndFocus(newSession = false): Promise<void> {
		if (newSession) {
			this.attachments = [];
			this.sessionStore.createSession(this.runtimeManager.getActiveAgentId(), this.mode, this.autonomy);
		}
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
		this.postState();
		if (this.editorPanel) {
			this.editorPanel.reveal(vscode.ViewColumn.Active);
		} else {
			await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		}
		this.postMessage({ type: 'focusInput' });
	}

	async runQuickEditorAction(kind: 'fixGrammar' | 'writeComments' | 'optimize'): Promise<void> {
		await this.attachSelectionAndFocus(false);
		const prompts: Record<'fixGrammar' | 'writeComments' | 'optimize', { prompt: string; display: string }> = {
			fixGrammar: {
				prompt: 'Corrija gramática, ortografia e clareza no trecho/arquivo anexado preservando o significado e o formato original.',
				display: vscode.l10n.t('✦ Ask Tarot: Fix Grammar / Spelling'),
			},
			writeComments: {
				prompt: 'Adicione comentários técnicos concisos e úteis (JSDoc/docstrings apenas onde agregam clareza) ao código anexado, sem alterar o comportamento.',
				display: vscode.l10n.t('✦ Ask Tarot: Write Comments'),
			},
			optimize: {
				prompt: 'Analise e otimize o código anexado buscando melhor legibilidade, complexidade e segurança sem quebrar contratos existentes.',
				display: vscode.l10n.t('✦ Ask Tarot: Optimize Selection'),
			},
		};
		await this.runPrompt(prompts[kind].prompt, { displayPrompt: prompts[kind].display });
	}

	async openSessionHistory(): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before browsing saved session history.'));
			return;
		}
		const persisted = await this.sessionStore.listPersistedSessions();
		if (persisted.length === 0) {
			vscode.window.showInformationMessage(vscode.l10n.t('No saved sessions found in .tarot/sessions/.'));
			return;
		}
		const picked = await vscode.window.showQuickPick(
			persisted.map(s => ({
				label: s.title || s.id,
				description: `${s.activeAgentId} · ${s.mode} · ${s.messages.length} msgs`,
				detail: `${s.id} · ${new Date(s.updatedAt).toLocaleString()}`,
				session: s,
			})),
			{
				title: vscode.l10n.t('Tarot Session History (.tarot/sessions/)'),
				placeHolder: vscode.l10n.t('Search sessions by title, agent or mode...'),
				matchOnDescription: true,
				matchOnDetail: true,
			},
		);
		if (!picked) {
			return;
		}
		const openLabel = vscode.l10n.t('Open Session');
		const deleteLabel = vscode.l10n.t('Delete');
		const action = await vscode.window.showQuickPick(
			[
				{ label: openLabel, action: 'open' as const },
				{ label: deleteLabel, action: 'delete' as const },
			],
			{ title: picked.session.title || picked.session.id },
		);
		if (!action) {
			return;
		}
		if (action.action === 'delete') {
			await this.sessionStore.deletePersistedSession(picked.session.id);
			if (this.sessionStore.listSessions().some(s => s.id === picked.session.id)) {
				this.sessionStore.closeSession(picked.session.id, this.runtimeManager.getActiveAgentId());
			}
			this.postState();
			vscode.window.showInformationMessage(vscode.l10n.t('Deleted session "{0}".', picked.session.title));
			return;
		}
		const opened = this.sessionStore.openPersistedSession(picked.session);
		this.mode = opened.mode;
		this.autonomy = opened.autonomy;
		this.postState();
		await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
	}

	async exportActiveSession(): Promise<void> {
		const session = this.sessionStore.getActiveSession(this.runtimeManager.getActiveAgentId(), this.mode, this.autonomy);
		const fmt = await vscode.window.showQuickPick(
			[
				{ label: vscode.l10n.t('Markdown (.md)'), format: 'md' as const },
				{ label: vscode.l10n.t('Structured Bundle (session.json + messages.jsonl)'), format: 'jsonl' as const },
			],
			{ title: vscode.l10n.t('Export Chat Session') },
		);
		if (!fmt) {
			return;
		}
		if (fmt.format === 'md') {
			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(`${session.id}.md`),
				filters: { Markdown: ['md'] },
			});
			if (!uri) {
				return;
			}
			await fs.writeFile(uri.fsPath, formatSessionExportMarkdown(session), 'utf8');
			vscode.window.showInformationMessage(vscode.l10n.t('Exported session to {0}.', path.basename(uri.fsPath)));
			return;
		}
		const folders = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: vscode.l10n.t('Export Bundle Into Folder'),
		});
		if (!folders?.[0]) {
			return;
		}
		const outDir = path.join(folders[0].fsPath, session.id);
		await fs.mkdir(outDir, { recursive: true });
		const bundle = formatSessionExportBundle(session);
		await fs.writeFile(path.join(outDir, 'session.json'), bundle.sessionJson, 'utf8');
		await fs.writeFile(path.join(outDir, 'messages.jsonl'), bundle.messagesJsonl, 'utf8');
		vscode.window.showInformationMessage(vscode.l10n.t('Exported session.json and messages.jsonl to {0}.', outDir));
	}

	async compactActiveSession(interactive = false): Promise<boolean> {
		const session = this.sessionStore.getActiveSession(this.runtimeManager.getActiveAgentId(), this.mode, this.autonomy);
		const cfg = vscode.workspace.getConfiguration('tarot.compaction');
		const excludeMessages = cfg.get<number>('excludeMessages', 4);
		if (session.messages.length <= excludeMessages + 1) {
			if (interactive) {
				vscode.window.showInformationMessage(vscode.l10n.t('Session is too short to compact (keeping the last {0} messages).', excludeMessages));
			}
			return false;
		}

		if (interactive) {
			const compactLabel = vscode.l10n.t('Compact Now');
			const exportFirstLabel = vscode.l10n.t('Export Chat First');
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t('Compaction summarizes earlier messages and cannot be undone. Export the chat first?'),
				{ modal: true },
				compactLabel,
				exportFirstLabel,
			);
			if (!choice) {
				return false;
			}
			if (choice === exportFirstLabel) {
				await this.exportActiveSession();
			}
		}

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const hooks = vscode.workspace.isTrusted ? await this.hookEngine.discover(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, true) : [];
		if (hooks.length > 0) {
			const pre = await runHooksForTrigger(hooks, 'PreCompaction', { cwd, session_id: session.id }, { runCommand: this.runGatedHookCommand });
			this.logHookWarnings(pre.warnings);
			if (pre.blocked) {
				vscode.window.showWarningMessage(vscode.l10n.t('Compaction cancelled by hook "{0}": {1}', pre.blockedBy?.name ?? '?', pre.blockReason ?? ''));
				return false;
			}
		}

		let postContext: string | undefined;
		if (hooks.length > 0) {
			const post = await runHooksForTrigger(hooks, 'PostCompaction', { cwd, session_id: session.id }, { runCommand: this.runGatedHookCommand });
			this.logHookWarnings(post.warnings);
			if (post.contextAppend.length > 0) {
				postContext = post.contextAppend.join('\n\n');
			}
		}

		const result = compactConversationMessages(session.messages, { excludeMessages, postCompactionContext: postContext });
		if (!result.compacted) {
			return false;
		}
		session.messages = result.messages;
		await this.sessionStore.saveSession(session);
		this.postState();
		this.outputChannel.appendLine(`[Compaction] Compacted ${result.removedCount} message(s) in ${session.id}.`);
		if (interactive) {
			vscode.window.showInformationMessage(vscode.l10n.t('Compacted {0} earlier message(s).', result.removedCount));
		}
		return true;
	}

	async runPrePrReview(): Promise<void> {
		const activeAgent = this.runtimeManager.getActiveAgentId();
		const available = this.runtimeManager.getStatuses().filter(s => s.available);
		const reviewer = available.find(s => s.id !== activeAgent) ?? available[0];
		if (reviewer && reviewer.id !== activeAgent) {
			await this.runtimeManager.setActiveAgent(reviewer.id);
		}
		const diffAtt = await resolveContextProvider('gitDiff');
		const probAtt = await resolveContextProvider('problems');
		if (diffAtt) {
			this.addAttachment(diffAtt);
		}
		if (probAtt) {
			this.addAttachment(probAtt);
		}
		await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		await this.runPrompt(
			'Faça uma revisão Pre-PR completa das alterações atuais (#Git Diff) e diagnósticos (#Problems). Avalie corretude, riscos de segurança, cobertura de testes e aderência à Spec ativa, e entregue ao final um Evidence Summary estruturado (o que foi verificado, o que passou e eventuais bloqueios).',
			{ displayPrompt: vscode.l10n.t('🔍 Pre-PR Review ({0})', reviewer?.displayName ?? activeAgent) },
		);
	}

	async refreshChangedFiles(): Promise<void> {
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd) {
			this.changedFiles = [];
			this.postState();
			return;
		}
		const gitFiles = await this.gitReviewService.getChangedFiles(cwd);
		const pendingStats = this.reviewSessionService?.hasPendingReview()
			? await this.reviewSessionService.getPendingChangedFileStats()
			: [];
		if (pendingStats.length > 0) {
			const byPath = new Map<string, ChangedFileInfo>();
			for (const p of pendingStats) {
				byPath.set(p.relativePath, p);
			}
			for (const g of gitFiles) {
				if (!byPath.has(g.relativePath)) {
					byPath.set(g.relativePath, g);
				}
			}
			this.changedFiles = Array.from(byPath.values());
		} else {
			this.changedFiles = gitFiles;
		}
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

	/** Posts a workflow run summary/notification entry directly into the active parent chat session (M3.9b). */
	async postWorkflowNotification(title: string, body: string): Promise<void> {
		const activeAgent = this.runtimeManager.getActiveAgentId();
		const session = this.sessionStore.getActiveSession(activeAgent, this.mode, this.autonomy);
		await this.sessionStore.appendMessage(session, {
			role: 'assistant',
			agentId: activeAgent,
			mode: this.mode,
			content: `**${title}**\n\n${body}`,
		});
		this.postState();
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

	/**
	 * `worktreeManager.createWorktree` starts from `git rev-parse HEAD` — if the main tree has
	 * uncommitted changes, a worktree built from HEAD would silently give the agent a stale,
	 * incomplete view of the code (missing exactly the in-progress edits a Spec task is most
	 * likely to build on). Isolation is skipped rather than risking that; the task then runs
	 * directly against the workspace, exactly as it did before this was wired up.
	 */
	private async canUseIsolatedWorktree(workspaceRoot: string): Promise<boolean> {
		if (!vscode.workspace.isTrusted) {
			return false;
		}
		const gitPath = await resolveBinaryPath('git');
		if (!gitPath) {
			return false;
		}
		const res = await execSimple(gitPath, ['-C', workspaceRoot, 'status', '--porcelain']).catch(() => undefined);
		return res?.exitCode === 0 && res.stdout.trim().length === 0;
	}

	private async runSpecTaskInternal(specDir: string, task: SpecTask): Promise<boolean> {
		const spec = await this.specService.loadSpecContext(specDir);
		const taskKey = computeTaskCheckpointKey(task);
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const workspaceHooks = vscode.workspace.isTrusted ? await this.hookEngine.discover(cwd, true) : [];

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

		// Isolate the task's edits in a disposable worktree when it's safe to (M3.6.7 shipped
		// `worktreeManager.ts` but nothing ever called it — gap found in code review,
		// 2026-11-22): a failed or cancelled task then never touches the real workspace at all,
		// instead of needing a manual "Restore Checkpoint"; a successful one is merged back
		// atomically via `applyWorktree`. The interactive per-file fs_write "ask" card is skipped
		// for an isolated run — its Revert button depends on the checkpoint the worktree holds,
		// which is gone once discarded — so a hard `deny` rule is instead enforced directly as an
		// apply-time filter below; an `ask` rule has no isolated-run equivalent yet.
		const worktree: TarotWorktree | undefined = await this.canUseIsolatedWorktree(cwd)
			? await this.worktreeManager.createWorktree(cwd, taskKey)
			: undefined;

		const succeeded = await this.runPrompt(prompt, {
			displayPrompt: vscode.l10n.t('▶ Run Task #{0} ({1}): {2}', task.index, spec.slug, task.title),
			execCwd: worktree?.path,
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

		if (worktree) {
			if (succeeded) {
				await this.worktreeManager.applyWorktree(cwd, worktree, async relativePath => {
					const decision = await this.permissionsService.evaluate('fs_write', relativePath);
					if (decision.effect === 'deny') {
						this.outputChannel.appendLine(`[Permissions] fs_write denied, not applied from isolated task worktree: ${relativePath}`);
						return false;
					}
					return true;
				});
			}
			await this.worktreeManager.discardWorktree(cwd, worktree);
			await this.refreshChangedFiles();
		}

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
				if (vscode.workspace.isTrusted) {
					await this.sessionStore.hydrateFromDisk();
				}
				await this.refreshChangedFiles();
				await this.refreshAvailableModels();
				await this.refreshDynamicCatalogs();
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
			case 'dismissAutoActiveFile': {
				const snap = this.captureActiveFileSnapshot();
				this.autoContextDismissedForPath = snap?.fsPath;
				this.postState();
				break;
			}
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
						this.resetActiveProfileForMode(selected.mode);
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
					this.resetActiveProfileForMode(next.mode);
					this.postState();
				}
				break;
			case 'restoreCheckpoint':
				if (msg.checkpointId) {
					const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					const session = this.sessionStore.getActiveSession(activeAgent, this.mode, this.autonomy);
					if (cwd) {
						const restored = await this.checkpointService.restoreCheckpoint(cwd, session.id, msg.checkpointId);
						if (restored) {
							await this.sessionStore.truncateBeforeCheckpoint(session, msg.checkpointId);
							await this.refreshChangedFiles();
							this.postState();
						}
					}
				}
				break;
			case 'forkSession':
				if (msg.messageId) {
					const session = this.sessionStore.getActiveSession(activeAgent, this.mode, this.autonomy);
					await this.sessionStore.forkSession(session, msg.messageId);
					this.attachments = [];
					this.postState();
				}
				break;
			case 'openHistory':
				await this.openSessionHistory();
				break;
			case 'exportSession':
				await this.exportActiveSession();
				break;
			case 'compactSession':
				await this.compactActiveSession(true);
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
					if (this.reviewSessionService?.hasPendingFile(msg.relativePath)) {
						await this.reviewSessionService.openFile(msg.relativePath);
						break;
					}
					const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (cwd) {
						await this.gitReviewService.openFileDiff(cwd, msg.relativePath, msg.fileStatus);
					}
				}
				break;
			case 'openWorkflowRun':
				if (msg.runId) {
					await vscode.commands.executeCommand('tarot.workflows.openRun', msg.runId);
				}
				break;
			case 'revertFile':
				if (msg.relativePath && msg.fileStatus) {
					if (this.reviewSessionService?.hasPendingFile(msg.relativePath)) {
						await this.reviewSessionService.rejectFile(msg.relativePath);
						break;
					}
					const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (cwd) {
						const reverted = await this.gitReviewService.revertFile(cwd, msg.relativePath, msg.fileStatus);
						if (reverted) {
							await this.refreshChangedFiles();
						}
					}
				}
				break;
			case 'acceptReviewFile':
				if (msg.relativePath) {
					await this.reviewSessionService?.acceptFile(msg.relativePath);
				}
				break;
			case 'rejectReviewFile':
				if (msg.relativePath) {
					await this.reviewSessionService?.rejectFile(msg.relativePath);
				}
				break;
			case 'acceptAllReview':
				await this.reviewSessionService?.acceptAll();
				break;
			case 'rejectAllReview':
				await this.reviewSessionService?.rejectAll();
				break;
			case 'openReviewDiff':
				await this.reviewSessionService?.openActiveDiff();
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
			case 'openLink':
				if (typeof msg.url === 'string' && msg.url.trim()) {
					await this.openTranscriptLink(msg.url.trim());
				}
				break;
			case 'selectProfile':
				if (typeof msg.profileId === 'string' && !this.runningSessionId) {
					await this.selectAgentProfile(msg.profileId);
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

	private resolveActiveFileEditor(): vscode.TextEditor | undefined {
		if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
			this.lastActiveFileEditor = vscode.window.activeTextEditor;
			return vscode.window.activeTextEditor;
		}
		if (this.lastActiveFileEditor && !this.lastActiveFileEditor.document.isClosed) {
			return this.lastActiveFileEditor;
		}
		const visible = vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
		if (visible) {
			this.lastActiveFileEditor = visible;
		}
		return visible;
	}

	private captureActiveFileSnapshot(): ActiveFileSnapshot | undefined {
		const editor = this.resolveActiveFileEditor();
		if (!editor || editor.document.uri.scheme !== 'file') {
			return undefined;
		}
		const fsPath = editor.document.uri.fsPath;
		const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
		const hasSelection = !editor.selection.isEmpty;
		const selectionText = hasSelection ? editor.document.getText(editor.selection) : undefined;
		return {
			fsPath,
			relativePath,
			content: editor.document.getText(),
			selectionText,
			selectionStartLine: hasSelection ? editor.selection.start.line + 1 : undefined,
			selectionEndLine: hasSelection ? editor.selection.end.line + 1 : undefined,
		};
	}

	private getActiveAutoChip(): { readonly label: string; readonly relativePath: string; readonly hasSelection: boolean } | undefined {
		const snap = this.captureActiveFileSnapshot();
		if (!snap || this.autoContextDismissedForPath === snap.fsPath) {
			return undefined;
		}
		return buildAutoActiveFileChip(snap, this.attachments);
	}

	private syncAutoActiveFileState(): void {
		const chip = this.getActiveAutoChip();
		const key = chip ? `${chip.relativePath}::${chip.label}` : '';
		if (key !== this.lastAutoActiveChipKey) {
			this.lastAutoActiveChipKey = key;
			this.postState();
		}
	}

	private async attachActiveEditor(): Promise<void> {
		const editor = this.resolveActiveFileEditor();
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

	public cancelActiveRun(): void {
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

	private async handleSlashCommand(rawCmd: string): Promise<void> {
		const trimmed = rawCmd.trim();
		const spaceIdx = trimmed.search(/\s/);
		const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
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
			case '/workflow-run':
				await vscode.commands.executeCommand('tarot.workflows.run');
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
			default: {
				if (!cmd.startsWith('/') || !vscode.workspace.isTrusted) {
					return;
				}
				const targetId = cmd.slice(1);
				const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				const skills = await this.skillsService.discover(root, vscode.workspace.isTrusted);
				const matchedSkill = skills.find(s => s.id.toLowerCase() === targetId || s.name.toLowerCase() === targetId);
				if (matchedSkill) {
					const promptToRun = args || `Aplique a skill "${matchedSkill.name}" (/${matchedSkill.id}).`;
					await this.runPrompt(promptToRun, {
						displayPrompt: args ? `/${matchedSkill.id} ${args}` : `/${matchedSkill.id}`,
						explicitSkillIds: [matchedSkill.id],
					});
					return;
				}
				const docs = await this.steeringService.discover(root);
				const matched = docs.find(d => (d.inclusion === 'manual' || d.inclusion === 'auto') && d.id.toLowerCase() === targetId);
				if (!matched) {
					return;
				}
				this.addAttachment({
					kind: 'steering',
					label: matched.fileName,
					path: matched.filePath,
					content: matched.body,
				});
				const promptToRun = args || `Siga as instruções de steering em ${matched.fileName}.`;
				await this.runPrompt(promptToRun, {
					displayPrompt: args ? `/${matched.id} ${args}` : `/${matched.id}`,
				});
				break;
			}
		}
	}

	private async selectAgentProfile(profileId: string): Promise<void> {
		const profile = this.agentProfiles.find(p => p.id === profileId);
		if (!profile) {
			return;
		}
		if (profile.id === 'quick-spec') {
			await vscode.commands.executeCommand('tarot.specs.quickSpec');
			return;
		}
		if (profile.id === 'bug-fix') {
			await vscode.commands.executeCommand('tarot.specs.create');
			return;
		}
		this.activeProfileId = profile.id;
		if (profile.id === 'default') {
			this.mode = 'vibe';
		} else if (profile.id === 'spec') {
			this.mode = 'spec';
		} else if (profile.id === 'plan') {
			this.mode = 'plan';
		} else {
			this.mode = 'vibe';
		}
		if (profile.model) {
			this.selectedModel = profile.model;
		}
		const session = this.sessionStore.getActiveSession(this.runtimeManager.getActiveAgentId(), this.mode, this.autonomy);
		session.mode = this.mode;
		if (profile.welcomeMessage && session.messages.length === 0) {
			session.messages.push({
				id: `welcome-${Date.now()}`,
				role: 'assistant',
				agentId: this.runtimeManager.getActiveAgentId(),
				mode: this.mode,
				content: profile.welcomeMessage,
				timestamp: new Date().toISOString(),
			});
		}
		this.postState();
	}

	private async openTranscriptLink(rawUrl: string): Promise<void> {
		if (/^https?:\/\//i.test(rawUrl)) {
			await vscode.env.openExternal(vscode.Uri.parse(rawUrl));
			return;
		}
		if (!/^file:\/\//i.test(rawUrl)) {
			return;
		}
		try {
			const parsed = vscode.Uri.parse(rawUrl);
			let selection: vscode.Range | undefined;
			const lineMatch = /^L(\d+)(?:-L?(\d+))?$/i.exec(parsed.fragment);
			if (lineMatch) {
				const startLine = Math.max(0, Number(lineMatch[1]) - 1);
				const endLine = lineMatch[2] ? Math.max(startLine, Number(lineMatch[2]) - 1) : startLine;
				selection = new vscode.Range(startLine, 0, endLine, 0);
			}
			const doc = await vscode.workspace.openTextDocument(parsed.with({ fragment: '' }));
			await vscode.window.showTextDocument(doc, { preview: false, selection });
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			vscode.window.showWarningMessage(vscode.l10n.t('Could not open link {0}: {1}', rawUrl, detail));
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
			const result = await this.checkpointService.restoreCheckpointFiles(cwd, gate.sessionId, gate.checkpointId, gate.files);
			if (result.skipped.length > 0) {
				vscode.window.showWarningMessage(vscode.l10n.t(
					'{0} file(s) could not be safely reverted (no backup available for a file that already existed before this turn): {1}',
					result.skipped.length, result.skipped.join(', '),
				));
			}
			await this.refreshChangedFiles();
		}
		gate.resolution = keep ? 'kept' : 'reverted';
		await this.sessionStore.saveSession(session);
		await this.reviewSessionService?.markResolvedExternally(gate.files);
		this.postState();
	}

	private async runPrompt(
		prompt: string,
		options?: {
			displayPrompt?: string;
			nextApprovalGate?: SpecApprovalGate;
			onCompleted?: () => Promise<TaskProgressCard | undefined>;
			onCheckpointCreated?: (checkpointId: string | undefined, sessionId: string) => Promise<void>;
			/** Runs the agent (and its checkpoint/fs_write review) here instead of the workspace root — a worktree, for task isolation. Spec/Steering resolution always stays rooted at the real workspace regardless. */
			execCwd?: string;
			/** Explicit skill IDs invoked via `/skill` to force full body injection. */
			explicitSkillIds?: readonly string[];
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

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const session = this.sessionStore.getActiveSession(agentId, this.mode, this.autonomy);
		const cwd = options?.execCwd ?? session.worktreePath ?? session.repoRoot ?? workspaceRoot;
		session.activeAgentId = agentId;
		session.mode = this.mode;
		session.autonomy = this.autonomy;

		const concurrency = checkSessionConcurrency(
			this.runningSessionId
				? [{ sessionId: this.runningSessionId, mode: this.mode, profileId: this.activeProfileId, cwd, isWorktree: Boolean(session.worktreePath) }]
				: [],
			{ sessionId: session.id, mode: this.mode, profileId: this.activeProfileId, cwd, isWorktree: Boolean(session.worktreePath) },
		);
		if (!concurrency.allowed) {
			this.postMessage({ type: 'streamError', content: concurrency.blockReason ?? vscode.l10n.t('The agent is currently busy.') });
			return false;
		}
		if (concurrency.sharedWorkspaceWarning) {
			void vscode.window.showWarningMessage(concurrency.sharedWorkspaceWarning);
		}

		// Auto-compaction near configured threshold (default 80%, MIGRATION_PLAN.md M3.8c)
		const autoThreshold = vscode.workspace.getConfiguration('tarot.compaction').get<number>('autoThreshold', 0.8);
		const preMeter = computeContextMeter(session.messages, this.attachments);
		if (preMeter.percent / 100 >= autoThreshold) {
			await this.compactActiveSession(false);
		}

		const workspaceHooks = vscode.workspace.isTrusted ? await this.hookEngine.discover(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, true) : [];
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
		const activeSnap = this.captureActiveFileSnapshot();
		if (activeSnap && this.autoContextDismissedForPath !== activeSnap.fsPath) {
			const autoAtt = buildAutoActiveFileAttachment(activeSnap, requestAttachments);
			if (autoAtt) {
				requestAttachments.unshift(autoAtt);
			}
		}
		this.attachments = [];
		this.autoContextDismissedForPath = undefined;

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

		const activeProfile = this.agentProfiles.find(p => p.id === this.activeProfileId);
		const { systemContext: steeringContext, appliedSteering } = await assembleTurnSystemContext(
			{
				steeringService: this.steeringService,
				powersService: this.powersService,
				skillsService: this.skillsService,
				mcpConfigService: this.mcpConfigService,
			},
			{
				workspaceRoot,
				prompt,
				activeProfile,
				activeFiles: this.collectActiveFilePaths(requestAttachments),
				attachments: requestAttachments,
				explicitSkillIds: options?.explicitSkillIds,
			},
		);
		// Same Workspace Trust gate as Steering above — a cloned repo's .tarot/specs/** must not
		// auto-inject content before the user has trusted the workspace.
		const specContext = vscode.workspace.isTrusted ? await this.resolveActiveSpecContext(workspaceRoot) : undefined;
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

			const fileWriteReview = !wasCancelled && !hadError && checkpointId
				? await this.reviewFileWritesForTurn(cwd, session.id, checkpointId)
				: undefined;
			const fileWriteGate = fileWriteReview?.gate;
			const inlineDiffs = fileWriteReview && fileWriteReview.diffEntries.length > 0 && checkpointId && this.reviewSessionService
				? await this.reviewSessionService.buildInlineDiffCards(cwd, checkpointId, fileWriteReview.diffEntries).catch(() => undefined)
				: undefined;

			if (accumulatedText.trim().length > 0 || usedTools.length > 0 || taskProgress || fileWriteGate || (inlineDiffs && inlineDiffs.length > 0)) {
				await this.sessionStore.appendMessage(session, {
					role: 'assistant',
					agentId,
					mode: this.mode,
					content: accumulatedText || this.summarizeToolsFallback(usedTools),
					thought: accumulatedThought || undefined,
					tools: usedTools.length > 0 ? usedTools : undefined,
					appliedSteering: appliedSteering.length > 0 ? appliedSteering : undefined,
					taskProgress,
					approvalGate: !wasCancelled && !hadError ? options?.nextApprovalGate : undefined,
					fileWriteGate,
					inlineDiffs: inlineDiffs && inlineDiffs.length > 0 ? inlineDiffs : undefined,
					elapsedMs,
					totalTokens,
					checkpointId,
				});
			}

			this.postMessage({ type: 'streamEnd' });

			// Start Cursor-style Diff Review session (M6.1) for all non-denied edits in this turn.
			// Auto-opens the Git-style `Before ↔ Agent Edit` diff editor with Accept/Reject controls
			// in both `supervised` and `acceptFileChanges` modes (only `approveForMe` stays silent).
			if (fileWriteReview && fileWriteReview.diffEntries.length > 0 && checkpointId) {
				const autoOpen = Boolean(fileWriteGate) || this.autonomy !== 'approveForMe';
				if (this.reviewSessionService) {
					try {
						await this.reviewSessionService.startReview(cwd, session.id, checkpointId, fileWriteReview.diffEntries, autoOpen);
					} catch (err) {
						const detail = err instanceof Error ? err.message : String(err);
						this.outputChannel.appendLine(`[Review] Failed to start diff review session: ${detail}`);
					}
				} else if (fileWriteGate && fileWriteGate.files.length > 0) {
					void this.openEditedFilesForReview(cwd, fileWriteGate.files.slice(0, 3));
				}
			}

			await this.refreshChangedFiles();
			if (this.changedFiles.length === 0 && fileWriteReview && fileWriteReview.changedFiles.length > 0) {
				this.changedFiles = fileWriteReview.changedFiles;
				this.postState();
			}

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

	/**
	 * Some CLIs close a turn with a `result.response`/equivalent that is genuinely empty even
	 * after real tool calls (confirmed with `agy`: 6 tool calls, no closing text) — the generic
	 * "no additional output" placeholder then reads as if nothing happened, when the collapsed
	 * "N tool calls" disclosure the user has to expand is the only trace of real work. Synthesize
	 * a one-line summary from the tool labels instead whenever there is at least one.
	 */
	private summarizeToolsFallback(usedTools: readonly string[]): string {
		if (usedTools.length === 0) {
			return vscode.l10n.t('(Run completed with no additional output.)');
		}
		const maxShown = 5;
		const shown = usedTools.slice(0, maxShown).join(', ');
		return usedTools.length > maxShown
			? vscode.l10n.t('Completed {0} action(s): {1}, and {2} more.', usedTools.length, shown, usedTools.length - maxShown)
			: vscode.l10n.t('Completed {0} action(s): {1}.', usedTools.length, shown);
	}

	private async refreshAvailableModels(): Promise<void> {
		this.availableModels = await this.runtimeManager.listModelsForAgent();
		if (
			this.selectedModel !== 'auto'
			&& this.availableModels.length > 0
			&& !this.availableModels.some(m => m.id === this.selectedModel)
		) {
			const staleModel = this.selectedModel;
			this.selectedModel = 'auto';
			await this.context.globalState.update(SELECTED_MODEL_STATE_KEY, 'auto');
			this.outputChannel.appendLine(
				`[AgentPanel] Saved model "${staleModel}" is no longer offered by ${this.runtimeManager.getActiveAgentId()}; falling back to Auto.`,
			);
		}
	}

	private async refreshDynamicCatalogs(): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			this.agentProfiles = [...BUILT_IN_AGENT_PROFILES];
			this.manualSteeringCommands = [];
			return;
		}
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.agentProfiles = await this.customAgentService.discover(root, vscode.workspace.isTrusted);

		const seen = new Set<string>();
		const list: Array<{ command: string; id: string; description: string }> = [];

		// Skills invoked via `/<id>` (M3.8b)
		const skills = await this.skillsService.discover(root, vscode.workspace.isTrusted);
		for (const skill of skills) {
			const key = skill.id.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			list.push({
				command: `/${skill.id}`,
				id: skill.id,
				description: skill.description ? `[skill] ${skill.description}` : `[skill] ${skill.name}`,
			});
		}

		// Manual and auto steering docs invoked via `/<id>` (M3.8b)
		const docs = await this.steeringService.discover(root);
		for (const doc of docs) {
			if (doc.inclusion !== 'manual' && doc.inclusion !== 'auto') {
				continue;
			}
			const key = doc.id.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			list.push({
				command: `/${doc.id}`,
				id: doc.id,
				description: doc.description || doc.fileName,
			});
		}
		this.manualSteeringCommands = list;
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
	private async openEditedFilesForReview(cwd: string, relativePaths: readonly string[]): Promise<void> {
		let isGitRepo = false;
		try {
			await fs.access(path.join(cwd, '.git'));
			isGitRepo = true;
		} catch {
			isGitRepo = false;
		}
		for (const rel of relativePaths) {
			try {
				const matched = this.changedFiles.find(f => f.relativePath === rel);
				if (isGitRepo && matched && matched.status === 'M') {
					await this.gitReviewService.openFileDiff(cwd, rel, 'M');
				} else {
					const absPath = path.join(cwd, rel);
					await fs.access(absPath);
					const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
					await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
				}
			} catch {
				// Best-effort: skip deleted or unreadable files
			}
		}
	}

	private async reviewFileWritesForTurn(
		cwd: string,
		sessionId: string,
		checkpointId: string,
	): Promise<{ gate?: FileWriteApprovalGate; changedFiles: ChangedFileInfo[]; diffEntries: CheckpointDiffEntry[] } | undefined> {
		const activeProfile = this.agentProfiles.find(p => p.id === this.activeProfileId);
		return reviewFileWritesForTurn(
			{ checkpointService: this.checkpointService, permissionsService: this.permissionsService, outputChannel: this.outputChannel },
			{ cwd, sessionId, checkpointId, profilePermissions: activeProfile?.permissions, autonomy: this.autonomy, headless: false },
		);
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

		const meter = computeContextMeter(activeSession.messages, this.attachments);
		this.postMessage({
			type: 'state',
			agents: this.runtimeManager.getStatuses(),
			activeAgentId,
			models: this.availableModels,
			selectedModel: this.selectedModel,
			selectedEffort: this.selectedEffort,
			mode: this.mode,
			activeProfileId: this.activeProfileId,
			agentProfiles: this.agentProfiles.map(p => ({ id: p.id, name: p.name, description: p.description, origin: p.origin })),
			autonomy: this.autonomy,
			permissionEnforcement: { kind: getEnforcementKind(activeAgentId), detail: describeAdvisoryTranslation(activeAgentId) },
			isFocusMode: this.isFocusMode,
			isRunning: Boolean(this.runningSessionId),
			activeSessionId: activeSession.id,
			sessions,
			attachments: this.attachments.map(a => ({ kind: a.kind, label: a.label })),
			autoActiveFile: this.getActiveAutoChip(),
			manualSteeringCommands: this.manualSteeringCommands,
			changedFiles: this.changedFiles,
			pendingReviewFiles: this.reviewSessionService?.getPendingFiles().map(f => f.relativePath) ?? [],
			messages: activeSession.messages,
			contextPercent: meter.percent,
			contextUsedTokens: meter.usedTokens,
			contextWindowTokens: meter.windowTokens,
			contextIsReal: meter.isRealTokens,
		});
		this.stateChangeListener?.();
	}

	private postMessage(payload: Record<string, unknown>): void {
		if (this.view) {
			void this.view.webview.postMessage(payload);
		}
		if (this.editorPanel) {
			void this.editorPanel.webview.postMessage(payload);
		}
		const msgType = typeof payload.type === 'string' ? payload.type : '';
		if (this.streamEventListener && msgType.startsWith('stream')) {
			this.streamEventListener(payload);
		}
	}

	private buildHtml(webview: vscode.Webview): string {
		return buildAgentPanelHtml(webview, this.extensionUri);
	}

	dispose(): void {
		this.cancelActiveRun();
		this.editorPanel?.dispose();
		this.editorPanel = undefined;
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
