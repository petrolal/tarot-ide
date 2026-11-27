/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { TarotRecipeLoader } from '../workflows/recipeLoader';
import { isValidStopWhen, isValidWorkflowJsonPath, validateWorkflow } from '../workflows/recipeValidator';
import { TarotWorkflowRunStore } from '../workflows/runStore';
import { resolveWorkflowTemplate } from '../workflows/templateResolver';
import { parseSendMessageFromOutput, resolveStepModelAndEffort, TarotWorkflowEngine } from '../workflows/workflowEngine';
import { WorkflowRecipe } from '../workflows/workflowTypes';

describe('workflows.recipeValidator', () => {
	it('approves all bundled recipes in extensions/tarot-core/recipes/', async () => {
		const bundledDir = path.resolve(__dirname, '..', '..', 'recipes');
		const loader = new TarotRecipeLoader(bundledDir);
		const discovery = await loader.discover();
		assert.equal(discovery.errors.length, 0, discovery.errors.join('\n'));
		const names = discovery.recipes.map(r => r.name);
		assert.ok(names.includes('investigate'));
		assert.ok(names.includes('feature-pipeline'));
		assert.ok(names.includes('publish-pr'));
		assert.ok(names.includes('semantic-review-multi-model'));
		assert.ok(names.includes('autoresearch'));
		assert.ok(names.includes('goal'));
		assert.ok(names.includes('ralph'));
	});

	it('rejects invalid schema, duplicate IDs, bad template order, fileCheck escape, bad jsonPath and built-in subagent', () => {
		assert.equal(isValidWorkflowJsonPath('$.status.code'), true);
		assert.equal(isValidWorkflowJsonPath('status.items[0]'), false);
		assert.equal(isValidWorkflowJsonPath('status..code'), false);
		assert.equal(isValidWorkflowJsonPath('status.*'), false);

		assert.equal(isValidStopWhen('pr-watch.terminal'), true);
		assert.equal(isValidStopWhen('{{review.output}} contains APPROVED'), true);
		assert.equal(isValidStopWhen('invalid syntax'), false);

		const badRecipe: WorkflowRecipe = {
			name: 'bad',
			steps: [
				{ type: 'step', id: 's1', agent: 'context-gathering', prompt: 'Use {{previous.output}}' },
				{ type: 'step', id: 's1', agent: 'wf-coder', prompt: 'dup id' },
				{
					type: 'repeat',
					id: 'r1',
					maxIterations: 0,
					stopCondition: { fileCheck: { path: '../outside.json', jsonPath: 'a[0]', value: 'ok' } },
					stopWhen: 'bad',
					steps: [{ type: 'step', id: 'r-step', agent: 'wf-coder', prompt: 'go' }],
				},
				{
					type: 'parallel',
					id: 'p1',
					branches: [{ type: 'step', id: 'p-step', agent: 'wf-coder', prompt: '{{previous.output}}' }],
				},
				{
					type: 'watch',
					id: 'w1',
					handler: 'command',
					config: { command: 'echo {{input}}', pollIntervalSec: 5 },
				},
			],
		};

		const res = validateWorkflow(badRecipe, '/ws');
		assert.equal(res.valid, false);
		assert.ok(res.errors.some(e => /built-in sub-agent/i.test(e)));
		assert.ok(res.errors.some(e => /first node/i.test(e)));
		assert.ok(res.errors.some(e => /Duplicate node ID/i.test(e)));
		assert.ok(res.errors.some(e => /positive integer/i.test(e)));
		assert.ok(res.errors.some(e => /both "stopCondition" and "stopWhen"/i.test(e)));
		assert.ok(res.errors.some(e => /stay inside the workspace/i.test(e)));
		assert.ok(res.errors.some(e => /invalid fileCheck jsonPath/i.test(e)));
		assert.ok(res.errors.some(e => /inside a parallel block/i.test(e)));
		assert.ok(res.errors.some(e => /cannot use templates/i.test(e)));
		assert.ok(res.errors.some(e => /pollIntervalSec >= 10/i.test(e)));
	});
});

describe('workflows.templateResolver', () => {
	it('wraps captured step outputs in tamper-resistant delimiters and warns on undeclared variables', () => {
		const res = resolveWorkflowTemplate('Task: {{input}} Prev: {{previous.output}} Unknown: {{mystery}}', {
			input: 'fix bug',
			previousOutput: 'step1 output',
			stepOutputs: {},
			artifacts: {},
		});
		assert.match(res.resolved, /Task: fix bug/);
		assert.match(res.resolved, /<<<TAROT_OUTPUT:previous:[0-9a-f]+>>>/);
		assert.match(res.resolved, /step1 output/);
		assert.match(res.resolved, /Unknown: \{\{mystery\}\}/);
		assert.equal(res.warnings.length, 1);
	});
});

describe('workflows.recipeLoader precedence', () => {
	it('prefers JSON over YAML with warning and does not let an invalid workspace recipe hide a valid bundled one', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-wf-load-'));
		try {
			const bundledDir = path.join(tmp, 'bundled');
			const wsDir = path.join(tmp, 'ws', '.tarot', 'workflows');
			await fs.mkdir(bundledDir, { recursive: true });
			await fs.mkdir(wsDir, { recursive: true });

			const validRecipe: WorkflowRecipe = {
				name: 'demo',
				steps: [{ type: 'step', id: 's1', agent: 'wf-coder', prompt: 'run' }],
			};
			await fs.writeFile(path.join(bundledDir, 'demo.workflow.json'), JSON.stringify(validRecipe), 'utf8');
			// Invalid workspace override must NOT hide the valid bundled recipe
			await fs.writeFile(path.join(wsDir, 'demo.workflow.json'), '{ invalid json', 'utf8');
			await fs.writeFile(path.join(wsDir, 'demo.workflow.yaml'), 'name: demo\nsteps: []\n', 'utf8');

			const loader = new TarotRecipeLoader(bundledDir);
			const res = await loader.discover(path.join(tmp, 'ws'));
			assert.equal(res.recipes.length, 1);
			assert.equal(res.recipes[0].scope, 'bundled');
			assert.ok(res.errors.length >= 1);
			assert.ok(res.warnings.some(w => /JSON.*wins/i.test(w)));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

describe('workflows.workflowEngine execution, checkpointing and resume', () => {
	it('runs repeat + parallel + watch, checkpoints at boundaries, pauses and resumes cleanly', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-wf-run-'));
		try {
			const store = new TarotWorkflowRunStore();
			const engine = new TarotWorkflowEngine(store);

			const recipe: WorkflowRecipe = {
				name: 'test-flow',
				modelId: 'wf-model',
				effortLevel: 'medium',
				steps: [
					{ type: 'step', id: 'first', agent: 'claude', prompt: 'Do {{input}}', modelId: 'step-model' },
					{
						type: 'parallel',
						id: 'par',
						joinPolicy: 'all',
						branches: [
							{ type: 'step', id: 'b1', agent: 'agy', prompt: 'Branch 1' },
							{ type: 'step', id: 'b2', agent: 'codex', prompt: 'Branch 2' },
						],
					},
					{
						type: 'repeat',
						id: 'loop',
						maxIterations: 3,
						stopWhen: 'w.terminal',
						steps: [
							{ type: 'watch', id: 'w', handler: 'command', config: { command: 'true', pollIntervalSec: 10 } },
							{ type: 'step', id: 'after-watch', agent: 'wf-coder', prompt: 'React to {{previous.output}}' },
						],
					},
				],
			};

			// Check model/effort precedence: step > workflow > parent
			assert.deepEqual(resolveStepModelAndEffort(recipe.steps[0] as never, recipe, 'parent-m', 'low'), {
				modelId: 'step-model',
				effortLevel: 'medium',
			});
			assert.deepEqual(parseSendMessageFromOutput('[SEND_MESSAGE:warning] Need approval'), {
				severity: 'warning',
				message: 'Need approval',
			});

			const executed: string[] = [];
			let pauseAfterFirst = true;

			// 1st pass: pauses cooperatively right after `first`
			const pausedRun = await engine.run(recipe, tmp, { task: 'ship' }, {
				shouldPause: () => !pauseAfterFirst && executed.length === 1,
				executeStep: async req => {
					executed.push(`${req.step.id}:${req.step.agent}`);
					if (req.step.id === 'first') {
						pauseAfterFirst = false;
					}
					return { ok: true, output: `out-${req.step.id}` };
				},
			});
			assert.equal(pausedRun.status, 'paused');
			assert.equal(pausedRun.pauseReason, 'boundary');

			// Simulate IDE restart: load persisted run from disk and resume
			const reloaded = await store.loadRun(tmp, pausedRun.id);
			assert.ok(reloaded);
			let watchPolls = 0;
			const finalRun = await engine.run(recipe, tmp, reloaded.inputs, {
				executeStep: async req => {
					executed.push(`${req.step.id}:${req.step.agent}`);
					return { ok: true, output: `out-${req.step.id}` };
				},
				executeWatch: async () => {
					watchPolls++;
					return {
						outcome: watchPolls >= 2 ? 'terminal-state' : 'new-activity',
						cursor: `c${watchPolls}`,
						payload: { poll: watchPolls },
					};
				},
			}, reloaded);

			assert.equal(finalRun.status, 'completed');
			// `first` ran only once (preserved across restart)
			assert.equal(executed.filter(e => e.startsWith('first:')).length, 1);
			assert.equal(watchPolls, 2);
			assert.equal(finalRun.watchCursors['w'], 'c2');
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it('resumes a mid-iteration repeat pause with user_reply without re-running completed steps', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-wf-repeat-resume-'));
		try {
			const store = new TarotWorkflowRunStore();
			const engine = new TarotWorkflowEngine(store);
			const recipe: WorkflowRecipe = {
				name: 'repeat-resume-test',
				steps: [
					{
						type: 'repeat',
						id: 'loop',
						maxIterations: 1,
						stopCondition: { containsText: 'done-s2' },
						steps: [
							{ type: 'step', id: 's1', agent: 'claude', prompt: 'Step 1' },
							{ type: 'step', id: 's2', agent: 'claude', prompt: 'Step 2' },
						],
					},
				],
			};

			const calls: Array<{ id: string; prompt: string }> = [];
			let firstAttempt = true;
			const paused = await engine.run(recipe, tmp, { task: 'demo' }, {
				executeStep: async req => {
					calls.push({ id: req.step.id, prompt: req.resolvedPrompt });
					if (req.step.id === 's2' && firstAttempt) {
						firstAttempt = false;
						return { ok: true, output: '[SEND_MESSAGE:warning] Need key' };
					}
					return { ok: true, output: `done-${req.step.id}` };
				},
			});
			assert.equal(paused.status, 'paused');
			assert.equal(paused.pauseReason, 'needs_input');
			assert.equal(paused.stepStates['s1'].status, 'completed');
			assert.equal(paused.stepStates['s2'].status, 'paused');

			// Resume with user_reply (simulating onResume in extension.ts)
			paused.stepStates['s2'].status = 'pending';
			const resumed = await engine.run(recipe, tmp, { ...paused.inputs, user_reply: 'API_KEY=123' }, {
				executeStep: async req => {
					calls.push({ id: req.step.id, prompt: req.resolvedPrompt });
					return { ok: true, output: `done-${req.step.id}` };
				},
			}, paused);

			assert.equal(resumed.status, 'completed');
			assert.equal(calls.filter(c => c.id === 's1').length, 1, 's1 must not re-run on mid-iteration resume');
			const s2ResumeCall = calls.filter(c => c.id === 's2')[1];
			assert.match(s2ResumeCall.prompt, /API_KEY=123/);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it('honors parallel allSettled/any when a branch fails and polls watch until activity', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-wf-par-watch-'));
		try {
			const store = new TarotWorkflowRunStore();
			const engine = new TarotWorkflowEngine(store);
			const recipe: WorkflowRecipe = {
				name: 'par-watch-test',
				steps: [
					{
						type: 'parallel',
						id: 'par-any',
						joinPolicy: 'any',
						branches: [
							{ type: 'step', id: 'fail-branch', agent: 'claude', prompt: 'Fail' },
							{ type: 'step', id: 'ok-branch', agent: 'claude', prompt: 'Succeed' },
						],
					},
					{ type: 'watch', id: 'w', handler: 'command', config: { command: 'true', pollIntervalSec: 10 } },
					{ type: 'step', id: 'after', agent: 'claude', prompt: 'After watch' },
				],
			};

			let polls = 0;
			const finalRun = await engine.run(recipe, tmp, { task: 'x' }, {
				watchPollDelayMs: 5,
				executeStep: async req => {
					if (req.step.id === 'fail-branch') {
						return { ok: false, output: 'boom' };
					}
					return { ok: true, output: 'ok' };
				},
				executeWatch: async () => {
					polls++;
					if (polls < 3) {
						return { outcome: 'idle', cursor: `c${polls}` };
					}
					return { outcome: 'new-activity', cursor: `c${polls}`, payload: 'event' };
				},
			});

			assert.equal(finalRun.status, 'completed');
			assert.equal(polls, 3);
			assert.equal(finalRun.stepStates['after'].status, 'completed');
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it('a paused branch always wins over a failed sibling in a parallel "all" join, regardless of resolution order (TD-10)', async () => {
		const makeRecipe = (): WorkflowRecipe => ({
			name: 'par-pause-vs-fail',
			steps: [
				{
					type: 'parallel',
					id: 'par-all',
					branches: [
						{ type: 'step', id: 'pause-branch', agent: 'claude', prompt: 'Needs input' },
						{ type: 'step', id: 'fail-branch', agent: 'claude', prompt: 'Fails' },
					],
				},
			],
		});

		for (const pauseResolvesFirst of [true, false]) {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-wf-pause-race-'));
			try {
				const store = new TarotWorkflowRunStore();
				const engine = new TarotWorkflowEngine(store);
				const finalRun = await engine.run(makeRecipe(), tmp, { task: 'x' }, {
					executeStep: async req => {
						const isPauseBranch = req.step.id === 'pause-branch';
						const delayMs = (isPauseBranch === pauseResolvesFirst) ? 0 : 10;
						await new Promise(resolve => setTimeout(resolve, delayMs));
						return isPauseBranch
							? { ok: true, output: '[SEND_MESSAGE:warning] need more info' }
							: { ok: false, output: 'boom' };
					},
				});
				assert.equal(finalRun.status, 'paused', `pauseResolvesFirst=${pauseResolvesFirst}`);
				assert.equal(finalRun.pauseReason, 'needs_input');
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		}
	});

	it('supports fileCheck stopCondition, onMaxIterations pause/continue, and updateWorkflow preserving completed steps', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-wf-p1-'));
		try {
			const store = new TarotWorkflowRunStore();
			const engine = new TarotWorkflowEngine(store);

			// 1. fileCheck stopCondition with dotted jsonPath
			const statusFile = path.join(tmp, 'status.json');
			await fs.writeFile(statusFile, JSON.stringify({ build: { state: 'pending' } }), 'utf8');
			const fileCheckRecipe: WorkflowRecipe = {
				name: 'filecheck-test',
				steps: [
					{
						type: 'repeat',
						id: 'wait-green',
						maxIterations: 3,
						onMaxIterations: 'pause',
						stopCondition: { fileCheck: { path: 'status.json', jsonPath: '$.build.state', value: ['green', 'passed'] } },
						steps: [{ type: 'step', id: 'check', agent: 'claude', prompt: 'Check build' }],
					},
				],
			};
			let attempts = 0;
			const fileCheckRun = await engine.run(fileCheckRecipe, tmp, { task: 'verify' }, {
				executeStep: async () => {
					attempts++;
					if (attempts === 2) {
						await fs.writeFile(statusFile, JSON.stringify({ build: { state: 'passed' } }), 'utf8');
					}
					return { ok: true, output: `attempt-${attempts}` };
				},
			});
			assert.equal(fileCheckRun.status, 'completed');
			assert.equal(attempts, 2);

			// 2. onMaxIterations: 'pause' -> iteration_cap, then updateWorkflow adds a new step while preserving completed ones
			const capRecipe: WorkflowRecipe = {
				name: 'cap-test',
				steps: [
					{ type: 'step', id: 'init', agent: 'claude', prompt: 'Init' },
					{
						type: 'repeat',
						id: 'retry',
						maxIterations: 1,
						onMaxIterations: 'pause',
						stopCondition: { containsText: 'NEVER' },
						steps: [{ type: 'step', id: 'work', agent: 'claude', prompt: 'Work' }],
					},
				],
			};
			const ran: string[] = [];
			const capped = await engine.run(capRecipe, tmp, { task: 'cap' }, {
				executeStep: async req => {
					ran.push(req.step.id);
					return { ok: true, output: 'still-working' };
				},
			});
			assert.equal(capped.status, 'paused');
			assert.equal(capped.pauseReason, 'iteration_cap');

			const revised: WorkflowRecipe = {
				name: 'cap-test',
				steps: [
					{ type: 'step', id: 'init', agent: 'claude', prompt: 'Init' },
					{ type: 'step', id: 'finalize', agent: 'claude', prompt: 'Finalize' },
				],
			};
			const updated = await engine.updateWorkflow(revised, tmp, capped, {
				executeStep: async req => {
					ran.push(req.step.id);
					return { ok: true, output: 'done' };
				},
			});
			assert.equal(updated.status, 'completed');
			assert.equal(ran.filter(id => id === 'init').length, 1, 'init must not re-run after updateWorkflow');
			assert.equal(ran.filter(id => id === 'finalize').length, 1);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
