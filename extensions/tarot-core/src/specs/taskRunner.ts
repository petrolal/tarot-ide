/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { computeTaskWaves, TaskGraphOptions } from './taskGraph';
import { SpecTask } from './taskParser';

export type TaskRunStatus = 'succeeded' | 'failed' | 'skipped';

export interface TaskRunResult {
	readonly task: SpecTask;
	readonly status: TaskRunStatus;
}

export interface RunAllTasksOptions extends TaskGraphOptions {
	/** How many tasks of the same wave may run at once. Defaults to 1 (sequential). */
	readonly concurrency?: number;
}

export interface RunAllTasksSummary {
	readonly waveCount: number;
	readonly results: readonly TaskRunResult[];
}

/**
 * Runs `Run all Tasks`: builds dependency waves (see `taskGraph`), then executes each wave in
 * order, skipping a task whose `_Depends:_` dependency failed instead of blocking the whole run.
 */
export async function runTaskWaves(
	tasks: readonly SpecTask[],
	execute: (task: SpecTask) => Promise<boolean>,
	options?: RunAllTasksOptions,
): Promise<RunAllTasksSummary> {
	const waves = computeTaskWaves(tasks, options);
	const concurrency = Math.max(1, options?.concurrency ?? 1);
	const failedLabels = new Set<string>();
	const results: TaskRunResult[] = [];

	for (const wave of waves) {
		let cursor = 0;
		async function worker(): Promise<void> {
			while (cursor < wave.tasks.length) {
				const task = wave.tasks[cursor++];
				if (task.dependsOn.some(dep => failedLabels.has(dep))) {
					results.push({ task, status: 'skipped' });
					if (task.numberLabel) {
						failedLabels.add(task.numberLabel);
					}
					continue;
				}
				const success = await execute(task);
				results.push({ task, status: success ? 'succeeded' : 'failed' });
				if (!success && task.numberLabel) {
					failedLabels.add(task.numberLabel);
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(concurrency, wave.tasks.length) }, () => worker()));
	}

	return { waveCount: waves.length, results };
}
