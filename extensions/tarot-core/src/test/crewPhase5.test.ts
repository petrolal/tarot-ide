/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
	TarotAppsAndRemoteService,
	validateRemoteSshProfile,
} from '../crew/appsAndRemoteService';
import {
	computeWebhookSignature,
	formatGatewayPayload,
	TarotGatewayService,
	verifyWebhookSignature,
} from '../crew/gatewayService';
import {
	parseHeartbeatConfig,
	TarotHeartbeatService,
} from '../crew/heartbeatService';
import {
	computeLocalEmbedding,
	cosineSimilarity,
	hybridRankDocuments,
	tokenizeForSearch,
} from '../crew/semanticIndex';

describe('Fase 5 — Hybrid Semantic Search (BM25 + Local Embeddings RRF)', () => {
	it('ranks relevant documents highest and handles morphological variants via char 3-grams', () => {
		const docs = [
			{
				id: 'arch',
				text: 'Tarot IDE uses an Extension-First architecture with BYOA local CLI agents.',
				tokens: tokenizeForSearch('Tarot IDE uses an Extension-First architecture with BYOA local CLI agents.'),
			},
			{
				id: 'css',
				text: 'Configure button border radius and theme palette tokens in panel.css.',
				tokens: tokenizeForSearch('Configure button border radius and theme palette tokens in panel.css.'),
			},
		];
		const hits = hybridRankDocuments(docs, 'architectural extensions cli', 2);
		assert.ok(hits.length >= 1);
		assert.equal(hits[0].id, 'arch');
		assert.ok(cosineSimilarity(computeLocalEmbedding('authentication'), computeLocalEmbedding('authenticating')) > 0.5);
	});
});

describe('Fase 5 — Heartbeat Daemon', () => {
	it('parses config with interval bounds, runs checks, persists JSONL, and deduplicates alerts', async () => {
		const cfg = parseHeartbeatConfig({ enabled: true, intervalSec: 5, checks: [{ id: 'c1', name: 'Echo', kind: 'command', command: 'echo ok' }] });
		assert.equal(cfg.intervalSec, 30); // clamped minimum
		assert.equal(cfg.checks.length, 1);

		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-hb-test-'));
		try {
			const hb = new TarotHeartbeatService();
			await fs.mkdir(path.join(tmp, '.tarot', 'crew'), { recursive: true });
			await fs.writeFile(
				hb.getConfigPath(tmp),
				JSON.stringify({ enabled: true, intervalSec: 60, checks: [{ id: 'denied', name: 'Denied Cmd', kind: 'command', command: 'rm -rf /' }] }),
				'utf8',
			);

			let alertCount = 0;
			const rec1 = await hb.runOnce(tmp, {
				checkCommandAllowed: async () => false,
				onAlert: () => { alertCount++; },
			});
			assert.equal(rec1.status, 'error');
			assert.equal(alertCount, 1);

			// Second identical failure must be deduplicated
			await hb.runOnce(tmp, {
				checkCommandAllowed: async () => false,
				onAlert: () => { alertCount++; },
			});
			assert.equal(alertCount, 1);
			hb.dispose();
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

describe('Fase 5 — Authenticated Local Webhook Server & Omnichannel Gateways', () => {
	it('verifies HMAC-SHA256 signatures in constant time and formats gateway payloads', () => {
		const secret = 'super-secret-tarot-hmac-key';
		const body = JSON.stringify({ event: 'deploy', ok: true });
		const sig = computeWebhookSignature(secret, body);
		assert.equal(verifyWebhookSignature(secret, body, sig), true);
		assert.equal(verifyWebhookSignature(secret, body, 'sha256=deadbeef'), false);
		assert.equal(verifyWebhookSignature(secret, body, undefined), false);

		assert.ok(String(formatGatewayPayload('slack', 'Build', 'Green').text).includes('Build'));
		assert.ok(String(formatGatewayPayload('discord', 'Build', 'Green').content).includes('Build'));
		assert.equal(formatGatewayPayload('telegram', 'Build', 'Green', '42').chat_id, '42');
	});

	it('accepts signed POST /webhook/<id> on 127.0.0.1 and rejects unsigned requests with 401', async () => {
		const gw = new TarotGatewayService();
		const secret = '0123456789abcdef0123456789abcdef';
		const received: string[] = [];
		const port = await gw.startWebhookServer(secret, ev => { received.push(ev.hookId); }, 0);
		try {
			const payload = JSON.stringify({ pr: 101 });
			const badRes = await fetch(`http://127.0.0.1:${port}/webhook/ci`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Tarot-Signature': 'sha256=invalid' },
				body: payload,
			});
			assert.equal(badRes.status, 401);

			const goodRes = await fetch(`http://127.0.0.1:${port}/webhook/ci`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Tarot-Signature': computeWebhookSignature(secret, payload) },
				body: payload,
			});
			assert.equal(goodRes.status, 202);
			assert.deepEqual(received, ['ci']);

			const notFound = await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST' });
			assert.equal(notFound.status, 404);
		} finally {
			await gw.stopWebhookServer();
		}
	});
});

describe('Fase 5 — Crew Apps SDK & Remote SSH Validation', () => {
	it('creates/discovers Crew Apps and blocks SSH option injection or shell metacharacters', async () => {
		assert.equal(validateRemoteSshProfile({ host: '-oProxyCommand=evil', remoteCrewDir: '~/.tarot/crew' }).ok, false);
		assert.equal(validateRemoteSshProfile({ host: 'dev.example.com', user: 'ubuntu', port: 22, remoteCrewDir: '~/.tarot/crew;rm -rf /' }).ok, false);
		assert.equal(validateRemoteSshProfile({ host: 'dev.example.com', user: 'ubuntu', port: 2222, remoteCrewDir: '~/.tarot/crew' }).ok, true);

		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-apps-test-'));
		try {
			const svc = new TarotAppsAndRemoteService();
			const created = await svc.createAppTemplate(tmp, 'Release Ops', 'Checks release readiness');
			assert.equal(created.id, 'release-ops');
			assert.equal(created.actions.length, 2);

			const discovered = await svc.discoverApps(tmp);
			assert.equal(discovered.length, 1);
			assert.equal(discovered[0].name, 'Release Ops');

			await svc.saveRemote(tmp, { id: 'prod-1', label: 'Prod', host: 'build.internal', user: 'ci', port: 22, remoteCrewDir: '~/.tarot/crew' });
			const remotes = await svc.listRemotes(tmp);
			assert.equal(remotes.length, 1);
			assert.equal(remotes[0].host, 'build.internal');
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
