/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { WorkflowNode, WorkflowRunState } from './workflowTypes';

export type WorkflowRunGroupKey = 'needsYou' | 'running' | 'paused' | 'completed' | 'failed';

/** Classifies a workflow run into sidebar status groups with "Needs you" first (M3.9b). Pure. */
export function classifyRunGroup(run: Pick<WorkflowRunState, 'status' | 'pauseReason'>): WorkflowRunGroupKey {
	if (run.status === 'paused' && (run.pauseReason === 'needs_input' || run.pauseReason === 'iteration_cap')) {
		return 'needsYou';
	}
	if (run.status === 'running' || run.status === 'pending') {
		return 'running';
	}
	if (run.status === 'paused') {
		return 'paused';
	}
	if (run.status === 'completed') {
		return 'completed';
	}
	return 'failed';
}

/** Filters workflow runs by query matching recipe name, run ID, status, or pause reason. Pure. */
export function filterWorkflowRuns(runs: readonly WorkflowRunState[], query: string): WorkflowRunState[] {
	const q = query.trim().toLowerCase();
	if (!q) {
		return [...runs];
	}
	return runs.filter(r =>
		r.recipeName.toLowerCase().includes(q)
		|| r.id.toLowerCase().includes(q)
		|| r.status.toLowerCase().includes(q)
		|| (r.pauseReason ?? '').toLowerCase().includes(q),
	);
}

export interface FlattenedWorkflowTreeItem {
	readonly id: string;
	readonly type: WorkflowNode['type'];
	readonly depth: number;
	readonly agent?: string;
	readonly badge?: string;
	readonly modelId?: string;
	readonly effortLevel?: string;
}

/** Flattens a recipe's AST into an indented tree list with `[loop ×N]` / `[parallel]` badges. Pure. */
export function flattenRecipeTree(nodes: readonly WorkflowNode[], depth = 0): FlattenedWorkflowTreeItem[] {
	const items: FlattenedWorkflowTreeItem[] = [];
	for (const node of nodes) {
		if (node.type === 'step') {
			items.push({
				id: node.id,
				type: 'step',
				depth,
				agent: node.agent,
				modelId: node.modelId,
				effortLevel: node.effortLevel,
			});
		} else if (node.type === 'sequence') {
			items.push({ id: node.id, type: 'sequence', depth });
			items.push(...flattenRecipeTree(node.steps, depth + 1));
		} else if (node.type === 'repeat') {
			items.push({ id: node.id, type: 'repeat', depth, badge: `[loop ×${node.maxIterations}]` });
			items.push(...flattenRecipeTree(node.steps, depth + 1));
		} else if (node.type === 'parallel') {
			items.push({ id: node.id, type: 'parallel', depth, badge: '[parallel]' });
			items.push(...flattenRecipeTree(node.branches, depth + 1));
		} else if (node.type === 'watch') {
			items.push({ id: node.id, type: 'watch', depth, badge: `[watch:${node.handler}]` });
		}
	}
	return items;
}
