/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { KeyedHookQueue, runHooksForTrigger, selectHooksForTrigger, TarotHookEngine } from '../hooks/hookEngine';
import { HookCommandOutcome } from '../hooks/hookRunner';
import { HookDefinition } from '../hooks/hookTypes';

function makeHook(overrides: Partial<HookDefinition>): HookDefinition {
	return {
		id: 'file#hook',
		name: 'hook',
		enabled: true,
		trigger: 'PostFileSave',
		timeout: 60,
		action: { type: 'command', command: 'echo noop' },
		scope: 'workspace',
		sourceFile: 'file',
		...overrides,
	};
}

describe('hookEngine.selectHooksForTrigger', () => {
	it('filters by enabled + trigger, and applies the matcher regex against matchInput', () => {
		const hooks = [
			makeHook({ name: 'a', trigger: 'PostFileSave', matcher: '\\.ts$' }),
			makeHook({ name: 'b', trigger: 'PostFileSave', matcher: '\\.md$' }),
			makeHook({ name: 'c', trigger: 'PostFileSave', enabled: false }),
			makeHook({ name: 'd', trigger: 'Stop' }),
		];
		const selected = selectHooksForTrigger(hooks, 'PostFileSave', 'src/index.ts');
		assert.deepEqual(selected.map(h => h.name), ['a']);
	});

	it('matches hooks without a matcher unconditionally', () => {
		const hooks = [makeHook({ name: 'always', matcher: undefined })];
		assert.equal(selectHooksForTrigger(hooks, 'PostFileSave').length, 1);
		assert.equal(selectHooksForTrigger(hooks, 'PostFileSave', 'anything.ts').length, 1);
	});
});

describe('hookEngine.runHooksForTrigger', () => {
	it('returns blocked with the denying hook on exit 2, without running later hooks', async () => {
		const hooks = [
			makeHook({ name: 'deny', trigger: 'PreToolUse' }),
			makeHook({ name: 'never-runs', trigger: 'PreToolUse' }),
		];
		const calls: string[] = [];
		const fakeRun = async (command: string): Promise<HookCommandOutcome> => {
			calls.push(command);
			return { kind: 'block', stderr: 'denied by policy' };
		};
		const summary = await runHooksForTrigger(hooks, 'PreToolUse', { cwd: '/ws' }, { runCommand: fakeRun });
		assert.equal(summary.blocked, true);
		assert.equal(summary.blockedBy?.name, 'deny');
		assert.equal(summary.blockReason, 'denied by policy');
		assert.deepEqual(calls, ['echo noop']);
	});

	it('collects stdout from exit-0 command hooks into contextAppend', async () => {
		const hooks = [makeHook({ name: 'ctx', trigger: 'PromptSubmit' })];
		const fakeRun = async (): Promise<HookCommandOutcome> => ({ kind: 'ok', stdout: 'extra context' });
		const summary = await runHooksForTrigger(hooks, 'PromptSubmit', { cwd: '/ws' }, { runCommand: fakeRun });
		assert.equal(summary.blocked, false);
		assert.match(summary.contextAppend[0], /extra context/);
	});

	it('inlines agent-action prompts for PromptSubmit instead of queuing them as separate turns', async () => {
		const hooks = [makeHook({ name: 'inject', trigger: 'PromptSubmit', action: { type: 'agent', prompt: 'Siga as regras X.' } })];
		const summary = await runHooksForTrigger(hooks, 'PromptSubmit', { cwd: '/ws' }, { inlineAgentPrompts: true });
		assert.equal(summary.agentActions.length, 0);
		assert.match(summary.contextAppend[0], /Siga as regras X\./);
	});

	it('queues agent-action prompts as separate turns for non-PromptSubmit triggers', async () => {
		const hooks = [makeHook({ name: 'followup', trigger: 'Stop', action: { type: 'agent', prompt: 'Rode os testes.' } })];
		const summary = await runHooksForTrigger(hooks, 'Stop', { cwd: '/ws' });
		assert.equal(summary.contextAppend.length, 0);
		assert.equal(summary.agentActions.length, 1);
		assert.equal(summary.agentActions[0].prompt, 'Rode os testes.');
	});

	it('records a warning (without blocking) on a non-zero, non-2 exit code', async () => {
		const hooks = [makeHook({ name: 'flaky', trigger: 'Stop' })];
		const fakeRun = async (): Promise<HookCommandOutcome> => ({ kind: 'warn', stderr: 'boom', exitCode: 1 });
		const summary = await runHooksForTrigger(hooks, 'Stop', { cwd: '/ws' }, { runCommand: fakeRun });
		assert.equal(summary.blocked, false);
		assert.equal(summary.warnings.length, 1);
		assert.match(summary.warnings[0].message, /boom/);
	});
});

describe('hookEngine.KeyedHookQueue', () => {
	it('coalesces rapid consecutive saves for the same key into a single run', async () => {
		const queue = new KeyedHookQueue(25);
		let runs = 0;
		const run = async () => { runs++; };
		queue.enqueue('PostFileSave:/a.ts', run);
		queue.enqueue('PostFileSave:/a.ts', run);
		queue.enqueue('PostFileSave:/a.ts', run);
		await new Promise(r => setTimeout(r, 80));
		queue.dispose();
		assert.equal(runs, 1);
	});

	it('never runs two executions for the same key concurrently and runs one trailing pass', async () => {
		const queue = new KeyedHookQueue(15);
		let active = 0;
		let maxConcurrent = 0;
		let completed = 0;
		const task = async () => {
			active++;
			maxConcurrent = Math.max(maxConcurrent, active);
			await new Promise(r => setTimeout(r, 40));
			active--;
			completed++;
		};
		queue.enqueue('PostFileSave:/a.ts', task);
		await new Promise(r => setTimeout(r, 25)); // first run is now in flight
		queue.enqueue('PostFileSave:/a.ts', task);
		queue.enqueue('PostFileSave:/a.ts', task);
		await new Promise(r => setTimeout(r, 150));
		queue.dispose();
		assert.equal(maxConcurrent, 1);
		assert.equal(completed, 2);
	});
});

describe('hookEngine.TarotHookEngine load error reporting', () => {
	it('reports malformed hook files once per error set and clears once fixed', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-hooks-err-'));
		const hooksDir = path.join(tmp, '.tarot', 'hooks');
		await fs.mkdir(hooksDir, { recursive: true });
		const badFile = path.join(hooksDir, 'broken.json');
		await fs.writeFile(badFile, '{ not valid json', 'utf8');

		const reported: Array<{ filePath: string; count: number }> = [];
		const engine = new TarotHookEngine((filePath, errors) => {
			if (filePath === badFile) {
				reported.push({ filePath, count: errors.length });
			}
		});

		try {
			await engine.discoverFiles(tmp);
			await engine.discoverFiles(tmp); // unchanged error set -> deduplicated
			assert.equal(reported.length, 1);

			// Fix the file -> clears tracked error state
			await fs.writeFile(badFile, JSON.stringify({ version: 'v1', hooks: [] }), 'utf8');
			await engine.discoverFiles(tmp);
			assert.equal(reported.length, 1);

			// Break again -> reported again
			await fs.writeFile(badFile, '{ broken again', 'utf8');
			await engine.discoverFiles(tmp);
			assert.equal(reported.length, 2);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
