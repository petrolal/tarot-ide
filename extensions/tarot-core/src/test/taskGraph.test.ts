/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeTaskWaves } from '../specs/taskGraph';
import { parseTasksMarkdown } from '../specs/taskParser';

describe('taskGraph', () => {
	it('puts independent tasks in Wave 1 and dependents in later waves', () => {
		const md = [
			'# Tasks',
			'- [ ] 1. Define contracts',
			'- [ ] 2. Implement service',
			'  _Depends: 1_',
			'- [ ] 3. Write integration tests',
			'  _Depends: 1, 2_',
		].join('\n');

		const { tasks } = parseTasksMarkdown(md);
		const waves = computeTaskWaves(tasks);

		assert.equal(waves.length, 3);
		assert.deepEqual(waves[0].tasks.map(t => t.numberLabel), ['1']);
		assert.deepEqual(waves[1].tasks.map(t => t.numberLabel), ['2']);
		assert.deepEqual(waves[2].tasks.map(t => t.numberLabel), ['3']);
	});

	it('skips completed and optional tasks by default, but still satisfies dependents', () => {
		const md = [
			'# Tasks',
			'- [x] 1. Define contracts',
			'- [ ] 2. *Write optional docs',
			'  _Depends: 1_',
			'- [ ] 3. Implement service',
			'  _Depends: 1_',
			'- [ ] 4. Finalize',
			'  _Depends: 2, 3_',
		].join('\n');

		const { tasks } = parseTasksMarkdown(md);
		const waves = computeTaskWaves(tasks, { includeOptional: false });

		// Task 2 is optional and skipped; task 1 is already completed; task 3 only depends on 1
		// (satisfied), so it lands in Wave 1. Task 4 depends on 2 (skipped/treated as satisfied)
		// and 3, so it waits for Wave 2.
		assert.equal(waves.length, 2);
		assert.deepEqual(waves[0].tasks.map(t => t.numberLabel), ['3']);
		assert.deepEqual(waves[1].tasks.map(t => t.numberLabel), ['4']);
	});

	it('includes optional tasks and treats them as regular dependencies when requested', () => {
		const md = [
			'# Tasks',
			'- [ ] 1. *Optional setup',
			'- [ ] 2. Depends on optional',
			'  _Depends: 1_',
		].join('\n');

		const { tasks } = parseTasksMarkdown(md);
		const waves = computeTaskWaves(tasks, { includeOptional: true });

		assert.equal(waves.length, 2);
		assert.deepEqual(waves[0].tasks.map(t => t.numberLabel), ['1']);
		assert.deepEqual(waves[1].tasks.map(t => t.numberLabel), ['2']);
	});

	it('falls back to a single final wave on an unsatisfiable dependency instead of looping', () => {
		const md = [
			'# Tasks',
			'- [ ] 1. Needs a ghost task',
			'  _Depends: 99_',
		].join('\n');

		const { tasks } = parseTasksMarkdown(md);
		const waves = computeTaskWaves(tasks);

		assert.equal(waves.length, 1);
		assert.equal(waves[0].tasks.length, 1);
	});
});
