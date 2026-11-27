/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';
import { InlineDiffCard } from '../agents/types';
import { CheckpointDiffEntry, TarotCheckpointService } from '../checkpoints/checkpointService';
import { ChangedFileInfo } from '../git/gitReviewService';
import {
	applyAcceptHunk,
	applyRejectHunk,
	buildInlineDiffPreviewHunks,
	computeDiffHunks,
	countDiffStats,
} from './diffHunkEngine';
import {
	advanceReviewFile,
	createReviewSessionState,
	getActiveReviewFile,
	PendingReviewFile,
	removeReviewFile,
	ReviewSessionState,
	selectReviewFile,
} from './reviewSessionModel';

export const TAROT_CHECKPOINT_BEFORE_SCHEME = 'tarot-checkpoint-before';
const INLINE_REVIEW_SET_STATE_CMD = '_tarot.inlineReview.setState';

interface BeforeUriPayload {
	readonly cwd: string;
	readonly checkpointId: string;
	readonly relativePath: string;
	readonly backupAbsPath?: string;
	readonly status: 'added' | 'modified' | 'deleted';
}

function makeCacheKey(checkpointId: string, relativePath: string): string {
	return `${checkpointId}::${relativePath.replace(/\\/g, '/')}`;
}

function buildBeforeUri(cwd: string, checkpointId: string, file: PendingReviewFile): vscode.Uri {
	const payload: BeforeUriPayload = {
		cwd,
		checkpointId,
		relativePath: file.relativePath,
		backupAbsPath: file.backupAbsPath,
		status: file.status,
	};
	return vscode.Uri.from({
		scheme: TAROT_CHECKPOINT_BEFORE_SCHEME,
		path: `/${file.relativePath}`,
		query: encodeURIComponent(JSON.stringify(payload)),
	});
}

async function readOriginalBeforeContent(payload: BeforeUriPayload): Promise<string> {
	if (payload.status === 'added') {
		return '';
	}
	if (payload.backupAbsPath) {
		try {
			return await fs.readFile(payload.backupAbsPath, 'utf8');
		} catch {
			// Fall through to git HEAD
		}
	}
	const gitBin = await resolveBinaryPath('git');
	if (gitBin) {
		const res = await execSimple(gitBin, ['-C', payload.cwd, 'show', `HEAD:${payload.relativePath}`], 6000);
		if (res.exitCode === 0) {
			return res.stdout;
		}
	}
	return '';
}

/**
 * Serves the exact pre-turn file content for `vscode.diff` (used for deleted files)
 * and caches pre-turn snapshots for the Cursor-style inline Monaco review overlay.
 */
export class TarotCheckpointBeforeContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changeEmitter.event;
	private readonly contentCache = new Map<string, string>();

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		let payload: BeforeUriPayload | undefined;
		try {
			payload = JSON.parse(decodeURIComponent(uri.query)) as BeforeUriPayload;
		} catch {
			return '';
		}
		if (!payload) {
			return '';
		}
		const key = makeCacheKey(payload.checkpointId, payload.relativePath);
		const cached = this.contentCache.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const content = await readOriginalBeforeContent(payload);
		this.contentCache.set(key, content);
		return content;
	}

	async getBeforeContent(cwd: string, checkpointId: string, file: PendingReviewFile): Promise<string> {
		const key = makeCacheKey(checkpointId, file.relativePath);
		const cached = this.contentCache.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const content = await readOriginalBeforeContent({
			cwd,
			checkpointId,
			relativePath: file.relativePath,
			backupAbsPath: file.backupAbsPath,
			status: file.status,
		});
		this.contentCache.set(key, content);
		return content;
	}

	getCachedBeforeContent(checkpointId: string, relativePath: string): string | undefined {
		return this.contentCache.get(makeCacheKey(checkpointId, relativePath));
	}

	setOverrideContent(cwd: string, checkpointId: string, file: PendingReviewFile, nextContent: string): void {
		const key = makeCacheKey(checkpointId, file.relativePath);
		this.contentCache.set(key, nextContent);
		this.changeEmitter.fire(buildBeforeUri(cwd, checkpointId, file));
	}

	clearCheckpoint(checkpointId: string): void {
		const prefix = `${checkpointId}::`;
		for (const key of this.contentCache.keys()) {
			if (key.startsWith(prefix)) {
				this.contentCache.delete(key);
			}
		}
	}

	dispose(): void {
		this.contentCache.clear();
		this.changeEmitter.dispose();
	}
}

/**
 * Cursor-style Inline Diff Review session manager (EVOLUTION_PLAN_V2.md M6.1 + M6.7).
 * Opens the regular single-column editor with native Monaco inline green/red diff blocks,
 * per-hunk floating Accept/Reject pills, and a bottom floating review bar, working
 * identically in Git repos and non-Git workspaces.
 */
export class TarotReviewSessionService implements vscode.CodeLensProvider, vscode.Disposable {
	private state: ReviewSessionState | undefined;
	private readonly codeLensEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.codeLensEmitter.event;
	private readonly stateEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeState = this.stateEmitter.event;
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly checkpointService: TarotCheckpointService,
		private readonly beforeProvider: TarotCheckpointBeforeContentProvider,
		private readonly onFilesChanged: () => Promise<void> | void,
	) {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 110);
		this.statusBarItem.command = 'tarot.review.open';
		this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

		this.disposables.push(
			this.statusBarItem,
			this.codeLensEmitter,
			this.stateEmitter,
			vscode.workspace.onDidChangeTextDocument(e => {
				if (this.state && e.document.uri.scheme === 'file') {
					const rel = path.relative(this.state.cwd, e.document.uri.fsPath).replace(/\\/g, '/');
					if (this.hasPendingFile(rel)) {
						void this.pushInlineReviewOverlay();
					}
				}
			}),
		);
	}

	hasPendingReview(): boolean {
		return Boolean(this.state && this.state.pending.length > 0);
	}

	hasPendingFile(relativePath: string): boolean {
		const norm = relativePath.replace(/\\/g, '/');
		return Boolean(this.state?.pending.some(f => f.relativePath === norm));
	}

	getPendingFiles(): readonly PendingReviewFile[] {
		return this.state?.pending ?? [];
	}

	getActiveSessionInfo(): { readonly cwd: string; readonly sessionId: string; readonly checkpointId: string } | undefined {
		if (!this.state) {
			return undefined;
		}
		return { cwd: this.state.cwd, sessionId: this.state.sessionId, checkpointId: this.state.checkpointId };
	}

	private async readWorkingText(cwd: string, file: PendingReviewFile): Promise<string> {
		if (file.status === 'deleted') {
			return '';
		}
		const abs = path.join(cwd, file.relativePath);
		const openDoc = vscode.workspace.textDocuments.find(
			d => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === path.resolve(abs),
		);
		if (openDoc) {
			return openDoc.getText();
		}
		try {
			return await fs.readFile(abs, 'utf8');
		} catch {
			return '';
		}
	}

	/**
	 * Builds compact colored diff preview cards (M6.7) for rendering inside chat messages.
	 */
	async buildInlineDiffCards(
		cwd: string,
		checkpointId: string,
		entries: readonly CheckpointDiffEntry[],
		maxFiles = 5,
	): Promise<InlineDiffCard[]> {
		const cards: InlineDiffCard[] = [];
		for (const entry of entries.slice(0, maxFiles)) {
			const file: PendingReviewFile = {
				relativePath: entry.relativePath.replace(/\\/g, '/'),
				status: entry.status,
				backupAbsPath: entry.backupAbsPath,
			};
			const beforeText = await this.beforeProvider.getBeforeContent(cwd, checkpointId, file);
			const afterText = await this.readWorkingText(cwd, file);
			const hunks = computeDiffHunks(beforeText, afterText);
			const stats = countDiffStats(hunks);
			const previewHunks = buildInlineDiffPreviewHunks(beforeText, afterText, 2, 32);
			cards.push({
				relativePath: file.relativePath,
				status: file.status,
				added: stats.added,
				removed: stats.removed,
				hunks: previewHunks,
			});
		}
		return cards;
	}

	/**
	 * Returns ChangedFileInfo[] with real +added/-removed line counts for all pending review files,
	 * working identically in Git and non-Git workspaces.
	 */
	async getPendingChangedFileStats(): Promise<ChangedFileInfo[]> {
		if (!this.state) {
			return [];
		}
		const results: ChangedFileInfo[] = [];
		for (const file of this.state.pending) {
			const beforeText = await this.beforeProvider.getBeforeContent(this.state.cwd, this.state.checkpointId, file);
			const afterText = await this.readWorkingText(this.state.cwd, file);
			const stats = countDiffStats(computeDiffHunks(beforeText, afterText));
			results.push({
				relativePath: file.relativePath,
				status: file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M',
				added: stats.added,
				removed: stats.removed,
			});
		}
		return results;
	}

	async startReview(
		cwd: string,
		sessionId: string,
		checkpointId: string,
		entries: readonly CheckpointDiffEntry[],
		autoOpen: boolean,
	): Promise<void> {
		// TD-07: only clear the previous checkpoint/close its diff tabs when *the same* session
		// is replacing its own prior review (a normal subsequent turn). When a *different*
		// session starts a review, leave the other session's checkpoint backups on disk —
		// discarding them outright left that session's edited files unrecoverable with no
		// warning. The active diff-tab UI still only tracks one session at a time (`this.state`
		// below); isolating concurrent reviews per session is a larger follow-up (TD-17).
		if (this.state && this.state.sessionId === sessionId && this.state.checkpointId !== checkpointId) {
			this.beforeProvider.clearCheckpoint(this.state.checkpointId);
			await this.closeReviewDiffTabs();
		}
		const next = createReviewSessionState(
			cwd,
			sessionId,
			checkpointId,
			entries.map(e => ({
				relativePath: e.relativePath,
				status: e.status,
				backupAbsPath: e.backupAbsPath,
			})),
		);
		this.state = next;
		if (this.state) {
			await Promise.all(
				this.state.pending.map(f =>
					this.beforeProvider.getBeforeContent(this.state!.cwd, this.state!.checkpointId, f).catch(() => ''),
				),
			);
		}
		await this.syncUiState();
		if (autoOpen && this.state) {
			await this.openActiveDiff();
		}
	}

	async openFile(relativePath: string): Promise<boolean> {
		if (!this.state) {
			return false;
		}
		const updated = selectReviewFile(this.state, relativePath);
		if (!updated) {
			return false;
		}
		this.state = updated;
		await this.syncUiState();
		await this.openActiveDiff();
		return true;
	}

	/**
	 * Cursor-style single-editor inline review: opens the actual working file directly
	 * (no 2-column split, no duplicate Review tabs) and scrolls to the first changed hunk.
	 * Only deleted files fall back to `vscode.diff` so the user can inspect removed content.
	 */
	async openActiveDiff(): Promise<void> {
		const current = getActiveReviewFile(this.state);
		if (!this.state || !current) {
			return;
		}
		const beforeText = await this.beforeProvider.getBeforeContent(this.state.cwd, this.state.checkpointId, current).catch(() => '');
		const workingAbs = path.join(this.state.cwd, current.relativePath);

		if (current.status === 'deleted') {
			const beforeUri = buildBeforeUri(this.state.cwd, this.state.checkpointId, current);
			const deletedUri = vscode.Uri.from({
				scheme: TAROT_CHECKPOINT_BEFORE_SCHEME,
				path: `/${current.relativePath}.deleted`,
				query: encodeURIComponent(JSON.stringify({
					cwd: this.state.cwd,
					checkpointId: this.state.checkpointId,
					relativePath: current.relativePath,
					status: 'added',
				})),
			});
			const title = vscode.l10n.t('{0} — Deleted by Agent', path.basename(current.relativePath));
			await vscode.commands.executeCommand('vscode.diff', beforeUri, deletedUri, title, {
				preview: false,
				preserveFocus: false,
			});
			return;
		}

		const workingUri = vscode.Uri.file(workingAbs);
		const doc = await vscode.workspace.openTextDocument(workingUri);
		const editor = await vscode.window.showTextDocument(doc, {
			preview: false,
			preserveFocus: false,
		});
		await this.pushInlineReviewOverlay();

		const hunks = computeDiffHunks(beforeText, doc.getText());
		if (hunks.length > 0) {
			const targetLine = Math.max(0, Math.min(hunks[0].newStart, Math.max(0, doc.lineCount - 1)));
			const range = new vscode.Range(targetLine, 0, targetLine, 0);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		}
	}

	private resolveTargetRelativePath(arg?: string | vscode.Uri): string | undefined {
		if (!this.state) {
			return undefined;
		}
		if (typeof arg === 'string' && arg.trim()) {
			const norm = arg.replace(/\\/g, '/');
			if (this.hasPendingFile(norm)) {
				return norm;
			}
		}
		if (arg instanceof vscode.Uri) {
			const candidate = arg.scheme === TAROT_CHECKPOINT_BEFORE_SCHEME
				? arg.path.replace(/^\/+/, '').replace(/\.deleted$/, '')
				: path.relative(this.state.cwd, arg.fsPath).replace(/\\/g, '/');
			if (this.hasPendingFile(candidate)) {
				return candidate;
			}
		}
		const activeUri = vscode.window.activeTextEditor?.document.uri;
		if (activeUri) {
			const candidate = activeUri.scheme === TAROT_CHECKPOINT_BEFORE_SCHEME
				? activeUri.path.replace(/^\/+/, '').replace(/\.deleted$/, '')
				: path.relative(this.state.cwd, activeUri.fsPath).replace(/\\/g, '/');
			if (this.hasPendingFile(candidate)) {
				return candidate;
			}
		}
		return getActiveReviewFile(this.state)?.relativePath;
	}

	async acceptHunk(relativePath: string, hunkIndex: number): Promise<void> {
		if (!this.state) {
			return;
		}
		const norm = relativePath.replace(/\\/g, '/');
		const file = this.state.pending.find(f => f.relativePath === norm);
		if (!file) {
			return;
		}
		const beforeText = await this.beforeProvider.getBeforeContent(this.state.cwd, this.state.checkpointId, file);
		const workingUri = vscode.Uri.file(path.join(this.state.cwd, file.relativePath));
		const doc = await vscode.workspace.openTextDocument(workingUri);
		const afterText = doc.getText();
		const hunks = computeDiffHunks(beforeText, afterText);
		const hunk = hunks[hunkIndex];
		if (!hunk) {
			return;
		}

		const nextBefore = applyAcceptHunk(beforeText, hunk);
		this.beforeProvider.setOverrideContent(this.state.cwd, this.state.checkpointId, file, nextBefore);

		const remaining = computeDiffHunks(nextBefore, afterText);
		if (remaining.length === 0) {
			await this.acceptFile(norm);
		} else {
			await this.pushInlineReviewOverlay();
			this.stateEmitter.fire();
		}
	}

	async rejectHunk(relativePath: string, hunkIndex: number): Promise<void> {
		if (!this.state) {
			return;
		}
		const norm = relativePath.replace(/\\/g, '/');
		const file = this.state.pending.find(f => f.relativePath === norm);
		if (!file) {
			return;
		}
		const beforeText = await this.beforeProvider.getBeforeContent(this.state.cwd, this.state.checkpointId, file);
		const workingUri = vscode.Uri.file(path.join(this.state.cwd, file.relativePath));
		const doc = await vscode.workspace.openTextDocument(workingUri);
		const afterText = doc.getText();
		const hunks = computeDiffHunks(beforeText, afterText);
		const hunk = hunks[hunkIndex];
		if (!hunk) {
			return;
		}

		const nextAfter = applyRejectHunk(afterText, hunk);
		const fullRange = new vscode.Range(
			doc.positionAt(0),
			doc.positionAt(afterText.length),
		);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(workingUri, fullRange, nextAfter);
		const applied = await vscode.workspace.applyEdit(edit);
		if (applied) {
			await doc.save();
		}

		const remaining = computeDiffHunks(beforeText, nextAfter);
		if (remaining.length === 0) {
			await this.closeReviewDiffTabs(norm);
			this.state = removeReviewFile(this.state, norm);
			await this.syncUiState();
			await this.onFilesChanged();
			if (this.state) {
				await this.openActiveDiff();
			} else {
				vscode.window.showInformationMessage(vscode.l10n.t('Reverted {0}.', norm));
			}
		} else {
			await this.pushInlineReviewOverlay();
			await this.onFilesChanged();
		}
	}

	async acceptFile(arg?: string | vscode.Uri): Promise<void> {
		const rel = this.resolveTargetRelativePath(arg);
		if (!this.state || !rel) {
			return;
		}
		const prevCheckpoint = this.state.checkpointId;
		await this.closeReviewDiffTabs(rel);
		this.state = removeReviewFile(this.state, rel);
		if (!this.state) {
			this.beforeProvider.clearCheckpoint(prevCheckpoint);
		}
		await this.syncUiState();
		if (this.state) {
			await this.openActiveDiff();
		} else {
			vscode.window.showInformationMessage(vscode.l10n.t('All agent changes accepted.'));
		}
	}

	async rejectFile(arg?: string | vscode.Uri): Promise<void> {
		const rel = this.resolveTargetRelativePath(arg);
		if (!this.state || !rel) {
			return;
		}
		const { cwd, sessionId, checkpointId } = this.state;
		await this.closeReviewDiffTabs(rel);
		const result = await this.checkpointService.restoreCheckpointFiles(cwd, sessionId, checkpointId, [rel]);
		this.state = removeReviewFile(this.state, rel);
		if (!this.state) {
			this.beforeProvider.clearCheckpoint(checkpointId);
		}
		await this.syncUiState();
		await this.onFilesChanged();
		if (result.skipped.length > 0) {
			vscode.window.showWarningMessage(
				vscode.l10n.t('Could not revert {0} (no pre-turn backup available).', rel),
			);
		} else {
			vscode.window.showInformationMessage(vscode.l10n.t('Reverted {0}.', rel));
		}
		if (this.state) {
			await this.openActiveDiff();
		}
	}

	async acceptAll(): Promise<void> {
		if (!this.state) {
			return;
		}
		const count = this.state.pending.length;
		const prevCheckpoint = this.state.checkpointId;
		this.state = undefined;
		this.beforeProvider.clearCheckpoint(prevCheckpoint);
		await this.closeReviewDiffTabs();
		await this.syncUiState();
		vscode.window.showInformationMessage(vscode.l10n.t('Accepted {0} file change(s).', count));
	}

	async rejectAll(): Promise<void> {
		if (!this.state) {
			return;
		}
		const { cwd, sessionId, checkpointId, pending } = this.state;
		const paths = pending.map(f => f.relativePath);
		this.state = undefined;
		this.beforeProvider.clearCheckpoint(checkpointId);
		await this.closeReviewDiffTabs();
		const result = await this.checkpointService.restoreCheckpointFiles(cwd, sessionId, checkpointId, paths);
		await this.syncUiState();
		await this.onFilesChanged();
		if (result.skipped.length > 0) {
			vscode.window.showWarningMessage(
				vscode.l10n.t('Reverted {0} file(s); {1} could not be reverted.', result.reverted.length, result.skipped.length),
			);
		} else {
			vscode.window.showInformationMessage(vscode.l10n.t('Rejected and reverted {0} file(s).', result.reverted.length));
		}
	}

	async markResolvedExternally(relativePaths?: readonly string[]): Promise<void> {
		if (!this.state) {
			return;
		}
		if (!relativePaths || relativePaths.length === 0) {
			const prevCheckpoint = this.state.checkpointId;
			this.state = undefined;
			this.beforeProvider.clearCheckpoint(prevCheckpoint);
			await this.closeReviewDiffTabs();
			await this.syncUiState();
			return;
		}
		const prevCheckpoint = this.state.checkpointId;
		for (const rel of relativePaths) {
			await this.closeReviewDiffTabs(rel);
			this.state = removeReviewFile(this.state, rel);
		}
		if (!this.state) {
			this.beforeProvider.clearCheckpoint(prevCheckpoint);
		}
		await this.syncUiState();
	}

	async nextFile(): Promise<void> {
		if (!this.state || this.state.pending.length === 0) {
			return;
		}
		this.state = advanceReviewFile(this.state);
		await this.syncUiState();
		await this.openActiveDiff();
	}

	provideCodeLenses(): vscode.CodeLens[] {
		// Native Monaco inline review overlay (tarotReview.contribution.ts) renders
		// Cursor-style per-hunk Accept/Reject pills and the floating bottom bar directly.
		return [];
	}

	private async pushInlineReviewOverlay(): Promise<void> {
		if (!this.state || this.state.pending.length === 0) {
			await vscode.commands.executeCommand(INLINE_REVIEW_SET_STATE_CMD, { files: [] }).then(undefined, () => undefined);
			return;
		}
		const totalFiles = this.state.pending.length;
		const files: Array<{
			readonly fsPath: string;
			readonly relativePath: string;
			readonly fileIndex: number;
			readonly totalFiles: number;
			readonly hunks: ReadonlyArray<{
				readonly id: number;
				readonly startLine: number;
				readonly lineCount: number;
				readonly removedLines: readonly string[];
			}>;
		}> = [];

		for (let fileIndex = 0; fileIndex < totalFiles; fileIndex++) {
			const file = this.state.pending[fileIndex];
			if (file.status === 'deleted') {
				continue;
			}
			const beforeText = await this.beforeProvider.getBeforeContent(this.state.cwd, this.state.checkpointId, file);
			const afterText = await this.readWorkingText(this.state.cwd, file);
			const hunks = computeDiffHunks(beforeText, afterText);
			if (hunks.length === 0) {
				continue;
			}
			files.push({
				fsPath: path.join(this.state.cwd, file.relativePath),
				relativePath: file.relativePath,
				fileIndex,
				totalFiles,
				hunks: hunks.map(h => ({
					id: h.id,
					startLine: h.newStart + 1,
					lineCount: h.newCount,
					removedLines: h.oldLines,
				})),
			});
		}

		await vscode.commands.executeCommand(INLINE_REVIEW_SET_STATE_CMD, { files }).then(undefined, () => undefined);
	}

	private async closeReviewDiffTabs(relativePath?: string): Promise<void> {
		const normTarget = relativePath?.replace(/\\/g, '/');
		const toClose: vscode.Tab[] = [];
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === TAROT_CHECKPOINT_BEFORE_SCHEME) {
					if (!normTarget) {
						toClose.push(tab);
					} else {
						const tabRel = tab.input.original.path.replace(/^\/+/, '').replace(/\.deleted$/, '');
						if (tabRel === normTarget) {
							toClose.push(tab);
						}
					}
				}
			}
		}
		if (toClose.length > 0) {
			await vscode.window.tabGroups.close(toClose, true).then(undefined, () => undefined);
		}
	}

	private async syncUiState(): Promise<void> {
		const count = this.state?.pending.length ?? 0;
		await vscode.commands.executeCommand('setContext', 'tarot.hasPendingReview', count > 0);
		if (count > 0) {
			this.statusBarItem.text = `$(git-compare) ${vscode.l10n.t('Review: {0} file(s)', count)}`;
			this.statusBarItem.tooltip = vscode.l10n.t('Open Tarot Inline Diff Review (Accept / Reject agent changes)');
			this.statusBarItem.show();
		} else {
			this.statusBarItem.hide();
		}
		await this.pushInlineReviewOverlay();
		this.codeLensEmitter.fire();
		this.stateEmitter.fire();
	}

	dispose(): void {
		void vscode.commands.executeCommand(INLINE_REVIEW_SET_STATE_CMD, { files: [] }).then(undefined, () => undefined);
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
