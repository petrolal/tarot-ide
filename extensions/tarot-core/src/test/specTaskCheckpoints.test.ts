/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { computeTaskCheckpointKey, readTaskCheckpoint, recordTaskCheckpoint } from '../specs/specTaskCheckpoints';

describe('specTaskCheckpoints', () => {
	it('uses numberLabel when present and a stable title hash when unnumbered', () => {
		assert.equal(computeTaskCheckpointKey({ numberLabel: '2.1', title: 'Implement auth' }), '2.1');
		const keyA = computeTaskCheckpointKey({ title: 'Implement login flow' });
		const keyB = computeTaskCheckpointKey({ title: 'Implement   login flow!' });
		const keyC = computeTaskCheckpointKey({ title: 'Add unit tests' });
		assert.match(keyA, /^title:[0-9a-f]{10}$/);
		assert.equal(keyA, keyB);
		assert.notEqual(keyA, keyC);
	});

	it('preserves checkpoints across task reordering and falls back to legacy index keys', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-task-cp-'));
		try {
			const key = computeTaskCheckpointKey({ title: 'Build API client' });
			await recordTaskCheckpoint(tmp, key, { sessionId: 's1', checkpointId: 'cp1', createdAt: '2026-11-23T00:00:00Z' });
			const found = await readTaskCheckpoint(tmp, key, '5');
			assert.equal(found?.checkpointId, 'cp1');

			// Legacy sidecar entry keyed only by numeric index still resolves via fallback
			await recordTaskCheckpoint(tmp, '3', { sessionId: 's0', checkpointId: 'cp-legacy', createdAt: '2026-11-20T00:00:00Z' });
			const legacyFound = await readTaskCheckpoint(tmp, computeTaskCheckpointKey({ title: 'Old task' }), '3');
			assert.equal(legacyFound?.checkpointId, 'cp-legacy');
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
