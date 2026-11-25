/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRuntimeManager } from '../agents/runtimeManager';
import { TarotCheckpointService } from '../checkpoints/checkpointService';
import { formatMarkdownReviewBatch, MarkdownReviewComment } from '../specs/markdownReview';
import { SpecCreationKind, TarotSpecService } from '../specs/specService';
import { readTaskCheckpoint } from '../specs/specTaskCheckpoints';
import { SpecTaskCodeLensProvider } from '../specs/taskCodeLensProvider';
import { TarotAgentPanelProvider } from '../views/agentPanelView';
import { SpecsTreeProvider } from '../views/tarotSidebarViews';

export interface SpecCommandsDeps {
	readonly specService: TarotSpecService;
	readonly runtimeManager: AgentRuntimeManager;
	readonly checkpointService: TarotCheckpointService;
	readonly specsProvider: SpecsTreeProvider;
	readonly specCodeLensProvider: SpecTaskCodeLensProvider;
	readonly agentPanelProvider: TarotAgentPanelProvider;
	readonly ensureWorkspaceFolder: () => Promise<string | undefined>;
}

async function resolveSpecDirFromUriOrPick(
	uri: vscode.Uri | undefined,
	specService: TarotSpecService,
	ensureWorkspaceFolder: () => Promise<string | undefined>,
	title = vscode.l10n.t('Pick Spec'),
): Promise<string | undefined> {
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
		{ title },
	);
	return picked?.specDir;
}

export function registerSpecCommands(deps: SpecCommandsDeps): vscode.Disposable[] {
	const pendingReviewComments: MarkdownReviewComment[] = [];

	return [
		vscode.commands.registerCommand('tarot.specs.create', async () => {
			const root = await deps.ensureWorkspaceFolder();
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

			const { dirPath, entryFilePath } = await deps.specService.createSpec(root, slug, kindPick.specKind);
			deps.specsProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(entryFilePath);
			await vscode.window.showTextDocument(doc);
			await deps.agentPanelProvider.introduceSpecInPanel(dirPath, slug, kindPick.specKind);
		}),

		vscode.commands.registerCommand('tarot.specs.runTask', async (uri?: vscode.Uri, lineIndex?: number) => {
			if (!uri || typeof lineIndex !== 'number') {
				return;
			}
			const specDir = path.dirname(uri.fsPath);
			await deps.agentPanelProvider.runSpecTask(specDir, lineIndex);
			deps.specsProvider.refresh();
			deps.specCodeLensProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.specs.runTaskWith', async (uri?: vscode.Uri, lineIndex?: number) => {
			if (!uri || typeof lineIndex !== 'number') {
				return;
			}
			const available = deps.runtimeManager.getStatuses().filter(s => s.available);
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
			await deps.agentPanelProvider.runSpecTask(specDir, lineIndex, picked.agentId);
			deps.specsProvider.refresh();
			deps.specCodeLensProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.specs.runAllTasks', async (uri?: vscode.Uri) => {
			const specDir = await resolveSpecDirFromUriOrPick(uri, deps.specService, deps.ensureWorkspaceFolder);
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
			await deps.agentPanelProvider.runAllSpecTasks(specDir, picked.includeOptional);
			deps.specsProvider.refresh();
			deps.specCodeLensProvider.refresh();
		}),

		vscode.commands.registerCommand('tarot.specs.syncFiles', async (uri?: vscode.Uri) => {
			const specDir = await resolveSpecDirFromUriOrPick(uri, deps.specService, deps.ensureWorkspaceFolder);
			if (!specDir) {
				return;
			}
			await deps.agentPanelProvider.runSyncFiles(specDir);
			deps.specsProvider.refresh();
			deps.specCodeLensProvider.refresh();
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
			const diffEntries = await deps.checkpointService.getCheckpointDiff(cwd, record.sessionId, record.checkpointId);
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
			const specDir = specDirArg ?? await resolveSpecDirFromUriOrPick(
				undefined,
				deps.specService,
				deps.ensureWorkspaceFolder,
				vscode.l10n.t('Analyze Requirements — Pick Spec'),
			);
			if (specDir) {
				await deps.agentPanelProvider.runAnalyzeRequirements(specDir);
			}
		}),

		vscode.commands.registerCommand('tarot.specs.quickSpec', async () => {
			const root = await deps.ensureWorkspaceFolder();
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
			const { dirPath, entryFilePath } = await deps.specService.createSpec(root, slug, 'quick-spec');
			deps.specsProvider.refresh();
			const doc = await vscode.workspace.openTextDocument(entryFilePath);
			await vscode.window.showTextDocument(doc, { preview: false });
			await deps.agentPanelProvider.runQuickSpec(dirPath, description.trim());
		}),

		vscode.commands.registerCommand('tarot.specs.generateFromSession', async () => {
			await deps.agentPanelProvider.generateSpecFromActiveSession();
			deps.specsProvider.refresh();
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
			await deps.agentPanelProvider.runBatchPrompt(
				prompt,
				vscode.l10n.t('💬 Markdown Review ({0} comments on {1})', count, fileName),
			);
		}),
	];
}
