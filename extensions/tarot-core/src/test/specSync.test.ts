/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeTasksMarkdown } from '../specs/specSync';

describe('specSync', () => {
	it('re-checks a regenerated task that matches a previously completed one by title', () => {
		const previous = [
			'# Tasks',
			'- [x] 1. Define contracts',
			'- [ ] 2. Implement service',
		].join('\n');
		const regenerated = [
			'# Tasks',
			'- [ ] 1. Define contracts',
			'- [ ] 2. Implement service',
			'- [ ] 3. Add docs',
		].join('\n');

		const merged = mergeTasksMarkdown(previous, regenerated);
		assert.match(merged.content, /- \[x\] 1\. Define contracts/);
		assert.match(merged.content, /- \[ \] 2\. Implement service/);
		assert.match(merged.content, /- \[ \] 3\. Add docs/);
		assert.equal(merged.preservedCompletedCount, 0);
	});

	it('appends previously completed tasks that vanished from the regeneration instead of dropping them', () => {
		const previous = [
			'# Tasks',
			'- [x] 1. Define contracts',
			'- [x] 2. Old scope, now removed',
		].join('\n');
		const regenerated = [
			'# Tasks',
			'- [ ] 1. Define contracts',
			'- [ ] 2. New scope entirely',
		].join('\n');

		const merged = mergeTasksMarkdown(previous, regenerated);
		assert.equal(merged.preservedCompletedCount, 1);
		assert.match(merged.content, /Preserved Completed Tasks/);
		assert.match(merged.content, /- \[x\] 2\. Old scope, now removed/);
	});
});
