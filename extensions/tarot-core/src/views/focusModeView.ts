/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { TarotSessionStore } from '../agents/sessionStore';
import { AgentId, AgentMode, AutonomyMode } from '../agents/types';
import { TarotGitReviewService } from '../git/gitReviewService';
import { TarotWorktreeManager } from '../git/worktreeManager';
import { TarotSpecService } from '../specs/specService';
import { TarotWorkflowRunStore } from '../workflows/runStore';
import { SessionsTreeProvider } from './sessionsView';

export interface FocusModeActions {
	readonly sendPrompt: (prompt: string) => Promise<void>;
	readonly cancelRun: () => void;
	readonly newSession: (mode?: AgentMode) => void;
	readonly selectSession: (sessionId: string) => Promise<void>;
	readonly selectAgent: (agentId: AgentId) => Promise<void>;
	readonly setMode: (mode: AgentMode) => Promise<void>;
	readonly setAutonomy: (autonomy: AutonomyMode) => void;
	readonly pickContext: () => Promise<void>;
	readonly openFileDiff: (relativePath: string) => Promise<void>;
	readonly getRunningSessionId: () => string | undefined;
	readonly getActiveMode: () => AgentMode;
	readonly getActiveAutonomy: () => AutonomyMode;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * 3-Pane Desktop **Tarot Agent Mode / Agent Focus Mode** (`MIGRATION_PLAN.md` M3.9c):
 * - Left pane: collapsible Sessions list (search, filters, `+ New`, multi-repo cards,
 *   `Needs input` / `🔒 N sub-agent needs approval` badges, `Older Sessions`, footer shortcuts)
 * - Center pane: header + transcript (disclosures + follow-up chips) + composer with
 *   Repository selector, Branch/Worktree selector (`worktreeManager`), Local Agent selector,
 *   Permission mode selector, and `(/command · @file · $skill)` triggers
 * - Right pane: collapsible Inspector (Specs, Changed Files, Recent Workflow Runs)
 *
 * 100% Extension-First — replaces VS Code's native Agents Window (`src/vs/sessions/`).
 */
export class TarotFocusModeManager implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly sessionStore: TarotSessionStore,
		private readonly runtimeManager: AgentRuntimeManager,
		private readonly sessionsProvider: SessionsTreeProvider,
		private readonly worktreeManager: TarotWorktreeManager,
		private readonly specService: TarotSpecService,
		private readonly gitReviewService: TarotGitReviewService,
		private readonly workflowRunStore: TarotWorkflowRunStore,
		private readonly actions: FocusModeActions,
	) { }

	isOpen(): boolean {
		return this.panel !== undefined;
	}

	async toggle(): Promise<boolean> {
		if (this.panel) {
			this.panel.dispose();
			this.panel = undefined;
			await vscode.commands.executeCommand('workbench.action.openAuxiliaryBar');
			return false;
		}
		await this.open();
		await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
		return true;
	}

	async open(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active);
			await this.postState();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'tarot.agentFocusMode',
			vscode.l10n.t('Tarot Agent Mode'),
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
		this.panel = panel;

		const msgSub = panel.webview.onDidReceiveMessage((msg: unknown) => {
			if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
				return;
			}
			void this.handleMessage(msg as Record<string, unknown>);
		});
		const disposeSub = panel.onDidDispose(() => {
			msgSub.dispose();
			disposeSub.dispose();
			this.panel = undefined;
		});

		await this.postState();
	}

	async postState(): Promise<void> {
		if (!this.panel) {
			return;
		}
		const folders = vscode.workspace.workspaceFolders ?? [];
		const defaultRoot = folders[0]?.uri.fsPath;
		const activeAgentId = this.runtimeManager.getActiveAgentId();
		const session = this.sessionStore.getActiveSession(
			activeAgentId,
			this.actions.getActiveMode(),
			this.actions.getActiveAutonomy(),
		);
		const selectedRepoRoot = session.repoRoot ?? defaultRoot;
		const { active, older } = await this.sessionsProvider.buildSessionCards();

		const worktrees = selectedRepoRoot && vscode.workspace.isTrusted
			? await this.worktreeManager.listWorktrees(selectedRepoRoot).catch(() => [])
			: [];
		const specs = selectedRepoRoot && vscode.workspace.isTrusted
			? await this.specService.listSpecs(selectedRepoRoot).catch(() => [])
			: [];
		const changedFiles = selectedRepoRoot
			? await this.gitReviewService.getChangedFiles(selectedRepoRoot).catch(() => [])
			: [];
		const workflowRuns = selectedRepoRoot && vscode.workspace.isTrusted
			? (await this.workflowRunStore.listRuns(selectedRepoRoot).catch(() => [])).slice(0, 8)
			: [];

		void this.panel.webview.postMessage({
			type: 'state',
			activeSessionId: session.id,
			activeSession: {
				id: session.id,
				title: session.title,
				mode: session.mode,
				autonomy: session.autonomy,
				activeAgentId: session.activeAgentId,
				repoRoot: selectedRepoRoot,
				worktreePath: session.worktreePath,
				worktreeBranch: session.worktreeBranch,
				messages: session.messages,
			},
			isRunning: this.actions.getRunningSessionId() !== undefined,
			runningSessionId: this.actions.getRunningSessionId(),
			sessions: active,
			olderSessions: older,
			repos: folders.map(f => ({ name: path.basename(f.uri.fsPath), path: f.uri.fsPath })),
			worktrees: worktrees.map(w => ({ id: w.id, branch: w.branch, path: w.path })),
			agents: this.runtimeManager.getStatuses().map(a => ({
				id: a.id,
				displayName: a.displayName,
				available: a.available,
				version: a.version,
			})),
			activeAgentId,
			specs: specs.map(s => ({ slug: s.slug, kind: s.kind, dirPath: s.dirPath, done: s.taskSummary.done, total: s.taskSummary.total })),
			changedFiles: changedFiles.map(f => ({ relativePath: f.relativePath, status: f.status })),
			workflowRuns: workflowRuns.map(r => ({ id: r.id, recipeName: r.recipeName, status: r.status, pauseReason: r.pauseReason })),
		});
	}

	private async handleMessage(msg: Record<string, unknown>): Promise<void> {
		const session = this.sessionStore.getActiveSession(
			this.runtimeManager.getActiveAgentId(),
			this.actions.getActiveMode(),
			this.actions.getActiveAutonomy(),
		);

		switch (msg.type) {
			case 'ready':
			case 'refresh':
				await this.postState();
				break;
			case 'exitFocusMode':
				await this.toggle();
				break;
			case 'newSession':
				this.actions.newSession(typeof msg.mode === 'string' ? msg.mode as AgentMode : undefined);
				this.sessionsProvider.refresh();
				await this.postState();
				break;
			case 'selectSession':
				if (typeof msg.sessionId === 'string') {
					await this.actions.selectSession(msg.sessionId);
					await this.postState();
				}
				break;
			case 'send':
				if (typeof msg.prompt === 'string' && msg.prompt.trim()) {
					await this.actions.sendPrompt(msg.prompt.trim());
					this.sessionsProvider.refresh();
					await this.postState();
				}
				break;
			case 'cancel':
				this.actions.cancelRun();
				await this.postState();
				break;
			case 'selectAgent':
				if (typeof msg.agentId === 'string') {
					await this.actions.selectAgent(msg.agentId as AgentId);
					await this.postState();
				}
				break;
			case 'setMode':
				if (typeof msg.mode === 'string') {
					await this.actions.setMode(msg.mode as AgentMode);
					await this.postState();
				}
				break;
			case 'setAutonomy':
				if (typeof msg.autonomy === 'string') {
					this.actions.setAutonomy(msg.autonomy as AutonomyMode);
					await this.postState();
				}
				break;
			case 'selectRepo':
				if (typeof msg.repoRoot === 'string') {
					session.repoRoot = msg.repoRoot;
					session.worktreePath = undefined;
					session.worktreeBranch = undefined;
					await this.sessionStore.saveSession(session);
					this.sessionsProvider.refresh();
					await this.postState();
				}
				break;
			case 'selectWorktree': {
				const value = typeof msg.worktreePath === 'string' ? msg.worktreePath : '';
				if (value === '__create__') {
					const repoRoot = session.repoRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (!repoRoot) {
						return;
					}
					const wt = await this.worktreeManager.createWorktree(repoRoot, `session-${session.id.slice(-6)}`);
					if (wt) {
						session.worktreePath = wt.path;
						session.worktreeBranch = wt.branch;
						await this.sessionStore.saveSession(session);
						vscode.window.showInformationMessage(vscode.l10n.t('Created isolated worktree on branch {0}.', wt.branch));
					} else {
						vscode.window.showWarningMessage(vscode.l10n.t('Could not create Git worktree (ensure this folder is a Git repository with at least one commit).'));
					}
				} else if (!value) {
					session.worktreePath = undefined;
					session.worktreeBranch = undefined;
					await this.sessionStore.saveSession(session);
				} else {
					session.worktreePath = value;
					session.worktreeBranch = typeof msg.branch === 'string' ? msg.branch : path.basename(value);
					await this.sessionStore.saveSession(session);
				}
				this.sessionsProvider.refresh();
				await this.postState();
				break;
			}
			case 'pickContext':
				await this.actions.pickContext();
				break;
			case 'openDiff':
				if (typeof msg.relativePath === 'string') {
					await this.actions.openFileDiff(msg.relativePath);
				}
				break;
			case 'openSpec':
				if (typeof msg.dirPath === 'string') {
					const tasksPath = path.join(msg.dirPath, 'tasks.md');
					await vscode.commands.executeCommand('tarot.specs.openPhase', tasksPath);
				}
				break;
			case 'openWorkflowRun':
				if (typeof msg.runId === 'string') {
					await vscode.commands.executeCommand('tarot.workflows.openRun', msg.runId);
				}
				break;
			case 'openSchedule':
				await vscode.commands.executeCommand('tarot.schedule.open');
				break;
			case 'openAgentConfig':
				await vscode.commands.executeCommand('tarot.agentConfig.open');
				break;
			case 'openSettings':
				await vscode.commands.executeCommand('tarot.settings.open');
				break;
		}
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'focusMode.css'));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'focusMode.js'));

		const rawL10n = {
			sessionsTitle: vscode.l10n.t('Sessions'),
			newSession: vscode.l10n.t('+ New'),
			searchPlaceholder: vscode.l10n.t('Search sessions...'),
			filterAll: vscode.l10n.t('All'),
			filterNeedsInput: vscode.l10n.t('Needs input'),
			filterActive: vscode.l10n.t('Active'),
			filterSpec: vscode.l10n.t('Spec'),
			olderSessions: vscode.l10n.t('Older Sessions'),
			schedule: vscode.l10n.t('Schedule'),
			agentConfig: vscode.l10n.t('Agent Config'),
			settings: vscode.l10n.t('Settings'),
			editorView: vscode.l10n.t('Editor View'),
			toggleInspector: vscode.l10n.t('Toggle Inspector'),
			refresh: vscode.l10n.t('Refresh'),
			inspectorTitle: vscode.l10n.t('Workspace Context'),
			specsHeader: vscode.l10n.t('Specs'),
			changedFilesHeader: vscode.l10n.t('Changed Files'),
			workflowRunsHeader: vscode.l10n.t('Workflow Runs'),
			composerPlaceholder: vscode.l10n.t('Ask or delegate a task... (/command · @file · $skill)'),
			currentBranch: vscode.l10n.t('Current branch'),
			createWorktree: vscode.l10n.t('+ New isolated worktree'),
			send: vscode.l10n.t('Send'),
			stop: vscode.l10n.t('Stop'),
			stepsLabel: vscode.l10n.t('{0} step(s)'),
			thoughtLabel: vscode.l10n.t('Thought complete'),
			parkedLabel: vscode.l10n.t('🔒 {0} sub-agent needs approval'),
			needsInputBadge: vscode.l10n.t('Needs input'),
			runningBadge: vscode.l10n.t('Running'),
			emptySessions: vscode.l10n.t('No sessions match the current filter.'),
			emptyTranscript: vscode.l10n.t('Start a session or pick one from the left panel.'),
			followUpReview: vscode.l10n.t('Review git diff'),
			followUpTests: vscode.l10n.t('Run unit tests'),
			followUpSpec: vscode.l10n.t('Generate spec'),
		};
		const s = Object.fromEntries(
			Object.entries(rawL10n).map(([k, v]) => [k, escapeHtml(v)]),
		) as unknown as typeof rawL10n;
		const l10nPayload = JSON.stringify(rawL10n).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${cssUri}" />
	<title>${escapeHtml(vscode.l10n.t('Tarot Agent Mode'))}</title>
</head>
<body>
	<div id="focus-shell" class="focus-shell">
		<aside id="pane-sessions" class="pane-sessions">
			<div class="pane-header">
				<span class="pane-title">${s.sessionsTitle}</span>
				<div class="pane-header-actions">
					<button id="btn-new-session" class="primary-pill-btn" type="button">${s.newSession}</button>
					<button id="btn-collapse-left" class="icon-btn" type="button" title="Collapse">‹</button>
				</div>
			</div>
			<div class="sessions-controls">
				<input id="session-search" class="search-input" type="search" placeholder="${s.searchPlaceholder}" />
				<div id="session-filters" class="filter-row">
					<button class="filter-pill active" type="button" data-filter="all">${s.filterAll}</button>
					<button class="filter-pill" type="button" data-filter="needsInput">${s.filterNeedsInput}</button>
					<button class="filter-pill" type="button" data-filter="active">${s.filterActive}</button>
					<button class="filter-pill" type="button" data-filter="spec">${s.filterSpec}</button>
				</div>
			</div>
			<div id="session-list" class="session-list"></div>
			<footer class="sessions-footer">
				<button id="btn-shortcut-schedule" class="footer-shortcut-btn" type="button">${s.schedule}</button>
				<button id="btn-shortcut-config" class="footer-shortcut-btn" type="button">${s.agentConfig}</button>
				<button id="btn-shortcut-settings" class="footer-shortcut-btn" type="button">${s.settings}</button>
			</footer>
		</aside>

		<section class="pane-center">
			<header class="center-header">
				<div class="center-header-left">
					<button id="btn-expand-left" class="icon-btn hidden" type="button" title="Expand Sessions">›</button>
					<h2 id="active-session-title" class="session-heading">Tarot Agent</h2>
				</div>
				<div class="center-header-actions">
					<button id="btn-refresh" class="subtle-btn" type="button">${s.refresh}</button>
					<button id="btn-toggle-right" class="subtle-btn" type="button">${s.toggleInspector}</button>
					<button id="btn-exit-focus" class="accent-btn" type="button">${s.editorView}</button>
				</div>
			</header>

			<main id="transcript" class="transcript" aria-live="polite"></main>

			<div id="followup-chips" class="followup-chips">
				<button class="chip-btn" type="button" data-followup="Review git diff">${s.followUpReview}</button>
				<button class="chip-btn" type="button" data-followup="Run unit tests">${s.followUpTests}</button>
				<button class="chip-btn" type="button" data-followup="Generate a spec from this conversation">${s.followUpSpec}</button>
			</div>

			<div class="composer-area">
				<div class="composer-box">
					<textarea id="focus-prompt" rows="2" placeholder="${s.composerPlaceholder}"></textarea>
					<div class="composer-toolbar">
						<div class="toolbar-left">
							<button id="btn-context" class="subtle-btn" type="button">#</button>
							<select id="select-repo" class="toolbar-select" aria-label="Repository"></select>
							<select id="select-worktree" class="toolbar-select" aria-label="Branch or Worktree"></select>
							<select id="select-agent" class="toolbar-select" aria-label="Local Agent"></select>
							<select id="select-mode" class="toolbar-select" aria-label="Mode">
								<option value="vibe">Default</option>
								<option value="spec">Spec</option>
								<option value="plan">Plan</option>
							</select>
							<select id="select-autonomy" class="toolbar-select" aria-label="Permissions">
								<option value="supervised">Supervised</option>
								<option value="acceptFileChanges">Accept File Changes</option>
								<option value="approveForMe">Approve For Me</option>
							</select>
						</div>
						<button id="btn-send" class="primary-pill-btn" type="button">${s.send}</button>
					</div>
				</div>
			</div>
		</section>

		<aside id="pane-inspector" class="pane-inspector">
			<div class="pane-header">
				<span class="pane-title">${s.inspectorTitle}</span>
			</div>
			<div class="inspector-scroll">
				<section class="inspector-section">
					<div class="inspector-heading">${s.specsHeader}</div>
					<div id="inspector-specs" class="inspector-list"></div>
				</section>
				<section class="inspector-section">
					<div class="inspector-heading">${s.changedFilesHeader}</div>
					<div id="inspector-files" class="inspector-list"></div>
				</section>
				<section class="inspector-section">
					<div class="inspector-heading">${s.workflowRunsHeader}</div>
					<div id="inspector-runs" class="inspector-list"></div>
				</section>
			</div>
		</aside>
	</div>
	<script nonce="${nonce}">window.__tarotFocusL10n = ${l10nPayload};</script>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
