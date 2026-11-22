/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkCommandLineLength } from '../agents/commandLineLimits';

describe('commandLineLimits.checkCommandLineLength', () => {
	it('is ok for a short, ordinary agent invocation', () => {
		const check = checkCommandLineLength('/usr/bin/claude', ['-p', 'Fix the bug', '--output-format', 'stream-json'], 'linux');
		assert.equal(check.ok, true);
	});

	it('uses a much tighter ceiling on win32 than on POSIX', () => {
		const args = ['--print=' + 'x'.repeat(40_000)];
		assert.equal(checkCommandLineLength('C:\\agy.exe', args, 'win32').ok, false);
		assert.equal(checkCommandLineLength('/usr/bin/agy', args, 'linux').ok, true);
	});

	it('flags a prompt large enough to exceed even the generous POSIX ceiling', () => {
		const args = ['-p', 'x'.repeat(500_000)];
		const check = checkCommandLineLength('/usr/bin/claude', args, 'linux');
		assert.equal(check.ok, false);
		assert.ok(check.totalChars > check.limit);
	});
});
