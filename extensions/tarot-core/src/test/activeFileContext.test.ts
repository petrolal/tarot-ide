/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	buildAutoActiveFileAttachment,
	buildAutoActiveFileChip,
	formatActiveFileLabel,
	isAutoContextEligiblePath,
} from '../context/activeFileContext';

describe('activeFileContext (M6.1b Auto Current File Chip)', () => {
	it('formats file labels with single-line and multi-line selections', () => {
		assert.equal(formatActiveFileLabel('src/index.js'), 'src/index.js');
		assert.equal(formatActiveFileLabel('src/index.js', 12, 12), 'src/index.js (L12)');
		assert.equal(formatActiveFileLabel('src/index.js', 12, 28), 'src/index.js (L12-L28)');
	});

	it('excludes Tarot internal session/checkpoint bookkeeping paths', () => {
		assert.equal(isAutoContextEligiblePath('.tarot/sessions/abc.json'), false);
		assert.equal(isAutoContextEligiblePath('.tarot/checkpoints/s1/cp1/manifest.json'), false);
		assert.equal(isAutoContextEligiblePath('.tarot/specs/demo/design.md'), true);
		assert.equal(isAutoContextEligiblePath('index.js'), true);
	});

	it('builds chip and attachment for active file and deduplicates against manual attachments', () => {
		const snap = {
			fsPath: '/ws/src/app.ts',
			relativePath: 'src/app.ts',
			content: 'export const x = 1;\n',
		};
		const chip = buildAutoActiveFileChip(snap, []);
		assert.deepEqual(chip, { label: 'src/app.ts', relativePath: 'src/app.ts', hasSelection: false });

		const att = buildAutoActiveFileAttachment(snap, []);
		assert.ok(att);
		assert.equal(att.kind, 'file');
		assert.equal(att.path, '/ws/src/app.ts');
		assert.equal(att.content, 'export const x = 1;\n');

		// Manual attachment for same file suppresses duplicate auto chip/attachment
		const manual = [{ kind: 'file' as const, label: 'src/app.ts', path: '/ws/src/app.ts', content: 'export const x = 1;\n' }];
		assert.equal(buildAutoActiveFileChip(snap, manual), undefined);
		assert.equal(buildAutoActiveFileAttachment(snap, manual), undefined);
	});

	it('prefers selection text over full file content when a selection is active', () => {
		const snap = {
			fsPath: '/ws/src/app.ts',
			relativePath: 'src/app.ts',
			content: 'line1\nline2\nline3\n',
			selectionText: 'line2',
			selectionStartLine: 2,
			selectionEndLine: 2,
		};
		const att = buildAutoActiveFileAttachment(snap, []);
		assert.ok(att);
		assert.equal(att.label, 'src/app.ts (L2)');
		assert.equal(att.selection, 'line2');
		assert.equal(att.content, undefined);
	});
});
