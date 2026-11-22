/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { SpecTask } from './taskParser';

export interface TaskWave {
	readonly index: number;
	readonly tasks: readonly SpecTask[];
}

export interface TaskGraphOptions {
	/** When `false` (default), tasks with the Kiro `*` optional marker are left out of every wave. */
	readonly includeOptional?: boolean;
}

/**
 * Groups incomplete, eligible tasks from `tasks.md` into dependency-ordered waves: Wave 1 holds
 * every task whose `_Depends:_` refs are already satisfied (completed, or skipped-optional),
 * Wave 2 the ones satisfied once Wave 1 finishes, and so on (Kahn's algorithm).
 */
export function computeTaskWaves(tasks: readonly SpecTask[], options?: TaskGraphOptions): TaskWave[] {
	const includeOptional = options?.includeOptional ?? false;
	const skipped = new Set<string>();
	for (const task of tasks) {
		if (task.numberLabel && (task.completed || (task.optional && !includeOptional))) {
			skipped.add(task.numberLabel);
		}
	}

	let remaining = tasks.filter(t => !t.completed && (includeOptional || !t.optional));
	const satisfied = new Set(skipped);
	const waves: TaskWave[] = [];

	while (remaining.length > 0) {
		const wave = remaining.filter(t => t.dependsOn.every(dep => satisfied.has(dep)));
		if (wave.length === 0) {
			// Unsatisfiable dependency (typo or cycle): surface the rest as a final wave
			// instead of looping forever, so the caller can still report/execute something.
			waves.push({ index: waves.length + 1, tasks: remaining });
			break;
		}
		waves.push({ index: waves.length + 1, tasks: wave });
		for (const t of wave) {
			if (t.numberLabel) {
				satisfied.add(t.numberLabel);
			}
		}
		const waveSet = new Set(wave);
		remaining = remaining.filter(t => !waveSet.has(t));
	}

	return waves;
}
