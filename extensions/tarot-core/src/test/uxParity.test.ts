/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseClaudeStreamJsonLine } from '../agents/adapters/claudeStreamParser';
import { AgentEvent } from '../agents/types';
import { extractDevServerScripts } from '../crew/devServerService';
import { computeCompletedTaskLineRanges } from '../specs/taskParser';
import { extractStepVerdict, formatRelativeTime } from '../workflows/workflowViewHelpers';

describe('UX Parity — ClaudeCodeAdapter stream-json result fallback', () => {
	it('emits result text when no prior assistant text was emitted after tool_use rounds', () => {
		const events: AgentEvent[] = [];
		const pending = new Map<string, string>();

		// Tool use without text
		const emitted1 = parseClaudeStreamJsonLine(
			JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read' }] } }),
			ev => events.push(ev),
			pending,
			false,
		);
		assert.equal(emitted1, false);
		assert.equal(events[0]?.type, 'tool_start');

		// Final result payload carries the answer
		const emitted2 = parseClaudeStreamJsonLine(
			JSON.stringify({ type: 'result', is_error: false, result: 'Este projeto é o Tarot IDE.' }),
			ev => events.push(ev),
			pending,
			emitted1,
		);
		assert.equal(emitted2, true);
		assert.ok(events.some(e => e.type === 'text' && e.content === 'Este projeto é o Tarot IDE.'));
	});

	it('does not duplicate result text if assistant text was already emitted in the turn', () => {
		const events: AgentEvent[] = [];
		const pending = new Map<string, string>();
		const emitted1 = parseClaudeStreamJsonLine(
			JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Olá!' }] } }),
			ev => events.push(ev),
			pending,
			false,
		);
		assert.equal(emitted1, true);
		parseClaudeStreamJsonLine(
			JSON.stringify({ type: 'result', is_error: false, result: 'Olá!' }),
			ev => events.push(ev),
			pending,
			true,
		);
		assert.equal(events.filter(e => e.type === 'text').length, 1);
	});
});

describe('UX Parity — Workflow relative timestamps & verdicts', () => {
	it('formats relative ages in Kiro style', () => {
		const now = Date.parse('2026-11-25T12:00:00Z');
		assert.equal(formatRelativeTime('2026-11-25T11:59:30Z', now), 'now');
		assert.equal(formatRelativeTime('2026-11-25T11:55:00Z', now), '5m ago');
		assert.equal(formatRelativeTime('2026-11-25T09:00:00Z', now), '3h ago');
		assert.equal(formatRelativeTime('2026-11-24T12:00:00Z', now), '1 day ago');
		assert.equal(formatRelativeTime('2026-11-18T12:00:00Z', now), '1 wk ago');
	});

	it('extracts right-aligned step verdicts cleanly', () => {
		assert.deepEqual(extractStepVerdict('All checks look great. APPROVED', 'completed'), { label: 'Approved', tone: 'ok' });
		assert.deepEqual(extractStepVerdict('CHANGES REQUESTED: fix null check', 'completed'), { label: 'Changes requested', tone: 'warn' });
		assert.deepEqual(extractStepVerdict('All tests green. PASSED', 'completed'), { label: 'Passed', tone: 'ok' });
		assert.deepEqual(extractStepVerdict('', 'paused'), { label: 'Needs input', tone: 'warn' });
	});
});

describe('UX Parity — Spec tasks.md completed green bar ranges', () => {
	it('computes multi-line ranges for completed tasks including indented Requirements/Property lines', () => {
		const md = [
			'# Implementation Plan',
			'',
			'- [x] 1. Add coupon lookup',
			'  - _Requirements: 1.1_',
			'- [ ] 2. Pending task',
			'  - _Requirements: 1.2_',
			'- [x] 2.1 Write property test',
			'  - **Property 1: Discount never exceeds subtotal**',
			'  - **Validates: Requirements 1.2**',
		].join('\n');
		const ranges = computeCompletedTaskLineRanges(md);
		assert.deepEqual(ranges, [
			{ startLine: 2, endLine: 3 },
			{ startLine: 6, endLine: 8 },
		]);
	});
});

describe('UX Parity — Dev Server script discovery', () => {
	it('discovers dev/start/serve/watch scripts and ignores non-server scripts', () => {
		const scripts = extractDevServerScripts({
			scripts: {
				dev: 'vite',
				'watch-tarot': 'gulp watch-tarot',
				build: 'tsc',
				test: 'node --test',
				preview: 'vite preview',
			},
		}, '/tmp/my-app');
		assert.deepEqual(scripts.map(s => s.name), ['dev', 'preview', 'watch-tarot']);
	});
});
