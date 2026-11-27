/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPathInsideRoot } from '../checkpoints/pathGuard';

describe('pathGuard.isPathInsideRoot', () => {
	it('accepts the root itself and nested paths', () => {
		assert.equal(isPathInsideRoot('/home/user/app', '/home/user/app'), true);
		assert.equal(isPathInsideRoot('/home/user/app/src/a.ts', '/home/user/app'), true);
	});

	it('rejects a sibling directory that merely shares the root as a string prefix (TD-05)', () => {
		assert.equal(isPathInsideRoot('/home/user/app-staging/config.ts', '/home/user/app'), false);
	});

	it('rejects a parent directory and unrelated absolute paths', () => {
		assert.equal(isPathInsideRoot('/home/user', '/home/user/app'), false);
		assert.equal(isPathInsideRoot('/etc/passwd', '/home/user/app'), false);
	});
});
