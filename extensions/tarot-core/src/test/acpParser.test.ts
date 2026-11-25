/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAcpSessionUpdate, resolveAcpPermissionOption } from '../agents/adapters/acpParser';

describe('agents.adapters.acpParser', () => {
	it('parses text, thought, tool_call and tool_call_update events', () => {
		assert.deepEqual(
			parseAcpSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hello' } } }),
			[{ type: 'text', content: 'hello' }],
		);
		assert.deepEqual(
			parseAcpSessionUpdate({ update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } } }),
			[{ type: 'thought', content: 'hmm' }],
		);
		assert.deepEqual(
			parseAcpSessionUpdate({ update: { sessionUpdate: 'tool_call', title: 'bash' } }),
			[{ type: 'tool_start', toolName: 'bash' }],
		);
		assert.deepEqual(
			parseAcpSessionUpdate({ update: { sessionUpdate: 'tool_call_update', title: 'bash', status: 'completed' } }),
			[{ type: 'tool_end', toolName: 'bash' }],
		);
	});

	it('resolves ACP permission options respecting Tarot policy deny/allow before autonomy fallback', () => {
		const params = {
			options: [
				{ optionId: 'allow-1', kind: 'allow_once' },
				{ optionId: 'reject-1', kind: 'reject_once' },
			],
		};

		assert.equal(resolveAcpPermissionOption(params, 'vibe', 'approveForMe', 'deny')?.optionId, 'reject-1');
		assert.equal(resolveAcpPermissionOption(params, 'plan', 'supervised', 'allow')?.optionId, 'allow-1');
		assert.equal(resolveAcpPermissionOption(params, 'plan', 'acceptFileChanges', 'ask')?.optionId, 'reject-1');
		assert.equal(resolveAcpPermissionOption(params, 'vibe', 'supervised', 'ask')?.optionId, 'reject-1');
		assert.equal(resolveAcpPermissionOption(params, 'vibe', 'acceptFileChanges', 'ask')?.optionId, 'allow-1');
	});
});
