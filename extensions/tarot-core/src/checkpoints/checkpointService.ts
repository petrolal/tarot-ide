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

interface CheckpointManifest {
	readonly id: string;
	readonly sessionId: string;
	readonly createdAt: string;
	readonly workspaceRoot: string;
	readonly files: readonly CheckpointFileEntry[];
}

export interface CheckpointDiffEntry {
	readonly relativePath: string;
	readonly status: 'added' | 'modified' | 'deleted';
	/** Absolute path to the pre-checkpoint backup on disk; absent for freshly `added` files. */
	readonly backupAbsPath?: string;
}

export class TarotCheckpointService {
	/**
	 * Captures a lightweight snapshot of currently modified/untracked files before an agent turn
	 * so the user can restore to this point in 1 click without losing chat history.
	 */
	async createCheckpoint(workspaceRoot: string, sessionId: string): Promise<string | undefined> {
		const id = `cp-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
		const cpDir = path.join(workspaceRoot, '.tarot', 'checkpoints', sessionId, id);
		const filesDir = path.join(cpDir, 'files');

		try {
			await fs.mkdir(filesDir, { recursive: true });
			const candidateFiles = await this.collectDirtyFiles(workspaceRoot);
			const entries: CheckpointFileEntry[] = [];

			for (let i = 0; i < candidateFiles.length; i++) {
				const rel = candidateFiles[i];
				const abs = path.join(workspaceRoot, rel);
				try {
					const stat = await fs.stat(abs);
					if (stat.isFile() && stat.size <= 2 * 1024 * 1024) {
						const backupName = `f_${i}.bak`;
						await fs.copyFile(abs, path.join(filesDir, backupName));
						entries.push({ relativePath: rel, existed: true, backupName });
					}
				} catch {
					entries.push({ relativePath: rel, existed: false });
				}
			}

			const manifest: CheckpointManifest = {
				id,
				sessionId,
				createdAt: new Date().toISOString(),
				workspaceRoot,
				files: entries,
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
			vscode.l10n.t('Restore the workspace files to the checkpoint from {0}? (Chat history will be preserved.)', new Date(manifest.createdAt).toLocaleTimeString()),
			{ modal: true },
			restoreLabel,
		);
		if (confirm !== restoreLabel) {
			return false;
		}

		// 1. Revert any newly modified tracked files via git checkout if git is available
		const gitPath = await resolveBinaryPath('git');
		if (gitPath) {
			const currentDirty = await this.collectDirtyFiles(workspaceRoot);
			const backedUpSet = new Set(manifest.files.map(f => f.relativePath));
			for (const rel of currentDirty) {
				if (!backedUpSet.has(rel)) {
					await execSimple(gitPath, ['-C', workspaceRoot, 'checkout', '--', rel]).catch(() => undefined);
				}
			}
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

		vscode.window.showInformationMessage(vscode.l10n.t('Checkpoint restored successfully (history preserved).'));
		return true;
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

		return Array.from(entries.values());
	}

	private async collectDirtyFiles(workspaceRoot: string): Promise<string[]> {
		const files = new Set<string>();
		const gitPath = await resolveBinaryPath('git');
		if (gitPath) {
			const res = await execSimple(gitPath, ['-C', workspaceRoot, 'status', '--porcelain']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
			if (res.exitCode === 0 && res.stdout) {
				for (const line of res.stdout.split('\n')) {
					const trimmed = line.slice(3).trim();
					if (trimmed && !trimmed.startsWith('.tarot/')) {
						const cleanPath = trimmed.includes(' -> ') ? trimmed.split(' -> ').pop()!.trim() : trimmed;
						files.add(cleanPath);
					}
				}
			}
		}

		// Also include currently open dirty text documents
		for (const doc of vscode.workspace.textDocuments) {
			if (!doc.isUntitled && doc.uri.scheme === 'file' && doc.uri.fsPath.startsWith(workspaceRoot)) {
				const rel = path.relative(workspaceRoot, doc.uri.fsPath);
				if (rel && !rel.startsWith('.tarot')) {
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
