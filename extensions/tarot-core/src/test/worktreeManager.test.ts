/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { execSimple, resolveBinaryPath } from '../agents/processRunner';
import { TarotWorktreeManager } from '../git/worktreeManager';

class FailingManifestWorktreeManager extends TarotWorktreeManager {
	protected override async writeManifest(): Promise<void> {
		throw new Error('simulated disk full');
	}
}

describe('worktreeManager.createWorktree', () => {
	it('cleans up worktree and branch if writing the manifest fails (no orphan left behind)', async () => {
		const gitPath = await resolveBinaryPath('git');
		if (!gitPath) {
			return;
		}
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-wt-test-'));
		try {
			await execSimple(gitPath, ['-C', tmp, 'init']);
			await execSimple(gitPath, ['-C', tmp, 'config', 'user.email', 'test@tarot.local']);
			await execSimple(gitPath, ['-C', tmp, 'config', 'user.name', 'Tarot Test']);
			await fs.writeFile(path.join(tmp, 'README.md'), 'hello\n', 'utf8');
			await execSimple(gitPath, ['-C', tmp, 'add', 'README.md']);
			await execSimple(gitPath, ['-C', tmp, 'commit', '-m', 'init']);

			const manager = new FailingManifestWorktreeManager();
			const wt = await manager.createWorktree(tmp, 'task-1');
			assert.equal(wt, undefined);

			const branches = await execSimple(gitPath, ['-C', tmp, 'branch', '--list', 'tarot/worktree-*']);
			assert.equal(branches.stdout.trim(), '', 'orphan worktree branch should have been deleted');

			const listed = await manager.listWorktrees(tmp);
			assert.equal(listed.length, 0);

			const wtDir = path.join(tmp, '.tarot', 'worktrees');
			const entries = await fs.readdir(wtDir).catch(() => []);
			assert.equal(entries.length, 0, 'orphan worktree directory should have been removed');
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
