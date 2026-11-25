/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola. All rights reserved.
 *  Licensed under the GNU General Public License v3.0. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkflowNode, WorkflowRunState } from '../workflows/workflowTypes';
import { classifyRunGroup, filterWorkflowRuns, flattenRecipeTree } from '../workflows/workflowViewHelpers';

describe('workflows.workflowViewHelpers', () => {
	it('classifies runs into status groups with Needs you first', () => {
		assert.equal(classifyRunGroup({ status: 'paused', pauseReason: 'needs_input' }), 'needsYou');
		assert.equal(classifyRunGroup({ status: 'paused', pauseReason: 'iteration_cap' }), 'needsYou');
		assert.equal(classifyRunGroup({ status: 'paused', pauseReason: 'boundary' }), 'paused');
		assert.equal(classifyRunGroup({ status: 'running' }), 'running');
		assert.equal(classifyRunGroup({ status: 'completed' }), 'completed');
		assert.equal(classifyRunGroup({ status: 'failed' }), 'failed');
		assert.equal(classifyRunGroup({ status: 'aborted' }), 'failed');
	});

	it('filters workflow runs by recipe name, run ID, status, or pause reason', () => {
		const runs: WorkflowRunState[] = [
			{
				id: 'run-1',
				recipeName: 'feature-pipeline',
				createdAt: '2026-11-25T00:00:00Z',
				updatedAt: '2026-11-25T00:00:00Z',
				status: 'paused',
				pauseReason: 'needs_input',
				inputs: {},
				stepStates: {},
				outputs: {},
				artifacts: {},
				repeatProgress: {},
				watchCursors: {},
				watchTerminal: {},
			},
			{
				id: 'run-2',
				recipeName: 'publish-pr',
				createdAt: '2026-11-25T00:00:00Z',
				updatedAt: '2026-11-25T00:00:00Z',
				status: 'completed',
				inputs: {},
				stepStates: {},
				outputs: {},
				artifacts: {},
				repeatProgress: {},
				watchCursors: {},
				watchTerminal: {},
			},
		];

		assert.equal(filterWorkflowRuns(runs, '').length, 2);
		assert.equal(filterWorkflowRuns(runs, 'publish').length, 1);
		assert.equal(filterWorkflowRuns(runs, 'needs_input')[0].id, 'run-1');
		assert.equal(filterWorkflowRuns(runs, 'run-2')[0].recipeName, 'publish-pr');
	});

	it('flattens nested recipe trees with depth and loop/parallel/watch badges', () => {
		const nodes: WorkflowNode[] = [
			{ type: 'step', id: 'plan', agent: 'wf-planner', prompt: 'Plan' },
			{
				type: 'repeat',
				id: 'loop',
				maxIterations: 2,
				steps: [
					{
						type: 'parallel',
						id: 'par',
						branches: [{ type: 'step', id: 'rev', agent: 'semantic_reviewer', prompt: 'Review' }],
					},
					{ type: 'watch', id: 'pr-watch', handler: 'github-pr', config: { prRef: '1' } },
				],
			},
		];
		const flat = flattenRecipeTree(nodes);
		assert.deepEqual(
			flat.map(i => ({ id: i.id, depth: i.depth, badge: i.badge })),
			[
				{ id: 'plan', depth: 0, badge: undefined },
				{ id: 'loop', depth: 0, badge: '[loop ×2]' },
				{ id: 'par', depth: 1, badge: '[parallel]' },
				{ id: 'rev', depth: 2, badge: undefined },
				{ id: 'pr-watch', depth: 1, badge: '[watch:github-pr]' },
			],
		);
	});
});
