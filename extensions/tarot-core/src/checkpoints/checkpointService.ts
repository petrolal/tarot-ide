/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';

interface CheckpointFileEntry {
	readonly relativePath: string;
	readonly existed: boolean;
	readonly backupName?: string;
}

/** A file's identity at checkpoint time — no content, just enough to notice it changed later. */
interface BaselineFileEntry {
	readonly relativePath: string;
	readonly mtimeMs: number;
	readonly size: number;
}

interface CheckpointManifest {
	readonly id: string;
	readonly sessionId: string;
	readonly createdAt: string;
	readonly workspaceRoot: string;
	readonly files: readonly CheckpointFileEntry[];
	/**
	 * Only populated when git is unavailable at checkpoint time: `collectDirtyFiles` has no way to
	 * see a clean, pre-existing file the agent later edits without opening it in an editor tab, so
	 * `createCheckpoint` fingerprints the whole workspace (mtime+size, no content copy) instead —
	 * `getCheckpointDiff` compares against this to detect changes git-less detection would
	 * otherwise miss entirely.
	 */
	readonly baseline?: readonly BaselineFileEntry[];
}

// `.tarot/checkpoints/**` and `.tarot/sessions/**` are Tarot's own bookkeeping — the former is
// self-referential (every checkpoint write would make the next checkpoint see its own backups as
// "added"), the latter is rewritten on every single chat message regardless of what the agent
// did. Both are pure noise for a diff about what *this turn* changed. Every other `.tarot/**` path
// (settings, hooks, agents, workflows, powers, specs, steering) is real content the agent or the
// user writes to, and is exactly what the fs_write invariants (`.tarot/settings/**`,
// `.tarot/{hooks,agents,workflows,powers}/**`) need to actually see to be enforced — excluding all
// of `.tarot/` blindly (the previous behavior) made the gate structurally unable to ever catch a
// write to the paths it exists to protect.
const WORKSPACE_SCAN_EXCLUDE = '{**/node_modules/**,**/.git/**,**/.tarot/checkpoints/**,**/.tarot/sessions/**,**/.venv/**,**/venv/**,**/dist/**,**/out/**,**/build/**,**/.next/**}';

function isTarotBookkeepingPath(relativePath: string): boolean {
	const normalized = relativePath.replace(/\\/g, '/');
	return normalized.startsWith('.tarot/checkpoints/') || normalized.startsWith('.tarot/sessions/');
}
const WORKSPACE_SCAN_LIMIT = 5_000;

/** Revert outcome for `restoreCheckpointFiles`: `skipped` files have no recoverable backup (no git, no manifest entry, but known to have existed before the checkpoint) — reverting them would mean deleting real content, so they are left untouched instead. */
export interface RevertFilesResult {
	readonly reverted: readonly string[];
	readonly skipped: readonly string[];
}

export interface CheckpointDiffEntry {
	readonly relativePath: string;
	readonly status: 'added' | 'modified' | 'deleted';
	/** Absolute path to the pre-checkpoint backup on disk; absent for freshly `added` files. */
	readonly backupAbsPath?: string;
}

export class TarotCheckpointService {
	private async isInsideGitRepo(gitPath: string, workspaceRoot: string): Promise<boolean> {
		const res = await execSimple(gitPath, ['-C', workspaceRoot, 'rev-parse', '--is-inside-work-tree'], 4000).catch(() => undefined);
		return res?.exitCode === 0 && res.stdout.trim() === 'true';
	}

	/**
	 * Captures a lightweight snapshot of currently modified/untracked files before an agent turn
	 * so the user can restore to this point in 1 click without losing chat history.
	 * In non-Git workspaces, also snapshots small existing workspace files (<= 512 KB, up to 200)
	 * so post-turn Before ↔ After diffs and Reject File revert work identically without Git.
	 */
	async createCheckpoint(workspaceRoot: string, sessionId: string): Promise<string | undefined> {
		const id = `cp-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
		const cpDir = path.join(workspaceRoot, '.tarot', 'checkpoints', sessionId, id);
		const filesDir = path.join(cpDir, 'files');

		try {
			await fs.mkdir(filesDir, { recursive: true });
			const gitPath = await resolveBinaryPath('git');
			const isGitRepo = Boolean(gitPath && await this.isInsideGitRepo(gitPath, workspaceRoot));

			const candidateFiles = await this.collectDirtyFiles(workspaceRoot);
			const entries: CheckpointFileEntry[] = [];
			const seen = new Set<string>();

			let backupCounter = 0;
			for (const rel of candidateFiles) {
				seen.add(rel);
				const abs = path.join(workspaceRoot, rel);
				try {
					const stat = await fs.stat(abs);
					if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
						const backupName = `f_${backupCounter++}.bak`;
						await fs.copyFile(abs, path.join(filesDir, backupName));
						entries.push({ relativePath: rel, existed: true, backupName });
					}
				} catch {
					entries.push({ relativePath: rel, existed: false });
				}
			}

			let baseline: BaselineFileEntry[] | undefined;
			if (!isGitRepo) {
				baseline = await this.scanWorkspaceFingerprint(workspaceRoot);
				let extraBackedUp = 0;
				for (const base of baseline) {
					if (extraBackedUp >= 200) {
						break;
					}
					if (seen.has(base.relativePath) || base.size > 512 * 1024) {
						continue;
					}
					const abs = path.join(workspaceRoot, base.relativePath);
					try {
						const backupName = `f_${backupCounter++}.bak`;
						await fs.copyFile(abs, path.join(filesDir, backupName));
						entries.push({ relativePath: base.relativePath, existed: true, backupName });
						seen.add(base.relativePath);
						extraBackedUp++;
					} catch {
						// Best-effort non-git backup
					}
				}
			}

			const manifest: CheckpointManifest = {
				id,
				sessionId,
				createdAt: new Date().toISOString(),
				workspaceRoot,
				files: entries,
				baseline,
			};

			await fs.writeFile(path.join(cpDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
			return id;
		} catch {
			return undefined;
		}
	}

	async restoreCheckpoint(workspaceRoot: string, sessionId: string, checkpointId: string): Promise<boolean> {
		const cpDir = path.join(workspaceRoot, '.tarot', 'checkpoints', sessionId, checkpointId);
		const manifestPath = path.join(cpDir, 'manifest.json');

		let manifest: CheckpointManifest;
		try {
			manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as CheckpointManifest;
		} catch {
			vscode.window.showErrorMessage(vscode.l10n.t("Checkpoint '{0}' not found.", checkpointId));
			return false;
		}

		const restoreLabel = vscode.l10n.t('Restore');
		const confirm = await vscode.window.showWarningMessage(
			vscode.l10n.t('Restore workspace files and chat history to the checkpoint from {0}?', new Date(manifest.createdAt).toLocaleTimeString()),
			{ modal: true },
			restoreLabel,
		);
		if (confirm !== restoreLabel) {
			return false;
		}

		// 1. Revert any newly modified tracked files via git checkout if git is available
		const gitPath = await resolveBinaryPath('git');
		const backedUpSet = new Set(manifest.files.map(f => f.relativePath));
		let unrecoverable: string[] = [];
		if (gitPath) {
			const currentDirty = await this.collectDirtyFiles(workspaceRoot);
			for (const rel of currentDirty) {
				if (!backedUpSet.has(rel)) {
					await execSimple(gitPath, ['-C', workspaceRoot, 'checkout', '--', rel]).catch(() => undefined);
				}
			}
		} else if (manifest.baseline) {
			// No git: collectDirtyFiles can't see a clean file the agent edited without opening it
			// in an editor tab. The baseline fingerprint at least tells us WHICH paths changed, but
			// there is no backup to restore them from — report instead of silently leaving them.
			const changed = await this.diffAgainstBaseline(workspaceRoot, manifest.baseline);
			unrecoverable = changed.filter(c => c.status !== 'added' && !backedUpSet.has(c.relativePath)).map(c => c.relativePath);
		}

		// 2. Restore all snapshotted files from checkpoint backup
		const filesDir = path.join(cpDir, 'files');
		for (const entry of manifest.files) {
			const targetAbs = path.join(workspaceRoot, entry.relativePath);
			if (entry.existed && entry.backupName) {
				await fs.mkdir(path.dirname(targetAbs), { recursive: true });
				await fs.copyFile(path.join(filesDir, entry.backupName), targetAbs);
			} else if (!entry.existed) {
				await fs.rm(targetAbs, { force: true }).catch(() => undefined);
			}
		}

		if (unrecoverable.length > 0) {
			vscode.window.showWarningMessage(vscode.l10n.t(
				'Checkpoint restored, but {0} file(s) could not be reverted (no git and no backup for a file that existed before this checkpoint): {1}',
				unrecoverable.length, unrecoverable.join(', '),
			));
		} else {
			vscode.window.showInformationMessage(vscode.l10n.t('Checkpoint restored successfully.'));
		}
		return true;
	}

	/**
	 * Reverts exactly `relativePaths` back to their pre-checkpoint state, leaving every other file
	 * this turn touched untouched. Used by the post-turn `fs_write` approval card — unlike
	 * `restoreCheckpoint`, this has no confirmation dialog (the card itself is the confirmation)
	 * and never touches a path outside the given set.
	 *
	 * A path with no manifest entry is NOT necessarily a brand-new file: `collectDirtyFiles` only
	 * snapshots files that were already dirty (or open+unsaved) *before* the turn, so a file that
	 * was clean and got edited has no backup either — blindly deleting it would be real data loss
	 * (same gap `getCheckpointDiff` already has for its read-only "View changes" diff). `git
	 * checkout` is tried first for exactly this reason; a path git does not know about either falls
	 * through to the baseline fingerprint (no git case): if it was already on disk at checkpoint
	 * time, deleting it would destroy real content with nothing to restore, so it is left alone and
	 * reported in `skipped` instead — only a path confirmed new (absent from both manifest and
	 * baseline) is ever deleted.
	 */
	async restoreCheckpointFiles(workspaceRoot: string, sessionId: string, checkpointId: string, relativePaths: readonly string[]): Promise<RevertFilesResult> {
		const cpDir = path.join(workspaceRoot, '.tarot', 'checkpoints', sessionId, checkpointId);
		const filesDir = path.join(cpDir, 'files');

		let manifest: CheckpointManifest;
		try {
			manifest = JSON.parse(await fs.readFile(path.join(cpDir, 'manifest.json'), 'utf8')) as CheckpointManifest;
		} catch {
			return { reverted: [], skipped: [...relativePaths] };
		}

		const gitPath = await resolveBinaryPath('git');
		const byPath = new Map(manifest.files.map(f => [f.relativePath, f]));
		const baselineByPath = new Map((manifest.baseline ?? []).map(f => [f.relativePath, f]));
		const reverted: string[] = [];
		const skipped: string[] = [];

		for (const rel of relativePaths) {
			const targetAbs = path.join(workspaceRoot, rel);
			const entry = byPath.get(rel);
			if (entry?.existed && entry.backupName) {
				await fs.mkdir(path.dirname(targetAbs), { recursive: true });
				await fs.copyFile(path.join(filesDir, entry.backupName), targetAbs);
				reverted.push(rel);
				continue;
			}
			if (entry && !entry.existed) {
				// Manifest explicitly confirms this path did not exist before the checkpoint.
				await fs.rm(targetAbs, { force: true }).catch(() => undefined);
				reverted.push(rel);
				continue;
			}
			if (gitPath) {
				const result = await execSimple(gitPath, ['-C', workspaceRoot, 'checkout', '--', rel]).catch(() => undefined);
				if (result?.exitCode === 0) {
					reverted.push(rel);
					continue;
				}
			}
			if (baselineByPath.has(rel)) {
				// Existed, unchanged-looking at checkpoint time, no git and no backup: cannot
				// revert safely. Leaving it in place is the only non-destructive option.
				skipped.push(rel);
				continue;
			}
			// Confirmed new by every signal available: safe to delete.
			await fs.rm(targetAbs, { force: true }).catch(() => undefined);
			reverted.push(rel);
		}
		return { reverted, skipped };
	}

	/**
	 * Computes the per-task "View changes" diff: which files changed, were added or deleted
	 * between the pre-task checkpoint snapshot and the current working tree.
	 */
	async getCheckpointDiff(workspaceRoot: string, sessionId: string, checkpointId: string): Promise<CheckpointDiffEntry[]> {
		const cpDir = path.join(workspaceRoot, '.tarot', 'checkpoints', sessionId, checkpointId);
		const filesDir = path.join(cpDir, 'files');

		let manifest: CheckpointManifest;
		try {
			manifest = JSON.parse(await fs.readFile(path.join(cpDir, 'manifest.json'), 'utf8')) as CheckpointManifest;
		} catch {
			return [];
		}

		const entries = new Map<string, CheckpointDiffEntry>();
		const manifestPaths = new Set(manifest.files.map(f => f.relativePath));

		for (const entry of manifest.files) {
			const abs = path.join(workspaceRoot, entry.relativePath);
			const backupAbsPath = entry.backupName ? path.join(filesDir, entry.backupName) : undefined;
			let existsNow = false;
			try {
				existsNow = (await fs.stat(abs)).isFile();
			} catch {
				existsNow = false;
			}

			if (entry.existed && backupAbsPath) {
				if (!existsNow) {
					entries.set(entry.relativePath, { relativePath: entry.relativePath, status: 'deleted', backupAbsPath });
				} else if (!(await filesAreEqual(backupAbsPath, abs))) {
					entries.set(entry.relativePath, { relativePath: entry.relativePath, status: 'modified', backupAbsPath });
				}
			} else if (!entry.existed && existsNow) {
				entries.set(entry.relativePath, { relativePath: entry.relativePath, status: 'added' });
			}
		}

		const currentDirty = await this.collectDirtyFiles(workspaceRoot);
		for (const rel of currentDirty) {
			if (!manifestPaths.has(rel) && !entries.has(rel)) {
				entries.set(rel, { relativePath: rel, status: 'added' });
			}
		}

		if (manifest.baseline) {
			for (const change of await this.diffAgainstBaseline(workspaceRoot, manifest.baseline)) {
				if (!manifestPaths.has(change.relativePath) && !entries.has(change.relativePath)) {
					entries.set(change.relativePath, change);
				}
			}
		}

		return Array.from(entries.values());
	}

	/** Fingerprints every file currently in the workspace (mtime+size, no content) for later `diffAgainstBaseline` comparison. Only meaningful when git is unavailable — see `CheckpointManifest.baseline`. */
	private async scanWorkspaceFingerprint(workspaceRoot: string): Promise<BaselineFileEntry[]> {
		try {
			const uris = await vscode.workspace.findFiles('**/*', WORKSPACE_SCAN_EXCLUDE, WORKSPACE_SCAN_LIMIT);
			const entries: BaselineFileEntry[] = [];
			for (const uri of uris) {
				if (uri.scheme !== 'file' || !uri.fsPath.startsWith(workspaceRoot)) {
					continue;
				}
				try {
					const stat = await fs.stat(uri.fsPath);
					if (stat.isFile()) {
						entries.push({ relativePath: path.relative(workspaceRoot, uri.fsPath), mtimeMs: stat.mtimeMs, size: stat.size });
					}
				} catch {
					// Race between findFiles and stat (file removed mid-scan) — skip it.
				}
			}
			return entries;
		} catch {
			return [];
		}
	}

	/** Compares a fresh workspace scan against a checkpoint's `baseline` to find additions, modifications and deletions a git-less `collectDirtyFiles` cannot see. */
	private async diffAgainstBaseline(workspaceRoot: string, baseline: readonly BaselineFileEntry[]): Promise<CheckpointDiffEntry[]> {
		const baselineByPath = new Map(baseline.map(f => [f.relativePath, f]));
		const current = await this.scanWorkspaceFingerprint(workspaceRoot);
		const currentByPath = new Map(current.map(f => [f.relativePath, f]));
		const changes: CheckpointDiffEntry[] = [];

		for (const file of current) {
			const before = baselineByPath.get(file.relativePath);
			if (!before) {
				changes.push({ relativePath: file.relativePath, status: 'added' });
			} else if (before.mtimeMs !== file.mtimeMs || before.size !== file.size) {
				// Existed and looked clean at checkpoint time: there is no content backup for it.
				changes.push({ relativePath: file.relativePath, status: 'modified' });
			}
		}
		for (const before of baseline) {
			if (!currentByPath.has(before.relativePath)) {
				changes.push({ relativePath: before.relativePath, status: 'deleted' });
			}
		}
		return changes;
	}

	private async collectDirtyFiles(workspaceRoot: string): Promise<string[]> {
		const files = new Set<string>();
		const gitPath = await resolveBinaryPath('git');
		if (gitPath) {
			const res = await execSimple(gitPath, ['-C', workspaceRoot, 'status', '--porcelain']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
			if (res.exitCode === 0 && res.stdout) {
				for (const line of res.stdout.split('\n')) {
					const trimmed = line.slice(3).trim();
					if (trimmed) {
						const cleanPath = trimmed.includes(' -> ') ? trimmed.split(' -> ').pop()!.trim() : trimmed;
						if (!isTarotBookkeepingPath(cleanPath)) {
							files.add(cleanPath);
						}
					}
				}
			}
		}

		// Also include currently open dirty text documents
		for (const doc of vscode.workspace.textDocuments) {
			if (!doc.isUntitled && doc.uri.scheme === 'file' && doc.uri.fsPath.startsWith(workspaceRoot)) {
				const rel = path.relative(workspaceRoot, doc.uri.fsPath);
				if (rel && !isTarotBookkeepingPath(rel)) {
					files.add(rel);
				}
			}
		}

		return Array.from(files).slice(0, 60);
	}
}

async function filesAreEqual(pathA: string, pathB: string): Promise<boolean> {
	try {
		const [bufA, bufB] = await Promise.all([fs.readFile(pathA), fs.readFile(pathB)]);
		return bufA.equals(bufB);
	} catch {
		return false;
	}
}
