/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { Capability, PermissionRule, PermissionScope } from '../permissions/permissionTypes';
import { evaluateCapability, EvaluationOptions, PermissionDecision } from '../permissions/policyEngine';

export type BuiltInSubagentKind = 'context-gathering' | 'general-purpose' | 'validation';

export interface SubagentReviewLoop {
	/** ID of the target node to re-run when `trigger` matches the reviewer's output. */
	readonly target: string;
	/** Substring (>= 4 chars) that triggers another iteration when present in output. */
	readonly trigger: string;
	/** Maximum review iterations (1..10). */
	readonly maxIterations: number;
}

export interface SubagentNode {
	readonly id: string;
	readonly kind: BuiltInSubagentKind | (string & {});
	readonly prompt: string;
	readonly dependsOn?: readonly string[];
	readonly permissions?: readonly PermissionRule[];
	readonly reviewLoop?: SubagentReviewLoop;
}

export interface SubagentDagValidation {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly waves: readonly (readonly SubagentNode[])[];
}

export interface SubagentNodeResult {
	readonly id: string;
	readonly status: 'succeeded' | 'failed' | 'skipped';
	readonly output: string;
	readonly iterations: number;
}

export interface SubagentDagRunSummary {
	readonly results: readonly SubagentNodeResult[];
}

/**
 * Composes the effective permission policy for a sub-agent: the sub-agent's own `permissions`
 * are added as an `agent` scope alongside all parent scopes. Because `policyEngine` uses
 * deny-overrides with NO scope precedence (`deny > ask > allow`), a sub-agent's `allow` rule
 * can NEVER relax a parent's `deny` or `ask` rule — the stricter decision always wins.
 */
export function evaluateSubagentCapability(
	parentScopes: readonly PermissionScope[],
	subagentRules: readonly PermissionRule[] | undefined,
	capability: Capability,
	value?: string,
	options?: EvaluationOptions,
): PermissionDecision {
	const parentDecision = evaluateCapability(parentScopes, capability, value, options);
	if (!subagentRules || subagentRules.length === 0) {
		return parentDecision;
	}
	const combinedScopes: PermissionScope[] = [
		...parentScopes,
		{ id: 'agent', rules: subagentRules },
	];
	const combined = evaluateCapability(combinedScopes, capability, value, options);

	// Extra guard: if parent defaulted to `ask` (no explicit rule) and sub-agent tried to `allow`,
	// the sub-agent still cannot exceed the parent's effective permission level.
	const rank: Record<string, number> = { deny: 3, ask: 2, allow: 1, evaluate: 0 };
	if (rank[parentDecision.effect] > rank[combined.effect]) {
		return parentDecision;
	}
	return combined;
}

/**
 * Validates an immutable sub-agent DAG before execution:
 * - Unique node IDs, valid `dependsOn` references, acyclic dependency graph (Kahn waves).
 * - Review loop constraints (M3.8b): `trigger.length >= 4`, `maxIterations` in `1..10`, no
 *   self-loop (`target === node.id`), and no mutual loop (`A -> B` and `B -> A`).
 */
export function validateSubagentDag(nodes: readonly SubagentNode[]): SubagentDagValidation {
	const errors: string[] = [];
	const byId = new Map<string, SubagentNode>();

	for (const node of nodes) {
		if (!node.id.trim()) {
			errors.push('Sub-agent node ID cannot be empty.');
			continue;
		}
		if (byId.has(node.id)) {
			errors.push(`Duplicate sub-agent node ID: "${node.id}".`);
		}
		byId.set(node.id, node);
	}

	for (const node of nodes) {
		for (const dep of node.dependsOn ?? []) {
			if (!byId.has(dep)) {
				errors.push(`Sub-agent "${node.id}" depends on unknown node "${dep}".`);
			}
			if (dep === node.id) {
				errors.push(`Sub-agent "${node.id}" cannot depend on itself.`);
			}
		}
		if (node.reviewLoop) {
			const loop = node.reviewLoop;
			if (!byId.has(loop.target)) {
				errors.push(`Sub-agent "${node.id}" reviewLoop targets unknown node "${loop.target}".`);
			}
			if (loop.target === node.id) {
				errors.push(`Sub-agent "${node.id}" reviewLoop cannot target itself.`);
			}
			if (loop.trigger.trim().length < 4) {
				errors.push(`Sub-agent "${node.id}" reviewLoop trigger must be at least 4 characters.`);
			}
			if (!Number.isInteger(loop.maxIterations) || loop.maxIterations < 1 || loop.maxIterations > 10) {
				errors.push(`Sub-agent "${node.id}" reviewLoop maxIterations must be an integer between 1 and 10.`);
			}
			const targetNode = byId.get(loop.target);
			if (targetNode?.reviewLoop?.target === node.id) {
				errors.push(`Mutual reviewLoop between "${node.id}" and "${loop.target}" is not allowed.`);
			}
		}
	}

	// Topological wave grouping (Kahn's algorithm)
	const inDegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const node of byId.values()) {
		inDegree.set(node.id, 0);
		dependents.set(node.id, []);
	}
	for (const node of byId.values()) {
		for (const dep of node.dependsOn ?? []) {
			if (byId.has(dep) && dep !== node.id) {
				inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
				dependents.get(dep)!.push(node.id);
			}
		}
	}

	const waves: SubagentNode[][] = [];
	const visited = new Set<string>();
	let frontier = [...byId.values()].filter(n => (inDegree.get(n.id) ?? 0) === 0);

	while (frontier.length > 0) {
		waves.push(frontier);
		const nextFrontier: SubagentNode[] = [];
		for (const node of frontier) {
			visited.add(node.id);
			for (const depId of dependents.get(node.id) ?? []) {
				const nextDeg = (inDegree.get(depId) ?? 1) - 1;
				inDegree.set(depId, nextDeg);
				if (nextDeg === 0) {
					nextFrontier.push(byId.get(depId)!);
				}
			}
		}
		frontier = nextFrontier;
	}

	if (visited.size < byId.size) {
		errors.push('Sub-agent DAG contains a dependency cycle.');
	}

	return { valid: errors.length === 0, errors, waves };
}

/**
 * Executes a validated, immutable sub-agent DAG wave-by-wave (nodes in the same wave run in
 * parallel via `Promise.all`), each with isolated context (`outputsByNode` passed explicitly)
 * and optional bounded review loops.
 */
export async function runSubagentDag(
	nodes: readonly SubagentNode[],
	executor: (node: SubagentNode, dependencyOutputs: ReadonlyMap<string, string>) => Promise<{ ok: boolean; output: string }>,
): Promise<SubagentDagRunSummary> {
	const validation = validateSubagentDag(nodes);
	if (!validation.valid) {
		throw new Error(`Invalid sub-agent DAG: ${validation.errors.join(' ')}`);
	}

	const byId = new Map(nodes.map(n => [n.id, n]));
	const resultsById = new Map<string, SubagentNodeResult>();
	const outputs = new Map<string, string>();

	for (const wave of validation.waves) {
		await Promise.all(wave.map(async node => {
			const failedDep = (node.dependsOn ?? []).find(dep => resultsById.get(dep)?.status !== 'succeeded');
			if (failedDep) {
				resultsById.set(node.id, { id: node.id, status: 'skipped', output: `Skipped: dependency "${failedDep}" did not succeed.`, iterations: 0 });
				return;
			}

			let iterations = 0;
			let lastOk = false;
			let lastOutput = '';

			while (true) {
				iterations++;
				const res = await executor(node, outputs);
				lastOk = res.ok;
				lastOutput = res.output;
				outputs.set(node.id, lastOutput);

				const loop = node.reviewLoop;
				if (
					!lastOk
					|| !loop
					|| iterations >= loop.maxIterations
					|| !lastOutput.includes(loop.trigger)
				) {
					break;
				}
				const targetNode = byId.get(loop.target);
				if (!targetNode) {
					break;
				}
				const rerun = await executor(targetNode, outputs);
				outputs.set(targetNode.id, rerun.output);
				const prevTarget = resultsById.get(targetNode.id);
				resultsById.set(targetNode.id, {
					id: targetNode.id,
					status: rerun.ok ? 'succeeded' : 'failed',
					output: rerun.output,
					iterations: (prevTarget?.iterations ?? 1) + 1,
				});
				if (!rerun.ok) {
					break;
				}
			}

			resultsById.set(node.id, {
				id: node.id,
				status: lastOk ? 'succeeded' : 'failed',
				output: lastOutput,
				iterations,
			});
		}));
	}

	return { results: nodes.map(n => resultsById.get(n.id)!) };
}
