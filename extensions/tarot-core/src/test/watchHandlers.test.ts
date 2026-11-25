/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola. All rights reserved.
 *  Licensed under the GNU General Public License v3.0. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import { describe, it } from 'node:test';
import { runCommandWatchPoll } from '../workflows/watchHandlers';

describe('workflows.watchHandlers.runCommandWatchPoll', () => {
	const workspacePath = os.tmpdir();

	it('passes context JSON on STDIN and parses new-activity STDOUT JSON', async () => {
		const cmd = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const ctx=JSON.parse(d);console.log(JSON.stringify({outcome:'new-activity',cursor:ctx.cursor+'-next',payload:{seen:ctx.config.tag}}));});"`;
		const res = await runCommandWatchPoll(cmd, {
			workspacePath,
			cursor: 'c1',
			config: { tag: 'pr-42' },
		});
		assert.equal(res.error, undefined);
		assert.equal(res.outcome, 'new-activity');
		assert.equal(res.cursor, 'c1-next');
		assert.deepEqual(res.payload, { seen: 'pr-42' });
	});

	it('returns terminal-state when stdout reports terminal-state', async () => {
		const cmd = `node -e "console.log(JSON.stringify({outcome:'terminal-state',cursor:'done'}))"`;
		const res = await runCommandWatchPoll(cmd, { workspacePath, cursor: 'c0', config: {} });
		assert.equal(res.outcome, 'terminal-state');
		assert.equal(res.cursor, 'done');
	});

	it('fails with error on exit code 2, 126, or 127', async () => {
		const res = await runCommandWatchPoll(`node -e "process.stderr.write('bad config');process.exit(2)"`, {
			workspacePath,
			cursor: 'c1',
			config: {},
		});
		assert.equal(res.outcome, 'idle');
		assert.match(res.error ?? '', /bad config/);
	});

	it('degrades to idle without error on other non-zero exit codes or malformed stdout', async () => {
		const resExit1 = await runCommandWatchPoll(`node -e "process.exit(1)"`, {
			workspacePath,
			cursor: 'c1',
			config: {},
		});
		assert.equal(resExit1.outcome, 'idle');
		assert.equal(resExit1.error, undefined);
		assert.equal(resExit1.cursor, 'c1');

		const resBadJson = await runCommandWatchPoll(`node -e "console.log('not-json')"`, {
			workspacePath,
			cursor: 'c2',
			config: {},
		});
		assert.equal(resBadJson.outcome, 'idle');
		assert.equal(resBadJson.error, undefined);
		assert.equal(resBadJson.cursor, 'c2');
	});
});
