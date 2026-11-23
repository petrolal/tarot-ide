/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateSubagentCapability, runSubagentDag, SubagentNode, validateSubagentDag } from '../agents/subagentManager';
import { PermissionScope } from '../permissions/permissionTypes';

describe('subagentManager.evaluateSubagentCapability', () => {
	it('ensures stricter parent policy always wins and sub-agent allow never exceeds parent', () => {
		const parentScopes: PermissionScope[] = [
			{ id: 'user', rules: [{ capability: 'fs_write', effect: 'deny', match: ['secrets/**'] }] },
		];
		const subagentRules = [{ capability: 'fs_write' as const, effect: 'allow' as const, match: ['**'] }];

		const denied = evaluateSubagentCapability(parentScopes, subagentRules, 'fs_write', 'secrets/key.pem');
		assert.equal(denied.effect, 'deny');

		// Even when parent has no explicit rule (defaults to `ask`), sub-agent `allow` cannot relax it
		const defaulted = evaluateSubagentCapability(parentScopes, subagentRules, 'fs_write', 'src/app.ts');
		assert.equal(defaulted.effect, 'ask');

		// Sub-agent can tighten a parent `allow` to `deny`
		const allowParent: PermissionScope[] = [
			{ id: 'user', rules: [{ capability: 'fs_write', effect: 'allow', match: ['src/**'] }] },
		];
		const tightened = evaluateSubagentCapability(
			allowParent,
			[{ capability: 'fs_write', effect: 'deny', match: ['src/locked.ts'] }],
			'fs_write',
			'src/locked.ts',
		);
		assert.equal(tightened.effect, 'deny');
	});
});

describe('subagentManager DAG validation and execution', () => {
	it('rejects self-loops, mutual review loops, short triggers, invalid maxIterations and cycles', () => {
		const selfLoop = validateSubagentDag([
			{ id: 'a', kind: 'validation', prompt: 'p', reviewLoop: { target: 'a', trigger: 'FAIL', maxIterations: 2 } },
		]);
		assert.equal(selfLoop.valid, false);

		const mutual = validateSubagentDag([
			{ id: 'a', kind: 'general-purpose', prompt: 'p', reviewLoop: { target: 'b', trigger: 'REDO', maxIterations: 2 } },
			{ id: 'b', kind: 'validation', prompt: 'p', reviewLoop: { target: 'a', trigger: 'FAIL', maxIterations: 2 } },
		]);
		assert.equal(mutual.valid, false);

		const badTrigger = validateSubagentDag([
			{ id: 'a', kind: 'general-purpose', prompt: 'p' },
			{ id: 'b', kind: 'validation', prompt: 'p', dependsOn: ['a'], reviewLoop: { target: 'a', trigger: 'NO', maxIterations: 12 } },
		]);
		assert.equal(badTrigger.valid, false);
		assert.ok(badTrigger.errors.length >= 2);
	});

	it('executes independent nodes in parallel waves and runs bounded review loops', async () => {
		const nodes: SubagentNode[] = [
			{ id: 'gather', kind: 'context-gathering', prompt: 'read repo' },
			{ id: 'impl', kind: 'general-purpose', prompt: 'write code', dependsOn: ['gather'] },
			{ id: 'review', kind: 'validation', prompt: 'check code', dependsOn: ['impl'], reviewLoop: { target: 'impl', trigger: 'NEEDS_FIX', maxIterations: 3 } },
		];

		let reviewCalls = 0;
		const summary = await runSubagentDag(nodes, async node => {
			if (node.id === 'review') {
				reviewCalls++;
				return { ok: true, output: reviewCalls === 1 ? 'NEEDS_FIX: missing check' : 'APPROVED' };
			}
			return { ok: true, output: `${node.id}-ok` };
		});

		const implRes = summary.results.find(r => r.id === 'impl');
		const reviewRes = summary.results.find(r => r.id === 'review');
		assert.equal(implRes?.iterations, 2);
		assert.equal(reviewRes?.iterations, 2);
		assert.equal(reviewRes?.output, 'APPROVED');
	});
});
