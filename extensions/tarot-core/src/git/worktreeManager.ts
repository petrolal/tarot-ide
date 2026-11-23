/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';

export interface TarotWorktree {
	readonly id: string;
	readonly path: string;
	readonly branch: string;
	readonly baseRef: string;
}

interface WorktreeManifest {
	readonly id: string;
	readonly branch: string;
	readonly baseRef: string;
}

function manifestPath(worktreePath: string): string {
	return path.join(worktreePath, '.tarot-worktree.json');
}

/**
 * Lightweight, optional isolation for parallel Spec tasks (M3.6.7) and parallel sessions /
 * side-by-side prototyping (M3.8c, M3.9a): each worktree is a disposable checkout on its own
 * branch, so parallel work never collides on the same files in the main working tree.
 */
export class TarotWorktreeManager {
	async createWorktree(workspaceRoot: string, label: string): Promise<TarotWorktree | undefined> {
		const gitPath = await resolveBinaryPath('git');
		if (!gitPath) {
			return undefined;
		}

		const headRes = await execSimple(gitPath, ['-C', workspaceRoot, 'rev-parse', 'HEAD']).catch(() => undefined);
		const baseRef = headRes?.exitCode === 0 ? headRes.stdout.trim() : undefined;
		if (!baseRef) {
			return undefined;
		}

		const id = `${label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`;
		const branch = `tarot/worktree-${id}`;
		const worktreePath = path.join(workspaceRoot, '.tarot', 'worktrees', id);

		const createRes = await execSimple(gitPath, ['-C', workspaceRoot, 'worktree', 'add', '-b', branch, worktreePath, baseRef], 30_000).catch(() => undefined);
		if (!createRes || createRes.exitCode !== 0) {
			return undefined;
		}

		const manifest: WorktreeManifest = { id, branch, baseRef };
		await fs.writeFile(manifestPath(worktreePath), JSON.stringify(manifest, null, 2), 'utf8').catch(() => undefined);

		return { id, path: worktreePath, branch, baseRef };
	}

	async listWorktrees(workspaceRoot: string): Promise<TarotWorktree[]> {
		const root = path.join(workspaceRoot, '.tarot', 'worktrees');
		let dirs: string[] = [];
		try {
			dirs = (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
		} catch {
			return [];
		}

		const worktrees: TarotWorktree[] = [];
		for (const id of dirs) {
			const worktreePath = path.join(root, id);
			try {
				const manifest = JSON.parse(await fs.readFile(manifestPath(worktreePath), 'utf8')) as WorktreeManifest;
				worktrees.push({ id: manifest.id, path: worktreePath, branch: manifest.branch, baseRef: manifest.baseRef });
			} catch {
				// Not a Tarot-managed worktree directory; skip.
			}
		}
		return worktrees;
	}

	/**
	 * Copies every file that differs between the worktree's base ref and its current working
	 * tree back into `workspaceRoot`. Uses a plain copy (like `checkpointService`'s restore)
	 * rather than `git merge`, so it never produces conflict markers.
	 *
	 * `git diff --name-status <baseRef>` alone only reports **tracked** files — a brand new file
	 * the agent created (the common case: implementing a task from scratch) is untracked and
	 * invisible to it, so `git status --porcelain` is also consulted to catch those. `shouldApply`
	 * lets the caller veto copying a specific path (e.g. a hard `fs_write` deny rule) without this
	 * module needing to depend on the permissions engine itself.
	 */
	async applyWorktree(workspaceRoot: string, worktree: TarotWorktree, shouldApply?: (relativePath: string) => Promise<boolean>): Promise<boolean> {
		const gitPath = await resolveBinaryPath('git');
		if (!gitPath) {
			return false;
		}

		const changes = new Map<string, 'modified' | 'deleted'>();

		const diffRes = await execSimple(gitPath, ['-C', worktree.path, 'diff', '--name-status', worktree.baseRef]).catch(() => undefined);
		if (diffRes?.exitCode === 0) {
			for (const line of diffRes.stdout.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				const [status, ...rest] = trimmed.split('\t');
				const relativePath = rest[rest.length - 1];
				if (relativePath) {
					changes.set(relativePath, status.startsWith('D') ? 'deleted' : 'modified');
				}
			}
		}

		const statusRes = await execSimple(gitPath, ['-C', worktree.path, 'status', '--porcelain']).catch(() => undefined);
		if (statusRes?.exitCode === 0) {
			for (const line of statusRes.stdout.split('\n')) {
				const trimmed = line.slice(3).trim();
				if (trimmed && !changes.has(trimmed)) {
					changes.set(trimmed, 'modified');
				}
			}
		}

		if (diffRes?.exitCode !== 0 && statusRes?.exitCode !== 0) {
			return false;
		}

		for (const [relativePath, kind] of changes) {
			if (shouldApply && !(await shouldApply(relativePath))) {
				continue;
			}
			const targetAbs = path.join(workspaceRoot, relativePath);
			if (kind === 'deleted') {
				await fs.rm(targetAbs, { force: true }).catch(() => undefined);
			} else {
				await fs.mkdir(path.dirname(targetAbs), { recursive: true });
				await fs.copyFile(path.join(worktree.path, relativePath), targetAbs).catch(() => undefined);
			}
		}

		return true;
	}

	async discardWorktree(workspaceRoot: string, worktree: TarotWorktree): Promise<void> {
		const gitPath = await resolveBinaryPath('git');
		if (!gitPath) {
			return;
		}
		await execSimple(gitPath, ['-C', workspaceRoot, 'worktree', 'remove', '--force', worktree.path], 15_000).catch(() => undefined);
		await execSimple(gitPath, ['-C', workspaceRoot, 'branch', '-D', worktree.branch]).catch(() => undefined);
	}
}
