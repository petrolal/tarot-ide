/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTasksMarkdown } from '../specs/taskParser';
import { runTaskWaves } from '../specs/taskRunner';

describe('taskRunner', () => {
	it('runs tasks wave by wave, respecting dependency order', async () => {
		const md = [
			'# Tasks',
			'- [ ] 1. Define contracts',
			'- [ ] 2. Implement service',
			'  _Depends: 1_',
		].join('\n');
		const { tasks } = parseTasksMarkdown(md);

		const executionOrder: string[] = [];
		const summary = await runTaskWaves(tasks, async task => {
			executionOrder.push(task.numberLabel!);
			return true;
		});

		assert.equal(summary.waveCount, 2);
		assert.deepEqual(executionOrder, ['1', '2']);
		assert.deepEqual(summary.results.map(r => r.status), ['succeeded', 'succeeded']);
	});

	it('skips a dependent task when its dependency fails, without aborting the whole run', async () => {
		const md = [
			'# Tasks',
			'- [ ] 1. Flaky setup',
			'- [ ] 2. Depends on setup',
			'  _Depends: 1_',
			'- [ ] 3. Independent task',
		].join('\n');
		const { tasks } = parseTasksMarkdown(md);

		const summary = await runTaskWaves(tasks, async task => task.numberLabel !== '1');

		const byLabel = new Map(summary.results.map(r => [r.task.numberLabel, r.status]));
		assert.equal(byLabel.get('1'), 'failed');
		assert.equal(byLabel.get('2'), 'skipped');
		assert.equal(byLabel.get('3'), 'succeeded');
	});

	it('excludes optional tasks unless includeOptional is set', async () => {
		const md = [
			'# Tasks',
			'- [ ] 1. *Optional extra',
			'- [ ] 2. Mandatory task',
		].join('\n');
		const { tasks } = parseTasksMarkdown(md);

		const executed: string[] = [];
		await runTaskWaves(tasks, async task => {
			executed.push(task.numberLabel!);
			return true;
		});

		assert.deepEqual(executed, ['2']);
	});
});
