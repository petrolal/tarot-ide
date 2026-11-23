/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface TaskCheckpointRecord {
	readonly sessionId: string;
	readonly checkpointId: string;
	readonly createdAt: string;
}

/**
 * Computes a stable checkpoint key for a Spec task. Numbered tasks keep their explicit
 * `numberLabel` (e.g. `"2.1"`). Unnumbered tasks are keyed by a short SHA-1 of their normalized
 * title instead of their array position (`task.index`), so inserting or reordering tasks in
 * `tasks.md` never collides with or overwrites another task's recorded checkpoint.
 */
export function computeTaskCheckpointKey(task: { readonly numberLabel?: string; readonly title: string }): string {
	if (task.numberLabel && task.numberLabel.trim().length > 0) {
		return task.numberLabel.trim();
	}
	const normalized = task.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
	return `title:${hash}`;
}

function sidecarPath(specDir: string): string {
	return path.join(specDir, '.task-checkpoints.json');
}

async function readAll(specDir: string): Promise<Record<string, TaskCheckpointRecord>> {
	try {
		const raw = await fs.readFile(sidecarPath(specDir), 'utf8');
		return JSON.parse(raw) as Record<string, TaskCheckpointRecord>;
	} catch {
		return {};
	}
}

/** Records the pre-task checkpoint taken right before a Spec task ran, keyed by `computeTaskCheckpointKey`. */
export async function recordTaskCheckpoint(specDir: string, taskKey: string, record: TaskCheckpointRecord): Promise<void> {
	const all = await readAll(specDir);
	all[taskKey] = record;
	await fs.writeFile(sidecarPath(specDir), JSON.stringify(all, null, 2), 'utf8');
}

export async function readTaskCheckpoint(specDir: string, taskKey: string, legacyFallbackKey?: string): Promise<TaskCheckpointRecord | undefined> {
	const all = await readAll(specDir);
	return all[taskKey] ?? (legacyFallbackKey ? all[legacyFallbackKey] : undefined);
}
