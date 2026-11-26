/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';
import { CheckpointDiffEntry, TarotCheckpointService } from '../checkpoints/checkpointService';
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

interface BeforeUriPayload {
	readonly cwd: string;
	readonly relativePath: string;
	readonly backupAbsPath?: string;
	readonly status: 'added' | 'modified' | 'deleted';
}

function buildBeforeUri(cwd: string, file: PendingReviewFile): vscode.Uri {
	const payload: BeforeUriPayload = {
		cwd,
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

/**
 * Serves the exact pre-turn file content for `vscode.diff` so Git-style side-by-side
 * Accept/Reject review works identically in Git repos AND non-Git folders.
 */
export class TarotCheckpointBeforeContentProvider implements vscode.TextDocumentContentProvider {
	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		let payload: BeforeUriPayload | undefined;
		try {
			payload = JSON.parse(decodeURIComponent(uri.query)) as BeforeUriPayload;
		} catch {
			return '';
		}
		if (!payload || payload.status === 'added') {
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
}

/**
 * Cursor-style Diff Review session manager (EVOLUTION_PLAN_V2.md M6.1).
 * Manages pending agent file edits, opens `Before ↔ Agent Edit` diffs, exposes
 * CodeLens + Editor Title + Status Bar Accept/Reject controls, and reverts rejected
 * files back to their pre-turn checkpoint snapshot.
 */
export class TarotReviewSessionService implements vscode.CodeLensProvider, vscode.Disposable {
	private state: ReviewSessionState | undefined;
	private readonly codeLensEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.codeLensEmitter.event;
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly checkpointService: TarotCheckpointService,
		private readonly onFilesChanged: () => Promise<void> | void,
	) {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 110);
		this.statusBarItem.command = 'tarot.review.open';
		this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		this.disposables.push(this.statusBarItem, this.codeLensEmitter);
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

	async startReview(
		cwd: string,
		sessionId: string,
		checkpointId: string,
		entries: readonly CheckpointDiffEntry[],
		autoOpen: boolean,
	): Promise<void> {
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

	async openActiveDiff(): Promise<void> {
		const current = getActiveReviewFile(this.state);
		if (!this.state || !current) {
			return;
		}
		const beforeUri = buildBeforeUri(this.state.cwd, current);
		const workingAbs = path.join(this.state.cwd, current.relativePath);
		const workingUri = current.status === 'deleted'
			? vscode.Uri.from({
				scheme: TAROT_CHECKPOINT_BEFORE_SCHEME,
				path: `/${current.relativePath}.deleted`,
				query: encodeURIComponent(JSON.stringify({ cwd: this.state.cwd, relativePath: current.relativePath, status: 'added' })),
			})
			: vscode.Uri.file(workingAbs);
		const idx = this.state.activeIndex + 1;
		const total = this.state.pending.length;
		const title = vscode.l10n.t(
			'{0} — Review ({1}/{2}: Before ↔ Agent Edit)',
			path.basename(current.relativePath),
			idx,
			total,
		);
		await vscode.commands.executeCommand('vscode.diff', beforeUri, workingUri, title, {
			preview: false,
			preserveFocus: false,
		});
	}

	private resolveTargetRelativePath(arg?: string | vscode.Uri): string | undefined {
		if (!this.state) {
			return undefined;
		}
		if (typeof arg === 'string' && arg.trim()) {
			return arg.replace(/\\/g, '/');
		}
		if (arg instanceof vscode.Uri) {
			const rel = path.relative(this.state.cwd, arg.fsPath).replace(/\\/g, '/');
			if (this.hasPendingFile(rel)) {
				return rel;
			}
		}
		const activeUri = vscode.window.activeTextEditor?.document.uri;
		if (activeUri) {
			const candidate = activeUri.scheme === TAROT_CHECKPOINT_BEFORE_SCHEME
				? activeUri.path.replace(/^\/+/, '')
				: path.relative(this.state.cwd, activeUri.fsPath).replace(/\\/g, '/');
			if (this.hasPendingFile(candidate)) {
				return candidate;
			}
		}
		return getActiveReviewFile(this.state)?.relativePath;
	}

	async acceptFile(arg?: string | vscode.Uri): Promise<void> {
		const rel = this.resolveTargetRelativePath(arg);
		if (!this.state || !rel) {
			return;
		}
		this.state = removeReviewFile(this.state, rel);
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
		const result = await this.checkpointService.restoreCheckpointFiles(cwd, sessionId, checkpointId, [rel]);
		this.state = removeReviewFile(this.state, rel);
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
		this.state = undefined;
		await this.syncUiState();
		vscode.window.showInformationMessage(vscode.l10n.t('Accepted {0} file change(s).', count));
	}

	async rejectAll(): Promise<void> {
		if (!this.state) {
			return;
		}
		const { cwd, sessionId, checkpointId, pending } = this.state;
		const paths = pending.map(f => f.relativePath);
		const result = await this.checkpointService.restoreCheckpointFiles(cwd, sessionId, checkpointId, paths);
		this.state = undefined;
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

	async nextFile(): Promise<void> {
		if (!this.state || this.state.pending.length === 0) {
			return;
		}
		this.state = advanceReviewFile(this.state);
		await this.syncUiState();
		await this.openActiveDiff();
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		if (!this.state || document.uri.scheme !== 'file') {
			return [];
		}
		const rel = path.relative(this.state.cwd, document.uri.fsPath).replace(/\\/g, '/');
		if (!this.hasPendingFile(rel)) {
			return [];
		}
		const top = new vscode.Range(0, 0, 0, 0);
		const total = this.state.pending.length;
		const lenses: vscode.CodeLens[] = [
			new vscode.CodeLens(top, {
				title: `$(check) ${vscode.l10n.t('Accept File')}`,
				command: 'tarot.review.acceptFile',
				arguments: [rel],
			}),
			new vscode.CodeLens(top, {
				title: `$(discard) ${vscode.l10n.t('Reject File')}`,
				command: 'tarot.review.rejectFile',
				arguments: [rel],
			}),
		];
		if (total > 1) {
			lenses.push(
				new vscode.CodeLens(top, {
					title: `$(check-all) ${vscode.l10n.t('Accept All ({0})', total)}`,
					command: 'tarot.review.acceptAll',
				}),
				new vscode.CodeLens(top, {
					title: `$(close-all) ${vscode.l10n.t('Reject All')}`,
					command: 'tarot.review.rejectAll',
				}),
				new vscode.CodeLens(top, {
					title: `$(arrow-right) ${vscode.l10n.t('Next File')}`,
					command: 'tarot.review.nextFile',
				}),
			);
		}
		return lenses;
	}

	private async syncUiState(): Promise<void> {
		const count = this.state?.pending.length ?? 0;
		await vscode.commands.executeCommand('setContext', 'tarot.hasPendingReview', count > 0);
		if (count > 0) {
			this.statusBarItem.text = `$(git-compare) ${vscode.l10n.t('Review: {0} file(s)', count)}`;
			this.statusBarItem.tooltip = vscode.l10n.t('Open Tarot Diff Review (Accept / Reject agent changes)');
			this.statusBarItem.show();
		} else {
			this.statusBarItem.hide();
		}
		this.codeLensEmitter.fire();
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
