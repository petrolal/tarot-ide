/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentSession, SessionMessage } from '../agents/types';
import {
	compactConversationMessages,
	computeContextMeter,
	forkSessionMessages,
	formatSessionExportBundle,
	formatSessionExportMarkdown,
} from '../context/compactionService';

function makeMsg(overrides: Partial<SessionMessage>): SessionMessage {
	return {
		id: `m-${Math.random().toString(36).slice(2, 8)}`,
		role: 'user',
		mode: 'vibe',
		content: 'hello',
		timestamp: '2026-11-25T12:00:00Z',
		...overrides,
	};
}

describe('compactionService.computeContextMeter', () => {
	it('anchors on real totalTokens from the latest CLI report and adds subsequent deltas', () => {
		const msgs = [
			makeMsg({ role: 'user', content: 'initial prompt' }),
			makeMsg({ role: 'assistant', content: 'response', totalTokens: 40_000 }),
			makeMsg({ role: 'user', content: 'a'.repeat(400) }), // +100 tokens
		];
		const snap = computeContextMeter(msgs, [], { windowTokens: 200_000 });
		assert.equal(snap.isRealTokens, true);
		assert.equal(snap.usedTokens, 40_100);
		assert.equal(snap.percent, 20);
	});

	it('falls back to calibrated estimation when no CLI token usage has been reported yet', () => {
		const msgs = [makeMsg({ role: 'user', content: 'x'.repeat(8_000) })]; // 2000 tokens
		const snap = computeContextMeter(msgs, [], { windowTokens: 100_000 });
		assert.equal(snap.isRealTokens, false);
		assert.equal(snap.usedTokens, 2_000);
		assert.equal(snap.percent, 2);
	});
});

describe('compactionService.compactConversationMessages', () => {
	it('preserves intent, task status, modified files, decisions, dropped steering and last N literal messages', () => {
		const msgs: SessionMessage[] = [
			makeMsg({ role: 'user', content: 'Build OAuth2 login flow' }),
			makeMsg({
				role: 'assistant',
				content: 'Implemented login',
				tools: ['write_file', 'run_command'],
				appliedSteering: ['tech.md (always)', 'security.md (manual)'],
				fileWriteGate: { sessionId: 's1', checkpointId: 'cp1', files: ['src/auth.ts'] },
				approvalGate: { specDir: '/ws/.tarot/specs/auth', specSlug: 'auth', targetPhase: 'design', label: 'Approve', approved: true },
				taskProgress: { title: 'auth', done: 2, total: 3, items: [{ label: 'Add refresh token', completed: false }] },
			}),
			makeMsg({ role: 'user', content: 'Now add refresh token rotation' }),
			makeMsg({ role: 'assistant', content: 'Added rotation' }),
			makeMsg({ role: 'user', content: 'Latest question 1' }),
			makeMsg({ role: 'assistant', content: 'Latest answer 1' }),
		];

		const res = compactConversationMessages(msgs, { excludeMessages: 2, postCompactionContext: 'Keep strict TS.' });
		assert.equal(res.compacted, true);
		assert.equal(res.removedCount, 4);
		assert.equal(res.messages.length, 3); // 1 summary + 2 literal tail
		const summary = res.messages[0].content;
		assert.match(summary, /Build OAuth2 login flow/);
		assert.match(summary, /2\/3 completed/);
		assert.match(summary, /src\/auth\.ts/);
		assert.match(summary, /Approved spec gate: auth/);
		assert.match(summary, /security\.md \(manual\)/);
		assert.match(summary, /Keep strict TS\./);
		assert.equal(res.messages[1].content, 'Latest question 1');
		assert.equal(res.messages[2].content, 'Latest answer 1');
	});
});

describe('compactionService fork & export', () => {
	it('forks up to a target message and strips checkpoint/fileWriteGate artifacts', () => {
		const m1 = makeMsg({ id: 'm1', role: 'user', content: 'first' });
		const m2 = makeMsg({ id: 'm2', role: 'assistant', content: 'second', checkpointId: 'cp1', fileWriteGate: { sessionId: 's1', checkpointId: 'cp1', files: ['a.ts'] } });
		const m3 = makeMsg({ id: 'm3', role: 'user', content: 'third' });

		const forked = forkSessionMessages([m1, m2, m3], 'm2');
		assert.equal(forked.length, 2);
		assert.equal(forked[1].checkpointId, undefined);
		assert.equal(forked[1].fileWriteGate, undefined);
	});

	it('exports Markdown and structured JSON/JSONL bundle', () => {
		const session: AgentSession = {
			id: 'session-1',
			title: 'Auth Session',
			createdAt: '2026-11-25T10:00:00Z',
			updatedAt: '2026-11-25T10:05:00Z',
			activeAgentId: 'claude',
			mode: 'vibe',
			autonomy: 'acceptFileChanges',
			messages: [makeMsg({ role: 'user', content: 'Hi' })],
		};
		const md = formatSessionExportMarkdown(session);
		assert.match(md, /# Auth Session/);
		assert.match(md, /## User/);

		const bundle = formatSessionExportBundle(session);
		assert.equal(JSON.parse(bundle.sessionJson).messageCount, 1);
		assert.equal(bundle.messagesJsonl.trim().split('\n').length, 1);
	});
});
