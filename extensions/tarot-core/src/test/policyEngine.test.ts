/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionScope } from '../permissions/permissionTypes';
import { getPreset } from '../permissions/presets';
import {
	evaluateCapability, evaluateShellCommand, getEnforcementKind, TAROT_BUILTIN_ACTOR, TAROT_INVARIANT_RULES,
} from '../permissions/policyEngine';

function scope(id: PermissionScope['id'], rules: PermissionScope['rules']): PermissionScope {
	return { id, rules };
}

describe('policyEngine.evaluateCapability', () => {
	it('defaults fs_read to allow and anything else to ask with no rules', () => {
		assert.equal(evaluateCapability([], 'fs_read', 'src/a.ts').effect, 'allow');
		assert.equal(evaluateCapability([], 'fs_write', 'src/a.ts').effect, 'ask');
		assert.equal(evaluateCapability([], 'web_fetch', 'https://example.com').effect, 'ask');
	});

	it('downgrades the default ask to deny when headless', () => {
		const decision = evaluateCapability([], 'fs_write', 'src/a.ts', { headless: true });
		assert.equal(decision.effect, 'deny');
	});

	it('defaults read-only git shell commands to allow', () => {
		assert.equal(evaluateCapability([], 'shell', 'git status').effect, 'allow');
		assert.equal(evaluateCapability([], 'shell', 'git push origin main').effect, 'ask');
	});

	it('does not auto-allow a read-only git subcommand carrying a shell redirection', () => {
		assert.equal(evaluateCapability([], 'shell', 'git show HEAD:secrets.env > /tmp/leak.txt').effect, 'ask');
		assert.equal(evaluateCapability([], 'shell', 'git diff > ~/.bashrc').effect, 'ask');
		assert.equal(evaluateCapability([], 'shell', 'git log < input.txt').effect, 'ask');
		// A literal '>' inside a quoted argument is not redirection — still read-only.
		assert.equal(evaluateCapability([], 'shell', 'git log --grep="> note"').effect, 'allow');
	});

	it('a match-scoped shell allow rule does not cover a redirection that escapes its own pattern', () => {
		const scopes = [scope('user', [{ capability: 'shell', effect: 'allow', match: ['cat *', 'echo *'] }])];
		assert.equal(evaluateCapability(scopes, 'shell', 'cat notes.txt').effect, 'allow');
		assert.equal(evaluateCapability(scopes, 'shell', 'cat secrets.env > /tmp/exfil.txt').effect, 'ask');
		assert.equal(evaluateCapability(scopes, 'shell', 'echo pwned > ~/.bashrc').effect, 'ask');
	});

	it('the read-only-shell and dev-shell presets do not auto-allow their own commands once redirected', () => {
		const readOnly = [scope('user', getPreset('read-only-shell')!)];
		assert.equal(evaluateCapability(readOnly, 'shell', 'cat package.json').effect, 'allow');
		assert.equal(evaluateCapability(readOnly, 'shell', 'cat secrets.env > /tmp/exfil.txt').effect, 'ask');

		const devShell = [scope('user', getPreset('dev-shell')!)];
		assert.equal(evaluateCapability(devShell, 'shell', 'pnpm test').effect, 'allow');
		assert.equal(evaluateCapability(devShell, 'shell', 'pnpm test > ~/.bashrc').effect, 'ask');
	});

	it('an unscoped allow-all rule (no match) is a deliberate blanket grant, not narrowed by redirection', () => {
		const scopes = [scope('user', getPreset('allow-all')!)];
		assert.equal(evaluateCapability(scopes, 'shell', 'cat secrets.env > /tmp/exfil.txt').effect, 'allow');
	});

	it('the most restrictive scope wins regardless of scope order (deny beats allow)', () => {
		const scopes = [
			scope('user', [{ capability: 'fs_write', effect: 'allow', match: ['**'] }]),
			scope('workspace', [{ capability: 'fs_write', effect: 'deny', match: ['**/*.env'] }]),
		];
		assert.equal(evaluateCapability(scopes, 'fs_write', 'config/.env').effect, 'deny');
		assert.equal(evaluateCapability(scopes, 'fs_write', 'src/a.ts').effect, 'allow');
	});

	it('exclude overrides a matching pattern', () => {
		const scopes = [scope('workspace', [{ capability: 'fs_write', effect: 'allow', match: ['src/**'], exclude: ['src/**/*.test.ts'] }])];
		assert.equal(evaluateCapability(scopes, 'fs_write', 'src/a.ts').effect, 'allow');
		assert.equal(evaluateCapability(scopes, 'fs_write', 'src/a.test.ts').effect, 'ask');
	});

	it('expands the "all" meta-capability but keeps rules with explicit capabilities separate', () => {
		const scopes = [scope('session', [{ capability: 'all', effect: 'deny' }])];
		assert.equal(evaluateCapability(scopes, 'shell', 'ls').effect, 'deny');
		assert.equal(evaluateCapability(scopes, 'sandbox_network', 'any').effect, 'ask');
	});

	it('rules with effect "evaluate" contribute no decision without a classifier', () => {
		const scopes = [scope('user', [{ capability: 'all', effect: 'evaluate' }])];
		assert.equal(evaluateCapability(scopes, 'fs_write', 'src/a.ts').effect, 'ask');
	});

	it('the Tarot invariant scope always asks before writing .git/** even if another scope allows it', () => {
		const scopes = [
			scope('tarot', TAROT_INVARIANT_RULES),
			scope('user', [{ capability: 'all', effect: 'allow' }]),
		];
		assert.equal(evaluateCapability(scopes, 'fs_write', '.git/config').effect, 'ask');
		assert.equal(evaluateCapability(scopes, 'fs_write', '.tarot/settings/permissions.yaml').effect, 'deny');
	});
});

describe('policyEngine.evaluateShellCommand', () => {
	it('evaluates the most restrictive segment across a composite command', () => {
		const scopes = [scope('workspace', [{ capability: 'shell', effect: 'deny', match: ['rm *'] }])];
		const result = evaluateShellCommand(scopes, 'echo hi && rm -rf /tmp/x');
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.decision.effect, 'deny');
			assert.equal(result.segments.length, 2);
		}
	});

	it('blocks unparseable composite commands outright', () => {
		const result = evaluateShellCommand([], 'echo $(whoami)');
		assert.equal(result.ok, false);
		assert.equal(result.decision.effect, 'deny');
	});
});

describe('policyEngine.getEnforcementKind', () => {
	it('is enforced only for Tarot\'s own actions, advisory for every BYOA agent', () => {
		assert.equal(getEnforcementKind(TAROT_BUILTIN_ACTOR), 'enforced');
		assert.equal(getEnforcementKind('claude'), 'advisory');
		assert.equal(getEnforcementKind('agy'), 'advisory');
	});
});
