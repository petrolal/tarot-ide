/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola. All rights reserved.
 *  Licensed under the GNU General Public License v3.0. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateSafeHttpsUrl } from '../context/urlSafety';

describe('urlSafety.validateSafeHttpsUrl', () => {
	it('allows public https:// URLs', () => {
		const res = validateSafeHttpsUrl('https://docs.example.com/guide?ref=1');
		assert.equal(res.ok, true);
	});

	it('blocks http://, credentials, localhost, link-local metadata and private IP ranges', () => {
		const blocked = [
			'http://example.com/page',
			'https://user:pass@example.com/page',
			'https://localhost/admin',
			'https://sub.localhost/api',
			'https://service.local/health',
			'https://127.0.0.1:8080/secret',
			'https://169.254.169.254/latest/meta-data/',
			'https://10.0.0.1/internal',
			'https://172.16.5.1/internal',
			'https://192.168.1.1/router',
			'https://[::1]/secret',
			'https://[fe80::1]/link',
			'https://[fc00::1]/ula',
		];
		for (const u of blocked) {
			const res = validateSafeHttpsUrl(u);
			assert.equal(res.ok, false, `Expected ${u} to be blocked`);
		}
	});
});
