/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface TaskCheckpointRecord {
	readonly sessionId: string;
	readonly checkpointId: string;
	readonly createdAt: string;
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

/** Records the pre-task checkpoint taken right before a Spec task ran, keyed by its `numberLabel`. */
export async function recordTaskCheckpoint(specDir: string, taskKey: string, record: TaskCheckpointRecord): Promise<void> {
	const all = await readAll(specDir);
	all[taskKey] = record;
	await fs.writeFile(sidecarPath(specDir), JSON.stringify(all, null, 2), 'utf8');
}

export async function readTaskCheckpoint(specDir: string, taskKey: string): Promise<TaskCheckpointRecord | undefined> {
	const all = await readAll(specDir);
	return all[taskKey];
}
