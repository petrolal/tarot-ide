/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	applyAcceptHunk,
	applyRejectHunk,
	buildInlineDiffPreviewHunks,
	computeDiffHunks,
	countDiffStats,
	parsePorcelainStatusLine,
} from '../review/diffHunkEngine';

describe('diffHunkEngine (Cursor-style per-hunk Accept / Reject)', () => {
	it('returns empty hunks for identical texts', () => {
		const text = 'line 1\nline 2\nline 3\n';
		assert.deepEqual(computeDiffHunks(text, text), []);
	});

	it('detects multiple disjoint hunks with accurate line indices and stats', () => {
		const before = 'a\nb\nc\nd\ne\nf\ng\n';
		const after = 'a\nB_NEW\nc\nd\ne\nF1\nF2\ng\n';
		const hunks = computeDiffHunks(before, after);
		assert.equal(hunks.length, 2);

		assert.equal(hunks[0].oldStart, 1);
		assert.equal(hunks[0].oldCount, 1);
		assert.equal(hunks[0].newStart, 1);
		assert.equal(hunks[0].newCount, 1);
		assert.deepEqual(hunks[0].oldLines, ['b']);
		assert.deepEqual(hunks[0].newLines, ['B_NEW']);

		assert.equal(hunks[1].oldStart, 5);
		assert.equal(hunks[1].oldCount, 1);
		assert.equal(hunks[1].newStart, 5);
		assert.equal(hunks[1].newCount, 2);
		assert.deepEqual(hunks[1].oldLines, ['f']);
		assert.deepEqual(hunks[1].newLines, ['F1', 'F2']);

		assert.deepEqual(countDiffStats(hunks), { added: 3, removed: 2 });
	});

	it('rejects a single hunk without disturbing other hunks', () => {
		const before = 'a\nb\nc\nd\ne\n';
		const after = 'a\nB_MOD\nc\nd\nE_MOD\n';
		const hunks = computeDiffHunks(before, after);
		assert.equal(hunks.length, 2);

		// Reject only the first hunk
		const afterRejectFirst = applyRejectHunk(after, hunks[0]);
		assert.equal(afterRejectFirst, 'a\nb\nc\nd\nE_MOD\n');

		// Remaining diff should have only the second hunk
		const remaining = computeDiffHunks(before, afterRejectFirst);
		assert.equal(remaining.length, 1);
		assert.deepEqual(remaining[0].newLines, ['E_MOD']);
	});

	it('accepts a single hunk by advancing beforeText so that hunk disappears', () => {
		const before = 'a\nb\nc\nd\ne\n';
		const after = 'a\nB_MOD\nc\nd\nE_MOD\n';
		const hunks = computeDiffHunks(before, after);
		assert.equal(hunks.length, 2);

		// Accept only the first hunk
		const nextBefore = applyAcceptHunk(before, hunks[0]);
		assert.equal(nextBefore, 'a\nB_MOD\nc\nd\ne\n');

		// Remaining diff should have only the second hunk
		const remaining = computeDiffHunks(nextBefore, after);
		assert.equal(remaining.length, 1);
		assert.deepEqual(remaining[0].newLines, ['E_MOD']);

		// Accept the remaining hunk -> zero hunks left
		const finalBefore = applyAcceptHunk(nextBefore, remaining[0]);
		assert.deepEqual(computeDiffHunks(finalBefore, after), []);
	});

	it('handles pure insertion (newly created file) and pure deletion', () => {
		const addedHunks = computeDiffHunks('', 'hello\nworld\n');
		assert.equal(addedHunks.length, 1);
		assert.equal(addedHunks[0].oldCount, 0);
		assert.equal(addedHunks[0].newCount, 2);
		assert.equal(applyRejectHunk('hello\nworld\n', addedHunks[0]), '');

		const deletedHunks = computeDiffHunks('old1\nold2\n', '');
		assert.equal(deletedHunks.length, 1);
		assert.equal(deletedHunks[0].oldCount, 2);
		assert.equal(deletedHunks[0].newCount, 0);
		assert.equal(applyRejectHunk('', deletedHunks[0]), 'old1\nold2\n');
	});

	it('builds compact inline diff preview hunks with context lines for chat cards', () => {
		const before = 'l1\nl2\nl3\nold\nl5\nl6\n';
		const after = 'l1\nl2\nl3\nnew1\nnew2\nl5\nl6\n';
		const previews = buildInlineDiffPreviewHunks(before, after, 1, 20);
		assert.equal(previews.length, 1);
		assert.deepEqual(previews[0].lines, [
			{ kind: 'context', text: 'l3' },
			{ kind: 'del', text: 'old' },
			{ kind: 'add', text: 'new1' },
			{ kind: 'add', text: 'new2' },
			{ kind: 'context', text: 'l5' },
		]);
	});
});

describe('parsePorcelainStatusLine (Git checkpoint diff classification)', () => {
	it('classifies clean tracked edits as modified, not added', () => {
		assert.deepEqual(parsePorcelainStatusLine(' M src/app.ts'), { relativePath: 'src/app.ts', status: 'modified' });
		assert.deepEqual(parsePorcelainStatusLine('MM src/app.ts'), { relativePath: 'src/app.ts', status: 'modified' });
		assert.deepEqual(parsePorcelainStatusLine('M  src/app.ts'), { relativePath: 'src/app.ts', status: 'modified' });
	});

	it('classifies untracked and staged-added files as added', () => {
		assert.deepEqual(parsePorcelainStatusLine('?? src/new/file.ts'), { relativePath: 'src/new/file.ts', status: 'added' });
		assert.deepEqual(parsePorcelainStatusLine('A  src/staged.ts'), { relativePath: 'src/staged.ts', status: 'added' });
		assert.deepEqual(parsePorcelainStatusLine('AM src/staged.ts'), { relativePath: 'src/staged.ts', status: 'added' });
	});

	it('classifies deletions, renames, quoted paths, and skips directory markers', () => {
		assert.deepEqual(parsePorcelainStatusLine(' D src/old.ts'), { relativePath: 'src/old.ts', status: 'deleted' });
		assert.deepEqual(parsePorcelainStatusLine('R  old.ts -> new.ts'), { relativePath: 'new.ts', status: 'modified' });
		assert.deepEqual(parsePorcelainStatusLine('?? "dir with spaces/a.ts"'), { relativePath: 'dir with spaces/a.ts', status: 'added' });
		assert.equal(parsePorcelainStatusLine('?? new-dir/'), undefined);
	});
});
