/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { WorkflowRunState } from './workflowTypes';

/**
 * Persists workflow run state & node-boundary checkpoints under `.tarot/workflows/runs/<runId>.json`
 * so paused or interrupted runs can resume cleanly after an IDE restart (MIGRATION_PLAN.md M3.9a).
 * Pure Node.js — no `vscode` import so it stays unit-testable.
 */
export class TarotWorkflowRunStore {
	getRunsDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'workflows', 'runs');
	}

	async saveRun(workspaceRoot: string, run: WorkflowRunState): Promise<void> {
		const dir = this.getRunsDir(workspaceRoot);
		await fs.mkdir(dir, { recursive: true });
		run.updatedAt = new Date().toISOString();
		const filePath = path.join(dir, `${run.id}.json`);
		await fs.writeFile(filePath, JSON.stringify(run, null, 2), 'utf8');
	}

	async loadRun(workspaceRoot: string, runId: string): Promise<WorkflowRunState | undefined> {
		const filePath = path.join(this.getRunsDir(workspaceRoot), `${runId}.json`);
		try {
			const raw = await fs.readFile(filePath, 'utf8');
			return JSON.parse(raw) as WorkflowRunState;
		} catch {
			return undefined;
		}
	}

	async listRuns(workspaceRoot: string): Promise<WorkflowRunState[]> {
		const dir = this.getRunsDir(workspaceRoot);
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const runs: WorkflowRunState[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) {
				continue;
			}
			try {
				const parsed = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')) as WorkflowRunState;
				if (parsed && typeof parsed.id === 'string' && typeof parsed.recipeName === 'string') {
					runs.push(parsed);
				}
			} catch {
				// Skip corrupt run file
			}
		}
		return runs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
	}
}
