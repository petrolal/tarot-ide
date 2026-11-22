/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEffectivePrompt } from '../agents/promptBuilder';

describe('promptBuilder', () => {
	it('includes read-only instructions in plan mode and omits supervised block', () => {
		const out = buildEffectivePrompt({
			prompt: 'Design the caching layer',
			mode: 'plan',
			autonomy: 'supervised',
			cwd: '/tmp/workspace',
			timeoutMs: 30_000,
		});
		assert.match(out, /Plan Mode \(Read-Only\)/);
		assert.doesNotMatch(out, /\[Autonomy: Supervised\]/);
		assert.match(out, /Design the caching layer$/);
	});

	it('includes EARS instructions in spec mode and supervised block when supervised', () => {
		const out = buildEffectivePrompt({
			prompt: 'Draft auth requirements',
			mode: 'spec',
			autonomy: 'supervised',
			cwd: '/tmp/workspace',
			systemContext: 'Always use pnpm.',
			timeoutMs: 30_000,
		});
		assert.match(out, /Spec Mode/);
		assert.match(out, /EARS notation/);
		assert.match(out, /\[Autonomy: Supervised\]/);
		assert.match(out, /\[Project Steering Context\]\nAlways use pnpm\./);
	});

	it('includes the Approve For Me block only in vibe/spec mode', () => {
		const out = buildEffectivePrompt({
			prompt: 'Add a helper',
			mode: 'vibe',
			autonomy: 'approveForMe',
			cwd: '/tmp/workspace',
			timeoutMs: 30_000,
		});
		assert.match(out, /\[Autonomy: Approve For Me\]/);

		const planOut = buildEffectivePrompt({
			prompt: 'Design the caching layer',
			mode: 'plan',
			autonomy: 'approveForMe',
			cwd: '/tmp/workspace',
			timeoutMs: 30_000,
		});
		assert.doesNotMatch(planOut, /\[Autonomy: Approve For Me\]/);
	});

	it('formats attachments and recent conversation history', () => {
		const out = buildEffectivePrompt({
			prompt: 'Review this',
			mode: 'vibe',
			autonomy: 'acceptFileChanges',
			cwd: '/tmp/workspace',
			timeoutMs: 30_000,
			attachments: [
				{ kind: 'file', label: 'src/app.ts:1-3', path: '/tmp/src/app.ts', selection: 'const x = 1;' },
				{ kind: 'problems', label: 'Problems', content: 'TS2322: type error' },
			],
			conversationHistory: [
				{ id: '1', role: 'user', mode: 'vibe', content: 'Hello', timestamp: '2026-11-20T00:00:00Z' },
				{ id: '2', role: 'assistant', agentId: 'agy', mode: 'vibe', content: 'Hi there', timestamp: '2026-11-20T00:00:01Z' },
			],
		});
		assert.match(out, /### #src\/app\.ts:1-3/);
		assert.match(out, /const x = 1;/);
		assert.match(out, /TS2322: type error/);
		assert.match(out, /Assistant \(agy\): Hi there/);
	});

	it('truncates an oversized attachment or steering doc instead of embedding it whole', () => {
		const out = buildEffectivePrompt({
			prompt: 'Review this',
			mode: 'vibe',
			autonomy: 'acceptFileChanges',
			cwd: '/tmp/workspace',
			timeoutMs: 30_000,
			systemContext: 'S'.repeat(60_000),
			attachments: [
				{ kind: 'file', label: 'huge.ts', path: '/tmp/huge.ts', selection: 'A'.repeat(60_000) },
			],
		});
		assert.match(out, /truncated: \d+ more characters omitted/);
		assert.ok(out.length < 150_000);
		// The user's own instruction is never truncated, regardless of how large the context got.
		assert.match(out, /Review this$/);
	});
});
