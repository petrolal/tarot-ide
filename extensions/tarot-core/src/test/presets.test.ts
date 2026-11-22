/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateCapability, evaluateShellCommand } from '../permissions/policyEngine';
import { getPreset, PRESET_NAMES } from '../permissions/presets';

describe('presets', () => {
	it('exposes every documented preset name', () => {
		for (const name of PRESET_NAMES) {
			assert.ok(getPreset(name), `preset "${name}" should resolve to rules`);
		}
		assert.equal(getPreset('not-a-real-preset'), undefined);
	});

	it('edit-workspace allows reads and writes anywhere in the workspace', () => {
		const scope = { id: 'user' as const, rules: getPreset('edit-workspace')! };
		assert.equal(evaluateCapability([scope], 'fs_read', 'src/a.ts').effect, 'allow');
		assert.equal(evaluateCapability([scope], 'fs_write', 'src/a.ts').effect, 'allow');
	});

	it('read-workspace allows reads but only asks before writes', () => {
		const scope = { id: 'user' as const, rules: getPreset('read-workspace')! };
		assert.equal(evaluateCapability([scope], 'fs_read', 'src/a.ts').effect, 'allow');
		assert.equal(evaluateCapability([scope], 'fs_write', 'src/a.ts').effect, 'ask');
	});

	it('read-only-shell allows read-only commands but still asks before anything else', () => {
		const scope = { id: 'user' as const, rules: getPreset('read-only-shell')! };
		assert.equal(evaluateShellCommand([scope], 'git status').decision.effect, 'allow');
		assert.equal(evaluateShellCommand([scope], 'rm -rf /').decision.effect, 'ask');
	});

	it('dev-shell allows common dev tool invocations', () => {
		const scope = { id: 'user' as const, rules: getPreset('dev-shell')! };
		assert.equal(evaluateShellCommand([scope], 'pnpm install').decision.effect, 'allow');
		assert.equal(evaluateShellCommand([scope], 'curl https://evil.example').decision.effect, 'ask');
	});

	it('approve-for-me contributes no decision without a classifier (falls back to default)', () => {
		const scope = { id: 'user' as const, rules: getPreset('approve-for-me')! };
		assert.equal(evaluateCapability([scope], 'fs_write', 'src/a.ts').effect, 'ask');
	});
});
