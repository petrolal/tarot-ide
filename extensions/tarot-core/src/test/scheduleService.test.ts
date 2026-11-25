/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { computeJitterMs, isValidCronExpression, matchesCronAt } from '../schedule/cronParser';
import { TarotScheduleService } from '../schedule/scheduleService';

describe('schedule.cronParser (M3.10)', () => {
	it('validates 5-field cron expressions and matches with timezone & excludeDates', () => {
		assert.equal(isValidCronExpression('0 9 * * 1-5'), true);
		assert.equal(isValidCronExpression('*/15 * * * *'), true);
		assert.equal(isValidCronExpression('invalid cron'), false);

		// 2026-11-25T12:00:00Z is Wednesday 09:00 in America/Sao_Paulo (UTC-3)
		const wedMorning = new Date('2026-11-25T12:00:00Z');
		assert.equal(matchesCronAt('0 9 * * 1-5', wedMorning, { timezone: 'America/Sao_Paulo' }), true);
		assert.equal(matchesCronAt('0 9 * * 1-5', wedMorning, { timezone: 'UTC' }), false);
		assert.equal(
			matchesCronAt('0 9 * * 1-5', wedMorning, { timezone: 'America/Sao_Paulo', excludeDates: ['2026-11-25'] }),
			false,
		);
	});

	it('computes bounded jitter deterministically', () => {
		assert.equal(computeJitterMs(0), 0);
		assert.equal(computeJitterMs(30, () => 0.5), 15_000);
	});
});

describe('schedule.TarotScheduleService (M3.10)', () => {
	it('creates, discovers jobs, and records structured run logs + Markdown digests', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-schedule-test-'));
		try {
			const service = new TarotScheduleService();
			const wsDir = service.getWorkspaceSchedulesDir(tmp);
			await service.createJobFile(wsDir, 'nightly-lint', {
				name: 'Nightly Lint',
				cron: '0 2 * * *',
				timezone: 'UTC',
				actionType: 'command',
				commandOrPrompt: 'pnpm test',
			});

			const discovered = await service.discover(tmp);
			const job = discovered.jobs.find(j => j.id === 'nightly-lint');
			assert.ok(job);
			assert.equal(job.action.type, 'command');
			assert.equal(job.action.command, 'pnpm test');

			const { logPath, digestPath } = await service.recordRunAndDigest(tmp, {
				jobId: job.id,
				jobName: job.name,
				startedAt: '2026-11-25T02:00:00Z',
				finishedAt: '2026-11-25T02:00:05Z',
				status: 'ok',
				actionType: 'command',
				output: 'All checks passed.',
				tokensUsed: 0,
			});

			const logJson = JSON.parse(await fs.readFile(logPath, 'utf8'));
			assert.equal(logJson.status, 'ok');
			assert.equal(logJson.tokensUsed, 0);

			const digestMd = await fs.readFile(digestPath, 'utf8');
			assert.match(digestMd, /Nightly Lint/);
			assert.match(digestMd, /0 tokens/);
			assert.match(digestMd, /All checks passed/);

			const digests = await service.listDigests(tmp);
			assert.equal(digests.length, 1);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
