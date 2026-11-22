/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runHookCommand } from '../hooks/hookRunner';

const isWindows = process.platform === 'win32';
const CTX = { hook_event_name: 'PostFileSave', cwd: process.cwd(), file_path: 'src/index.ts' };

describe('hookRunner.runHookCommand', () => {
	it('reports "ok" with stdout on exit 0', { skip: isWindows }, async () => {
		const outcome = await runHookCommand('echo hello-from-hook', CTX, 5);
		assert.equal(outcome.kind, 'ok');
		assert.equal(outcome.kind === 'ok' ? outcome.stdout : undefined, 'hello-from-hook');
	});

	it('reports "block" on exit 2', { skip: isWindows }, async () => {
		const outcome = await runHookCommand('exit 2', CTX, 5);
		assert.equal(outcome.kind, 'block');
	});

	it('reports "warn" with the exit code on any other non-zero exit', { skip: isWindows }, async () => {
		const outcome = await runHookCommand('exit 7', CTX, 5);
		assert.equal(outcome.kind, 'warn');
		assert.equal(outcome.kind === 'warn' ? outcome.exitCode : undefined, 7);
	});

	it('pipes the context as JSON on stdin', { skip: isWindows }, async () => {
		const outcome = await runHookCommand('cat', CTX, 5);
		assert.equal(outcome.kind, 'ok');
		const parsed = JSON.parse(outcome.kind === 'ok' ? outcome.stdout : '{}');
		assert.equal(parsed.hook_event_name, 'PostFileSave');
		assert.equal(parsed.file_path, 'src/index.ts');
	});

	it('reports "timeout" when the command runs past the timeout', { skip: isWindows }, async () => {
		const outcome = await runHookCommand('sleep 5', CTX, 1);
		assert.equal(outcome.kind, 'timeout');
	});
});
