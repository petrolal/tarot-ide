/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from './agents/runtimeManager';
import { TarotSessionStore } from './agents/sessionStore';
import { AgentId } from './agents/types';
import { TarotCheckpointService } from './checkpoints/checkpointService';
import { TAROT_GIT_HEAD_SCHEME, TarotGitHeadContentProvider, TarotGitReviewService } from './git/gitReviewService';
import { TarotWorktreeManager } from './git/worktreeManager';
import { KeyedHookQueue, runHooksForTrigger, TarotHookEngine } from './hooks/hookEngine';
import { TarotPermissionsService } from './permissions/permissionsService';
import { TarotTrustService } from './permissions/trustService';
import { formatMarkdownReviewBatch, MarkdownReviewComment } from './specs/markdownReview';
import { SpecCreationKind, TarotSpecService } from './specs/specService';
import { readTaskCheckpoint } from './specs/specTaskCheckpoints';
import { SpecTaskCodeLensProvider } from './specs/taskCodeLensProvider';
import { SteeringInclusion, TarotSteeringService } from './steering/steeringService';
import { TarotAgentPanelProvider } from './views/agentPanelView';
import { HooksTreeProvider, LocalAgentsTreeProvider, SpecsTreeProvider, SteeringTreeProvider } from './views/tarotSidebarViews';

let outputChannel: vscode.OutputChannel | undefined;

async function ensureWorkspaceFolder(): Promise<string | undefined> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		vscode.window.showWarningMessage(vscode.l10n.t('Open a folder/workspace in Tarot IDE to create artifacts under .tarot/.'));
	}
	return root;
}

async function resolveSpecDirFromUriOrPick(uri: vscode.Uri | undefined, specService: TarotSpecService): Promise<string | undefined> {
	if (uri) {
		return path.dirname(uri.fsPath);
	}
	const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
	if (activePath && activePath.replace(/\\/g, '/').includes('/.tarot/specs/')) {
		return path.dirname(activePath);
	}
	const root = await ensureWorkspaceFolder();
	if (!root) {
		return undefined;
	}
	const specs = await specService.listSpecs(root);
	if (specs.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('No Specs found in .tarot/specs/.'));
		return undefined;
	}
	const picked = await vscode.window.showQuickPick(
		specs.map(s => ({ label: s.slug, description: s.kind, specDir: s.dirPath })),
		{ title: vscode.l10n.t('Pick Spec') },
	);
	return picked?.specDir;
}

class TarotEmptyContentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(): string {
		return '';
	}
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel('Tarot IDE');
	outputChannel.appendLine('Tarot Core extension activated.');

	const runtimeManager = new AgentRuntimeManager(context, outputChannel);
	const sessionStore = new TarotSessionStore();
	const checkpointService = new TarotCheckpointService();
	const steeringService = new TarotSteeringService();
	const specService = new TarotSpecService();
	const gitReviewService = new TarotGitReviewService();
	const worktreeManager = new TarotWorktreeManager();
	const hookEngine = new TarotHookEngine((filePath, errors) => {
		for (const err of errors) {
			outputChannel!.appendLine(`[Hooks] ${filePath}: ${err}`);
		}
		const openLabel = vscode.l10n.t('Open File');
		void vscode.window.showWarningMessage(
			vscode.l10n.t('{0} error(s) loading hooks from {1} — see the Tarot IDE output channel for details.', errors.length, path.basename(filePath)),
			openLabel,
		).then(choice => {
			if (choice === openLabel) {
				void vscode.workspace.openTextDocument(filePath).then(doc => vscode.window.showTextDocument(doc));
			}
		});
	});
	const fileHookQueue = new KeyedHookQueue(250);
	const trustService = new TarotTrustService();
	const permissionsService = new TarotPermissionsService(trustService, outputChannel!);
	const specCodeLensProvider = new SpecTaskCodeLensProvider();
	const pendingReviewComments: MarkdownReviewComment[] = [];

	// Left Sidebar (Kiro-style) TreeViews
	const specsProvider = new SpecsTreeProvider(specService, context.extensionUri);
	const hooksProvider = new HooksTreeProvider(hookEngine, context.extensionUri);
	const steeringProvider = new SteeringTreeProvider(steeringService, context.extensionUri);
	const agentsProvider = new LocalAgentsTreeProvider(runtimeManager, context.extensionUri);

	// Right Secondary Side Bar (Kiro-style) Agent Panel
	const agentPanelProvider = new TarotAgentPanelProvider(
		context,
		context.extensionUri,
		runtimeManager,
		sessionStore,
		checkpointService,
		steeringService,
		specService,
		gitReviewService,
		hookEngine,
		permissionsService,
		worktreeManager,
		outputChannel,
	);

	context.subscriptions.push(
		outputChannel,
		runtimeManager,
		trustService,
		permissionsService,
		specsProvider,
		hooksProvider,
		steeringProvider,
		agentsProvider,
		agentPanelProvider,
		specCodeLensProvider,
		vscode.workspace.registerTextDocumentContentProvider(TAROT_GIT_HEAD_SCHEME, new TarotGitHeadContentProvider()),
		vscode.workspace.registerTextDocumentContentProvider('tarot-empty', new TarotEmptyContentProvider()),
		vscode.languages.registerCodeLensProvider(
			{ language: 'markdown', pattern: '**/.tarot/specs/*/tasks.md' },
			specCodeLensProvider,
		),
		vscode.window.registerTreeDataProvider('tarot.views.specs', specsProvider),
		vscode.window.registerTreeDataProvider('tarot.views.hooks', hooksProvider),
		vscode.window.registerTreeDataProvider('tarot.views.steering', steeringProvider),
		vscode.window.registerTreeDataProvider('tarot.views.agents', agentsProvider),
		vscode.window.registerWebviewViewProvider(TarotAgentPanelProvider.viewId, agentPanelProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),

		vscode.commands.registerCommand('tarot.welcome', () => {
			const available = runtimeManager.getStatuses().filter(s => s.available).map(s => s.id);
			const agentsText = available.length > 0
				? vscode.l10n.t('Agents detected: {0}.', available.join(', '))
				: vscode.l10n.t('No agent CLI detected on PATH.');
			vscode.window.showInformationMessage(vscode.l10n.t('Welcome to Tarot IDE! {0}', agentsText));
		}),

		vscode.commands.registerCommand('tarot.agents.refresh', async () => {
			await runtimeManager.refresh();
		}),

		vscode.commands.registerCommand('tarot.agents.select', async () => {
			await runtimeManager.showAgentQuickPick();
		}),

		vscode.commands.registerCommand('tarot.agents.selectById', async (agentId?: AgentId) => {
			if (!agentId) {
				await runtimeManager.showAgentQuickPick();
				return;
			}
			const status = runtimeManager.getStatuses().find(s => s.id === agentId);
			if (status && !status.available) {
				vscode.window.showWarningMessage(vscode.l10n.t('{0} is not installed. {1}', status.displayName, status.installHint ?? ''));
				return;
			}
			await runtimeManager.setActiveAgent(agentId);
		}),

		vscode.commands.registerCommand('tarot.agentPanel.open', async () => {
			await vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		}),

		vscode.commands.registerCommand('tarot.agent.sendSelection', async () => {
			await agentPanelProvider.attachSelectionAndFocus();
		}),

		vscode.commands.registerCommand('tarot.agent.openInEditorTab', async () => {
			await agentPanelProvider.openInEditorTab();
		}),

		vscode.commands.registerCommand('tarot.agent.toggleFocusMode', async () => {
			await agentPanelProvider.toggleAgentFocusMode();
		}),

		vscode.commands.registerCommand('tarot.git.generateCommitMessage', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			await gitReviewService.generateAiCommitMessage(root, runtimeManager, outputChannel!);
		}),

		vscode.commands.registerCommand('tarot.specs.create', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const kindPick = await vscode.window.showQuickPick(
				[
					{
						label: vscode.l10n.t('Feature (Requirements-First · EARS)'),
						description: vscode.l10n.t('requirements.md → design.md → tasks.md'),
						detail: vscode.l10n.t('Default Tarot workflow: start by defining requirements in EARS notation (WHEN ... THE SYSTEM SHALL ...).'),
						specKind: 'feature-requirements-first' as SpecCreationKind,
					},
					{
						label: vscode.l10n.t('Feature (Design-First · Architecture)'),
						description: vscode.l10n.t('design.md → requirements.md → tasks.md'),
						detail: vscode.l10n.t('Best when the technical architecture and interfaces are defined first.'),
						specKind: 'feature-design-first' as SpecCreationKind,
					},
					{
						label: vscode.l10n.t('Bugfix (EARS · Regression)'),
						description: vscode.l10n.t('bugfix.md → design.md → tasks.md'),
						detail: vscode.l10n.t('Three mandatory EARS blocks: Current Behavior, Expected Behavior and Unchanged Behavior.'),
						specKind: 'bugfix' as SpecCreationKind,
					},
				],
				{ title: vscode.l10n.t('Tarot IDE — Spec Type') },
			);
			if (!kindPick) {
				return;
			}

			const rawName = await vscode.window.showInputBox({
				title: vscode.l10n.t('Tarot IDE — New Spec'),
				prompt: kindPick.specKind === 'bugfix'
					? vscode.l10n.t('Bugfix slug (e.g. fix-oauth-refresh-race)')
					: vscode.l10n.t('Feature slug (e.g. auth-oauth, agent-hooks)'),
				placeHolder: kindPick.specKind === 'bugfix' ? 'fix-my-bug' : 'my-feature',
			});
			if (!rawName) {
				return;
			}
			const slug = rawName.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
			if (!slug) {
				return;
			}

			const { dirPath, entryFilePath } = await specService.createSpec(root, slug, kindPick.specKind);
			specsProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(entryFilePath);
			await vscode.window.showTextDocument(doc);
			await agentPanelProvider.introduceSpecInPanel(dirPath, slug, kindPick.specKind);
		}),

		vscode.commands.registerCommand('tarot.specs.runTask', async (uri?: vscode.Uri, lineIndex?: number) => {
			if (!uri || typeof lineIndex !== 'number') {
				return;
			}
			const specDir = path.dirname(uri.fsPath);
			await agentPanelProvider.runSpecTask(specDir, lineIndex);
			specsProvider.refresh();
			specCodeLensProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.specs.runTaskWith', async (uri?: vscode.Uri, lineIndex?: number) => {
			if (!uri || typeof lineIndex !== 'number') {
				return;
			}
			const available = runtimeManager.getStatuses().filter(s => s.available);
			if (available.length === 0) {
				vscode.window.showWarningMessage(vscode.l10n.t('No local agent CLI available (claude, agy, codex).'));
				return;
			}
			const picked = await vscode.window.showQuickPick(
				available.map(s => ({
					label: s.displayName,
					description: s.version ?? s.binary,
					agentId: s.id,
				})),
				{ title: vscode.l10n.t('Tarot IDE — Pick Agent to Run Task') },
			);
			if (!picked) {
				return;
			}
			const specDir = path.dirname(uri.fsPath);
			await agentPanelProvider.runSpecTask(specDir, lineIndex, picked.agentId);
			specsProvider.refresh();
			specCodeLensProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.specs.runAllTasks', async (uri?: vscode.Uri) => {
			const specDir = await resolveSpecDirFromUriOrPick(uri, specService);
			if (!specDir) {
				return;
			}
			const picked = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('Keep optional tasks skipped (fast MVP)'), includeOptional: false },
					{ label: vscode.l10n.t('Make every task mandatory'), includeOptional: true },
				],
				{ title: vscode.l10n.t('Run all Tasks — Optional Tasks (*)') },
			);
			if (!picked) {
				return;
			}
			await agentPanelProvider.runAllSpecTasks(specDir, picked.includeOptional);
			specsProvider.refresh();
			specCodeLensProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.specs.syncFiles', async (uri?: vscode.Uri) => {
			const specDir = await resolveSpecDirFromUriOrPick(uri, specService);
			if (!specDir) {
				return;
			}
			await agentPanelProvider.runSyncFiles(specDir);
			specsProvider.refresh();
			specCodeLensProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.specs.viewTaskChanges', async (uri?: vscode.Uri, _lineIndex?: number, taskKey?: string, legacyTaskKey?: string) => {
			if (!uri || !taskKey) {
				return;
			}
			const specDir = path.dirname(uri.fsPath);
			const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!cwd) {
				return;
			}
			const record = await readTaskCheckpoint(specDir, taskKey, legacyTaskKey);
			if (!record) {
				vscode.window.showInformationMessage(vscode.l10n.t('No recorded checkpoint for this task yet (it may predate M3.6.7).'));
				return;
			}
			const diffEntries = await checkpointService.getCheckpointDiff(cwd, record.sessionId, record.checkpointId);
			if (diffEntries.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No file changes detected for this task.'));
				return;
			}

			const picked = diffEntries.length === 1
				? diffEntries[0]
				: (await vscode.window.showQuickPick(
					diffEntries.map(e => ({ label: e.relativePath, description: e.status, entry: e })),
					{ title: vscode.l10n.t('View changes — Task #{0}', taskKey) },
				))?.entry;
			if (!picked) {
				return;
			}

			const leftUri = picked.backupAbsPath ? vscode.Uri.file(picked.backupAbsPath) : vscode.Uri.parse('tarot-empty:/before');
			const rightUri = picked.status === 'deleted' ? vscode.Uri.parse('tarot-empty:/after') : vscode.Uri.file(path.join(cwd, picked.relativePath));
			await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, vscode.l10n.t('Task #{0}: {1} ({2})', taskKey, picked.relativePath, picked.status));
		}),

		vscode.commands.registerCommand('tarot.specs.openPhase', async (filePath?: string) => {
			if (!filePath) {
				return;
			}
			try {
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
				await vscode.window.showTextDocument(doc, { preview: false });
			} catch {
				vscode.window.showWarningMessage(vscode.l10n.t('Spec phase file does not exist yet: {0}', path.basename(filePath)));
			}
		}),

		vscode.commands.registerCommand('tarot.specs.analyzeRequirements', async (specDirArg?: string) => {
			let specDir = specDirArg;
			if (!specDir) {
				const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
				if (activePath && activePath.replace(/\\/g, '/').includes('/.tarot/specs/')) {
					specDir = path.dirname(activePath);
				} else {
					const root = await ensureWorkspaceFolder();
					if (!root) {
						return;
					}
					const specs = await specService.listSpecs(root);
					if (specs.length === 0) {
						vscode.window.showInformationMessage(vscode.l10n.t('No Specs found in .tarot/specs/.'));
						return;
					}
					const picked = await vscode.window.showQuickPick(
						specs.map(s => ({ label: s.slug, description: s.kind, specDir: s.dirPath })),
						{ title: vscode.l10n.t('Analyze Requirements — Pick Spec') },
					);
					specDir = picked?.specDir;
				}
			}
			if (specDir) {
				await agentPanelProvider.runAnalyzeRequirements(specDir);
			}
		}),

		vscode.commands.registerCommand('tarot.specs.quickSpec', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const description = await vscode.window.showInputBox({
				title: vscode.l10n.t('Tarot IDE — Quick Spec'),
				prompt: vscode.l10n.t('Describe what you want to build (generates requirements, design & tasks without approval gates)'),
				placeHolder: vscode.l10n.t('e.g. Add rate limiting middleware with Redis backing'),
			});
			if (!description?.trim()) {
				return;
			}
			const suggestedSlug = description.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'quick-spec';
			const rawSlug = await vscode.window.showInputBox({
				title: vscode.l10n.t('Quick Spec — Slug'),
				prompt: vscode.l10n.t('Folder name under .tarot/specs/'),
				value: suggestedSlug,
			});
			if (!rawSlug?.trim()) {
				return;
			}
			const slug = rawSlug.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
			if (!slug) {
				return;
			}
			const { dirPath, entryFilePath } = await specService.createSpec(root, slug, 'quick-spec');
			specsProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(entryFilePath);
			await vscode.window.showTextDocument(doc, { preview: false });
			await agentPanelProvider.runQuickSpec(dirPath, description.trim());
		}),

		vscode.commands.registerCommand('tarot.specs.generateFromSession', async () => {
			await agentPanelProvider.generateSpecFromActiveSession();
			specsProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.specs.markdownReview.add', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage(vscode.l10n.t('Open a Spec Markdown file (requirements.md, bugfix.md, or design.md) to add a review comment.'));
				return;
			}
			const filePath = editor.document.uri.fsPath;
			const fileName = path.basename(filePath);
			const selection = editor.selection;
			const startLine = selection.start.line + 1;
			const endLine = selection.end.line + 1;
			const excerpt = selection.isEmpty
				? editor.document.lineAt(selection.start.line).text.trim()
				: editor.document.getText(selection).trim();

			const comment = await vscode.window.showInputBox({
				title: vscode.l10n.t('Markdown Review — {0}:L{1}', fileName, startLine),
				prompt: vscode.l10n.t('Enter your review comment for this excerpt ({0} queued)', pendingReviewComments.length),
				placeHolder: vscode.l10n.t('e.g. Clarify timeout behavior on retry'),
			});
			if (!comment?.trim()) {
				return;
			}

			pendingReviewComments.push({
				filePath,
				fileName,
				startLine,
				endLine,
				excerpt: excerpt || `(line ${startLine})`,
				comment: comment.trim(),
			});

			const action = await vscode.window.showInformationMessage(
				vscode.l10n.t('Review comment added ({0} queued for {1}).', pendingReviewComments.length, fileName),
				vscode.l10n.t('Send All to Agent'),
				vscode.l10n.t('Add More Later'),
			);
			if (action === vscode.l10n.t('Send All to Agent')) {
				await vscode.commands.executeCommand('tarot.specs.markdownReview.send');
			}
		}),

		vscode.commands.registerCommand('tarot.specs.markdownReview.send', async () => {
			if (pendingReviewComments.length === 0) {
				vscode.window.showInformationMessage(vscode.l10n.t('No queued Markdown review comments to send.'));
				return;
			}
			const fileName = pendingReviewComments[0].fileName;
			const count = pendingReviewComments.length;
			const prompt = formatMarkdownReviewBatch(fileName, pendingReviewComments);
			pendingReviewComments.length = 0;
			await agentPanelProvider.runBatchPrompt(
				prompt,
				vscode.l10n.t('💬 Markdown Review ({0} comments on {1})', count, fileName),
			);
		}),

		vscode.commands.registerCommand('tarot.steering.create', async () => {
			const scopePick = await vscode.window.showQuickPick(
				[
					{ label: vscode.l10n.t('Workspace (.tarot/steering/)'), description: vscode.l10n.t('Rules versioned in this repository'), scope: 'workspace' as const },
					{ label: vscode.l10n.t('Global (~/.tarot/steering/)'), description: vscode.l10n.t('Personal rules applied to every project'), scope: 'global' as const },
				],
				{ title: vscode.l10n.t('Tarot IDE — Steering Scope') },
			);
			if (!scopePick) {
				return;
			}

			let targetDir: string;
			if (scopePick.scope === 'workspace') {
				const root = await ensureWorkspaceFolder();
				if (!root) {
					return;
				}
				targetDir = steeringService.getWorkspaceSteeringDir(root);
			} else {
				targetDir = steeringService.getGlobalSteeringDir();
			}

			const rawName = await vscode.window.showInputBox({
				title: vscode.l10n.t('Tarot IDE — New Steering'),
				prompt: vscode.l10n.t('Rules file name (e.g. product, tech, structure, api-style)'),
				placeHolder: 'tech',
			});
			if (!rawName) {
				return;
			}

			const inclusionPick = await vscode.window.showQuickPick(
				[
					{ label: 'always', description: vscode.l10n.t('Included in every turn (default)'), value: 'always' as SteeringInclusion },
					{ label: 'fileMatch', description: vscode.l10n.t('Included when the active editor or #File matches a glob'), value: 'fileMatch' as SteeringInclusion },
					{ label: 'auto', description: vscode.l10n.t('Included automatically when relevant to the prompt'), value: 'auto' as SteeringInclusion },
					{ label: 'manual', description: vscode.l10n.t('Included only when referenced as #name or through #Steering'), value: 'manual' as SteeringInclusion },
				],
				{ title: vscode.l10n.t('Tarot IDE — Inclusion Mode') },
			);
			if (!inclusionPick) {
				return;
			}

			let fileMatchPattern: string | undefined;
			if (inclusionPick.value === 'fileMatch') {
				fileMatchPattern = await vscode.window.showInputBox({
					title: vscode.l10n.t('Tarot IDE — fileMatchPattern Glob'),
					prompt: vscode.l10n.t('Glob pattern (e.g. src/**/*.ts, *.tsx)'),
					value: 'src/**/*.ts',
				});
				if (!fileMatchPattern) {
					return;
				}
			}

			const fileName = rawName.trim().endsWith('.md') ? rawName.trim() : `${rawName.trim()}.md`;
			const stem = fileName.replace(/\.md$/i, '');
			const frontmatterLines = [`inclusion: ${inclusionPick.value}`];
			if (fileMatchPattern) {
				frontmatterLines.push(`fileMatchPattern: "${fileMatchPattern.trim()}"`);
			}
			frontmatterLines.push(`description: "Regras de ${stem} para agentes locais"`);

			await fs.mkdir(targetDir, { recursive: true });
			const filePath = path.join(targetDir, fileName);
			await fs.writeFile(
				filePath,
				`---\n${frontmatterLines.join('\n')}\n---\n\n# Steering — ${stem}\n\nDescreva as convenções e regras que todos os agentes (claude, agy, codex) devem seguir.\n`,
				'utf8',
			);
			steeringProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.steering.generate', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			await steeringService.ensureFoundationalTemplates(root);
			steeringProvider.refresh();

			const available = runtimeManager.getStatuses().filter(s => s.available);
			if (available.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t('Templates product.md, tech.md and structure.md created in .tarot/steering/. Install a local CLI (claude, agy or codex) for automatic filling.')
				);
				return;
			}

			const fillWithAgent = vscode.l10n.t('Fill With Agent');
			const editManually = vscode.l10n.t('Edit Manually');
			const confirm = await vscode.window.showInformationMessage(
				vscode.l10n.t('Templates created in .tarot/steering/ (product.md, tech.md, structure.md). Do you want the active agent to analyze the workspace and fill them in?'),
				fillWithAgent,
				editManually,
			);
			if (confirm === fillWithAgent) {
				const prompt = steeringService.buildGenerateSteeringPrompt(root);
				await agentPanelProvider.runExternalPrompt(prompt, 'vibe');
			} else if (confirm === editManually) {
				const doc = await vscode.workspace.openTextDocument(path.join(root, '.tarot', 'steering', 'product.md'));
				await vscode.window.showTextDocument(doc);
			}
		}),

		vscode.commands.registerCommand('tarot.hooks.create', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			const rawName = await vscode.window.showInputBox({
				title: vscode.l10n.t('Tarot IDE — New Agent Hook'),
				prompt: vscode.l10n.t('Hook identifier (e.g. update-tests-on-save)'),
				placeHolder: 'update-tests-on-save',
			});
			if (!rawName) {
				return;
			}
			const id = rawName.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-');
			const dir = path.join(root, '.tarot', 'hooks');
			await fs.mkdir(dir, { recursive: true });
			const filePath = path.join(dir, `${id}.json`);
			// Hook schema `v1`: several hooks per file, `matcher` is a regex on the file path and
			// the action is either a `command` or an `agent` loop. Authored prompts stay PT-BR.
			const template = {
				version: 'v1',
				hooks: [
					{
						name: id,
						description: 'Revisa o arquivo salvo e ajusta ou cria testes quando necessário.',
						enabled: true,
						trigger: 'PostFileSave',
						matcher: '\\.(ts|tsx)$',
						timeout: 60,
						action: {
							type: 'agent',
							prompt: 'Verifique se o arquivo alterado {{file}} precisa de ajustes ou atualização de testes.',
						},
					},
				],
			};
			await fs.writeFile(filePath, JSON.stringify(template, null, 2) + '\n', 'utf8');
			hooksProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.hooks.toggle', async (item?: { hook?: { sourceFile: string; name: string; enabled: boolean } }) => {
			const hook = item?.hook;
			if (!hook) {
				return;
			}
			const nextEnabled = !hook.enabled;
			const confirmLabel = nextEnabled ? vscode.l10n.t('Enable') : vscode.l10n.t('Disable');
			const confirm = await vscode.window.showWarningMessage(
				vscode.l10n.t('{0} hook "{1}" in {2}?', confirmLabel, hook.name, path.basename(hook.sourceFile)),
				{ modal: true },
				confirmLabel,
			);
			if (confirm !== confirmLabel) {
				return;
			}
			const ok = await hookEngine.setHookEnabled(hook.sourceFile, hook.name, nextEnabled);
			if (ok) {
				hooksProvider.refresh();
			} else {
				vscode.window.showErrorMessage(vscode.l10n.t('Could not update hook "{0}".', hook.name));
			}
		}),

		vscode.commands.registerCommand('tarot.hooks.runManual', async (item?: { hook?: { action: { type: 'command' | 'agent'; command?: string; prompt?: string }; name: string; timeout: number } }) => {
			const hook = item?.hook;
			if (!hook) {
				return;
			}
			if (!vscode.workspace.isTrusted) {
				vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before running hooks.'));
				return;
			}
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!root) {
				return;
			}
			if (hook.action.type === 'agent' && hook.action.prompt) {
				await agentPanelProvider.runBatchPrompt(hook.action.prompt, vscode.l10n.t('🪝 Hook: {0}', hook.name));
				return;
			}
			if (hook.action.type === 'command' && hook.action.command) {
				const outcome = await permissionsService.createGatedRunCommand(outputChannel!)(hook.action.command, { cwd: root, hook_event_name: 'Manual' }, hook.timeout);
				if (outcome.kind === 'ok') {
					outputChannel!.appendLine(`[Hooks] "${hook.name}" (manual): ${outcome.stdout || '(no output)'}`);
					vscode.window.showInformationMessage(vscode.l10n.t('Hook "{0}" ran successfully.', hook.name));
				} else {
					const message = outcome.kind === 'timeout' ? vscode.l10n.t('timed out') : outcome.stderr;
					vscode.window.showWarningMessage(vscode.l10n.t('Hook "{0}" failed: {1}', hook.name, message || vscode.l10n.t('unknown error')));
				}
			}
		}),

		vscode.commands.registerCommand('tarot.permissions.openUserPermissions', async () => {
			const filePath = trustService.getUserPermissionsPath();
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			try {
				await fs.access(filePath);
			} catch {
				await fs.writeFile(filePath, 'version: 1\nrules: []\n', 'utf8');
			}
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('tarot.permissions.openWorkspacePermissions', async () => {
			const root = await ensureWorkspaceFolder();
			if (!root) {
				return;
			}
			if (!trustService.requireTrustedOrWarn(vscode.l10n.t('Trust this workspace before editing its permissions.'))) {
				return;
			}
			const filePath = trustService.getWorkspacePermissionsPath(root);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			try {
				await fs.access(filePath);
			} catch {
				await fs.writeFile(filePath, 'version: 1\nrules: []\n', 'utf8');
			}
			const doc = await vscode.workspace.openTextDocument(filePath);
			await vscode.window.showTextDocument(doc);
		}),
	);

	// File-triggered Agent Hooks (PostFileSave/PostFileCreate/PostFileDelete) — never run
	// automatically in an untrusted workspace (AGENTS.md §2d).
	const runFileTriggerHooks = async (trigger: 'PostFileSave' | 'PostFileCreate' | 'PostFileDelete', uri: vscode.Uri) => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root || !vscode.workspace.isTrusted) {
			return;
		}
		const relativePath = path.relative(root, uri.fsPath).replace(/\\/g, '/');
		if (relativePath.startsWith('..') || relativePath.startsWith('.tarot/hooks')) {
			return;
		}
		const hooks = await hookEngine.discover(root);
		if (hooks.length === 0) {
			return;
		}
		// headless: true — an automatic file-save trigger cannot show a blocking approval prompt
		// on every keystroke, so an "ask" decision silently downgrades to deny (M3.8a default policy).
		const result = await runHooksForTrigger(
			hooks, trigger, { cwd: root, file_path: relativePath },
			{ matchInput: relativePath, runCommand: permissionsService.createGatedRunCommand(outputChannel!, { headless: true }) },
		);
		for (const w of result.warnings) {
			outputChannel!.appendLine(`[Hooks] "${w.hook.name}" (${trigger}): ${w.message}`);
		}
		for (const action of result.agentActions) {
			await agentPanelProvider.runBatchPrompt(action.prompt.replace(/\{\{file\}\}/g, relativePath), vscode.l10n.t('🪝 Hook: {0}', action.hook.name));
		}
	};

	context.subscriptions.push(
		{ dispose: () => fileHookQueue.dispose() },
		vscode.workspace.onDidSaveTextDocument(doc => {
			fileHookQueue.enqueue(`PostFileSave:${doc.uri.fsPath}`, () => runFileTriggerHooks('PostFileSave', doc.uri));
		}),
		vscode.workspace.onDidCreateFiles(e => {
			for (const uri of e.files) {
				fileHookQueue.enqueue(`PostFileCreate:${uri.fsPath}`, () => runFileTriggerHooks('PostFileCreate', uri));
			}
		}),
		vscode.workspace.onDidDeleteFiles(e => {
			for (const uri of e.files) {
				fileHookQueue.enqueue(`PostFileDelete:${uri.fsPath}`, () => runFileTriggerHooks('PostFileDelete', uri));
			}
		}),
	);

	// Initial background detection of local AI CLIs (claude, agy, codex, custom)
	void runtimeManager.refresh();

	// Kiro-style Agent-First startup: reveal Tarot Agent in Secondary Side Bar by default
	const openOnStartup = vscode.workspace.getConfiguration('tarot.ui').get<boolean>('openAgentPanelOnStartup', true);
	if (openOnStartup) {
		setTimeout(() => {
			void vscode.commands.executeCommand(`${TarotAgentPanelProvider.viewId}.focus`);
		}, 400);
	}
}

export function deactivate(): void {
	outputChannel?.dispose();
	outputChannel = undefined;
}
