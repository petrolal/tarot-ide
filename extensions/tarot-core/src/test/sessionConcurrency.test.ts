/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola. All rights reserved.
 *  Licensed under the GNU General Public License v3.0. See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	checkSessionConcurrency,
	classifySessionStatus,
	filterSessionCards,
	SessionCardSummary,
} from '../agents/sessionConcurrency';

describe('agents.sessionConcurrency (M3.9c)', () => {
	it('classifies session status with priority parked > needsInput > running > idle', () => {
		assert.equal(classifySessionStatus({ messages: [] }, false, 2), 'parked');
		assert.equal(
			classifySessionStatus({
				messages: [{
					id: 'm1',
					role: 'assistant',
					mode: 'vibe',
					content: 'done',
					timestamp: '2026-11-25T00:00:00Z',
					fileWriteGate: { sessionId: 's1', checkpointId: 'cp1', files: ['a.ts'] },
				}],
			}, false, 0),
			'needsInput',
		);
		assert.equal(classifySessionStatus({ messages: [] }, true, 0), 'running');
		assert.equal(classifySessionStatus({ messages: [] }, false, 0), 'idle');
	});

	it('filters session cards by search query and status/mode filter', () => {
		const cards: SessionCardSummary[] = [
			{
				id: 's1',
				title: 'Auth refactor',
				summary: 'Update OAuth',
				repoName: 'tarot-ide',
				mode: 'spec',
				activeAgentId: 'claude',
				updatedAt: '2026-11-25T10:00:00Z',
				status: 'needsInput',
				parkedApprovals: 0,
			},
			{
				id: 's2',
				title: 'Subagent audit',
				summary: 'Check deps',
				repoName: 'api-core',
				mode: 'vibe',
				activeAgentId: 'agy',
				updatedAt: '2026-11-25T11:00:00Z',
				status: 'parked',
				parkedApprovals: 1,
			},
		];

		assert.equal(filterSessionCards(cards, '', 'all').length, 2);
		assert.equal(filterSessionCards(cards, '', 'needsInput')[0].id, 's1');
		assert.equal(filterSessionCards(cards, '', 'parked')[0].id, 's2');
		assert.equal(filterSessionCards(cards, 'api-core', 'all')[0].id, 's2');
		assert.equal(filterSessionCards(cards, 'oauth', 'spec')[0].id, 's1');
	});

	it('serializes Spec sessions in the same workspace, allows Plan/custom in parallel, and warns on shared write dirs', () => {
		const activeSpec = { sessionId: 's1', mode: 'spec' as const, profileId: 'spec', cwd: '/repo', isWorktree: false };
		const blocked = checkSessionConcurrency([activeSpec], {
			sessionId: 's2',
			mode: 'spec',
			profileId: 'quick-spec',
			cwd: '/repo',
			isWorktree: false,
		});
		assert.equal(blocked.allowed, false);
		assert.match(blocked.blockReason ?? '', /currently busy/i);

		const planParallel = checkSessionConcurrency([activeSpec], {
			sessionId: 's3',
			mode: 'plan',
			profileId: 'plan',
			cwd: '/repo',
			isWorktree: false,
		});
		assert.equal(planParallel.allowed, true);
		assert.equal(planParallel.sharedWorkspaceWarning, undefined);

		const vibeSameDir = checkSessionConcurrency([activeSpec], {
			sessionId: 's4',
			mode: 'vibe',
			cwd: '/repo',
			isWorktree: false,
		});
		assert.equal(vibeSameDir.allowed, true);
		assert.ok(vibeSameDir.sharedWorkspaceWarning);

		const vibeIsolatedWorktree = checkSessionConcurrency([activeSpec], {
			sessionId: 's5',
			mode: 'vibe',
			cwd: '/repo/.tarot/worktrees/wt-1',
			isWorktree: true,
		});
		assert.equal(vibeIsolatedWorktree.allowed, true);
		assert.equal(vibeIsolatedWorktree.sharedWorkspaceWarning, undefined);
	});
});
