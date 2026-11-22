/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { expandCapability, parsePermissionsDocument, ruleAppliesTo } from '../permissions/permissionTypes';

describe('permissionTypes', () => {
	it('expands meta-capabilities', () => {
		assert.ok(!expandCapability('all').includes('sandbox_network'));
		assert.ok(expandCapability('all').includes('fs_write'));
		assert.deepEqual(expandCapability('filesystem'), ['fs_read', 'fs_write']);
		assert.deepEqual(expandCapability('shell'), ['shell']);
	});

	it('ruleAppliesTo resolves meta-capabilities too', () => {
		assert.ok(ruleAppliesTo({ capability: 'filesystem', effect: 'allow' }, 'fs_write'));
		assert.ok(!ruleAppliesTo({ capability: 'filesystem', effect: 'allow' }, 'shell'));
	});

	it('parses a valid permissions.yaml document', () => {
		const result = parsePermissionsDocument({
			version: 1,
			rules: [
				{ capability: 'fs_write', effect: 'ask', match: ['src/**'] },
				{ capability: 'shell', effect: 'deny', match: ['rm *'], reason: 'dangerous' },
			],
		}, '/ws/.tarot-ide/permissions.yaml');
		assert.equal(result.errors.length, 0);
		assert.equal(result.rules.length, 2);
		assert.equal(result.rules[1].reason, 'dangerous');
	});

	it('collects errors for unknown capability/effect without throwing', () => {
		const result = parsePermissionsDocument({
			version: 1,
			rules: [
				{ capability: 'not_a_capability', effect: 'allow' },
				{ capability: 'shell', effect: 'not_an_effect' },
				{ capability: 'shell', effect: 'allow' },
			],
		}, '/ws/permissions.yaml');
		assert.equal(result.rules.length, 1);
		assert.equal(result.errors.length, 2);
	});

	it('treats a non-mapping root or missing version as an error without throwing', () => {
		assert.equal(parsePermissionsDocument(null, 'x.yaml').rules.length, 0);
		assert.equal(parsePermissionsDocument([], 'x.yaml').errors.length, 1);
		const missingVersion = parsePermissionsDocument({ rules: [] }, 'x.yaml');
		assert.equal(missingVersion.errors.length, 1);
	});
});
