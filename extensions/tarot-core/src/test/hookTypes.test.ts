/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeTrigger, parseHookFile } from '../hooks/hookTypes';

describe('hookTypes', () => {
	it('normalizes known triggers and their aliases', () => {
		assert.equal(normalizeTrigger('PostFileSave'), 'PostFileSave');
		assert.equal(normalizeTrigger('UserPromptSubmit'), 'PromptSubmit');
		assert.equal(normalizeTrigger('AgentStop'), 'Stop');
		assert.equal(normalizeTrigger('NotARealTrigger'), undefined);
	});

	it('parses a valid v1 file with command and agent hooks', () => {
		const raw = {
			version: 'v1',
			hooks: [
				{
					name: 'lint-on-save', enabled: true, trigger: 'PostFileSave', matcher: '\\.ts$', timeout: 30,
					action: { type: 'command', command: 'npx eslint --fix' },
				},
				{
					name: 'review-on-stop', trigger: 'Stop',
					action: { type: 'agent', prompt: 'Revise o diff.' },
				},
			],
		};
		const result = parseHookFile(raw, '/ws/.tarot/hooks/a.json', 'workspace');
		assert.equal(result.errors.length, 0);
		assert.equal(result.migrated, false);
		assert.equal(result.hooks.length, 2);
		assert.equal(result.hooks[0].id, '/ws/.tarot/hooks/a.json#lint-on-save');
		assert.equal(result.hooks[0].timeout, 30);
		assert.equal(result.hooks[1].enabled, true);
		assert.equal(result.hooks[1].timeout, 60);
	});

	it('rejects hooks missing a name, a known trigger, or a valid action', () => {
		const raw = {
			version: 'v1',
			hooks: [
				{ trigger: 'Stop', action: { type: 'agent', prompt: 'x' } },
				{ name: 'bad-trigger', trigger: 'NotReal', action: { type: 'agent', prompt: 'x' } },
				{ name: 'bad-action', trigger: 'Stop', action: { type: 'command' } },
			],
		};
		const result = parseHookFile(raw, '/ws/.tarot/hooks/b.json', 'workspace');
		assert.equal(result.hooks.length, 0);
		assert.equal(result.errors.length, 3);
	});

	it('upconverts the legacy single-hook shape transparently', () => {
		const legacy = { trigger: 'onSave', glob: '\\.md$', prompt: 'Revise o markdown salvo.' };
		const result = parseHookFile(legacy, '/ws/.tarot/hooks/legacy.json', 'workspace');
		assert.equal(result.migrated, true);
		assert.equal(result.hooks.length, 1);
		assert.equal(result.hooks[0].trigger, 'PostFileSave');
		assert.equal(result.hooks[0].matcher, '\\.md$');
		assert.equal(result.hooks[0].action.type, 'agent');
	});

	it('parses a Stop hook with a confirm block', () => {
		const raw = {
			version: 'v1',
			hooks: [{
				name: 'deploy-check', trigger: 'Stop',
				action: {
					type: 'command', command: 'echo noop',
					confirm: { question: 'Deploy now?', options: [{ id: 'yes', label: 'Yes, deploy', run: 'npm run deploy' }, { id: 'no', label: 'Skip' }] },
				},
			}],
		};
		const result = parseHookFile(raw, '/ws/.tarot/hooks/c.json', 'workspace');
		assert.equal(result.hooks.length, 1);
		assert.equal(result.hooks[0].action.confirm?.question, 'Deploy now?');
		assert.equal(result.hooks[0].action.confirm?.options.length, 2);
		assert.equal(result.hooks[0].action.confirm?.options[0].run, 'npm run deploy');
	});
});
