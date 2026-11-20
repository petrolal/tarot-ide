/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAgyStreamParseState, parseAgyStreamLine } from '../agents/adapters/agyStreamParser';

describe('agyStreamParser', () => {
	it('parses step_update text_delta, thinking_delta, tool calls, and usage tokens', () => {
		const state = createAgyStreamParseState();

		const ev1 = parseAgyStreamLine(
			JSON.stringify({
				event: 'step_update',
				step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', thinking_delta: 'Checking files...', text_delta: 'Hello ' },
			}),
			state,
		);
		assert.equal(state.emittedText, true);
		assert.deepEqual(ev1, [
			{ type: 'thought', content: 'Checking files...' },
			{ type: 'text', content: 'Hello ' },
		]);

		const ev2 = parseAgyStreamLine(
			JSON.stringify({
				event: 'step_update',
				step_update: { step_index: 2, state: 'ACTIVE', step_type: 'replace_file_content', file_path: 'src/index.js' },
			}),
			state,
		);
		assert.equal(ev2[0].type, 'tool_start');
		assert.equal(ev2[0].toolName, 'replace_file_content src/index.js');

		// Duplicate step_index should not emit a duplicate tool_start
		const ev2Dup = parseAgyStreamLine(
			JSON.stringify({
				event: 'step_update',
				step_update: { step_index: 2, state: 'DONE', step_type: 'replace_file_content', file_path: 'src/index.js' },
			}),
			state,
		);
		assert.equal(ev2Dup.length, 0);

		const ev3 = parseAgyStreamLine(
			JSON.stringify({
				event: 'result',
				result: { status: 'SUCCESS', response: 'Hello world', usage: { total_tokens: 11187 } },
			}),
			state,
		);
		// Does not duplicate text already streamed, but emits usage metadata
		assert.equal(ev3.length, 1);
		assert.equal((ev3[0].metadata?.usage as { total_tokens?: number }).total_tokens, 11187);
	});

	it('falls back to result.response if no text_delta was streamed', () => {
		const state = createAgyStreamParseState();
		const ev = parseAgyStreamLine(
			JSON.stringify({
				event: 'result',
				result: { status: 'SUCCESS', response: 'Done.' },
			}),
			state,
		);
		assert.deepEqual(ev, [{ type: 'text', content: 'Done.' }]);
	});
});
