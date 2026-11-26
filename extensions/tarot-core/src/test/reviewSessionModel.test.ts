/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	advanceReviewFile,
	createReviewSessionState,
	getActiveReviewFile,
	removeReviewFile,
	selectReviewFile,
} from '../review/reviewSessionModel';

describe('reviewSessionModel (M6.1 Cursor-Style Diff Review)', () => {
	it('returns undefined when no files changed and deduplicates normalized paths', () => {
		assert.equal(createReviewSessionState('/ws', 's1', 'cp1', []), undefined);
		const state = createReviewSessionState('/ws', 's1', 'cp1', [
			{ relativePath: 'src\\a.ts', status: 'modified', backupAbsPath: '/tmp/a.bak' },
			{ relativePath: 'src/a.ts', status: 'modified', backupAbsPath: '/tmp/a.bak' },
			{ relativePath: 'src/b.ts', status: 'added' },
		]);
		assert.ok(state);
		assert.equal(state.pending.length, 2);
		assert.equal(getActiveReviewFile(state)?.relativePath, 'src/a.ts');
	});

	it('advances cyclically and selects specific files', () => {
		let state = createReviewSessionState('/ws', 's1', 'cp1', [
			{ relativePath: 'a.ts', status: 'modified' },
			{ relativePath: 'b.ts', status: 'added' },
			{ relativePath: 'c.ts', status: 'modified' },
		]);
		state = advanceReviewFile(state);
		assert.equal(getActiveReviewFile(state)?.relativePath, 'b.ts');
		state = advanceReviewFile(state);
		assert.equal(getActiveReviewFile(state)?.relativePath, 'c.ts');
		state = advanceReviewFile(state);
		assert.equal(getActiveReviewFile(state)?.relativePath, 'a.ts');
		state = selectReviewFile(state, 'c.ts');
		assert.equal(getActiveReviewFile(state)?.relativePath, 'c.ts');
	});

	it('removes accepted/rejected files and clears state when last file is resolved', () => {
		let state = createReviewSessionState('/ws', 's1', 'cp1', [
			{ relativePath: 'a.ts', status: 'modified' },
			{ relativePath: 'b.ts', status: 'added' },
		]);
		state = removeReviewFile(state, 'a.ts');
		assert.ok(state);
		assert.equal(state.pending.length, 1);
		assert.equal(getActiveReviewFile(state)?.relativePath, 'b.ts');

		state = removeReviewFile(state, 'b.ts');
		assert.equal(state, undefined);
	});
});
