/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { BUILTIN_SUBAGENT_NAMES, WorkflowNode, WorkflowRecipe } from './workflowTypes';

export interface WorkflowValidationResult {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
	readonly staticStepCount: number;
	readonly maxDepth: number;
}

const MAX_STATIC_STEPS = 50;
const MAX_NESTING_DEPTH = 8;
const VALID_JOIN_POLICIES = new Set(['all', 'allSettled', 'any']);
const VALID_MAX_ACTIONS = new Set(['abort', 'continue', 'pause']);
const VALID_COMPLETION_SIGNALS = new Set(['success', 'need_input', 'error']);
const VALID_WATCH_HANDLERS = new Set(['github-pr', 'command']);
const STOP_WHEN_TERMINAL_RE = /^[a-zA-Z0-9_-]+\.terminal$/;
const STOP_WHEN_CONTAINS_RE = /^\{\{\s*[a-zA-Z0-9_.-]+\.output\s*\}\}\s+contains\s+.+$/;

/** Validates dotted `jsonPath` syntax (`$.` optional; `[` `]` `*` `..` disallowed per M3.9a). */
export function isValidWorkflowJsonPath(jsonPath: string): boolean {
	const trimmed = jsonPath.trim();
	if (!trimmed) {
		return false;
	}
	if (/[\[\]*]|\.\./.test(trimmed)) {
		return false;
	}
	const body = trimmed.startsWith('$.') ? trimmed.slice(2) : trimmed;
	return /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(body);
}

/** Validates `stopWhen` expression: `<watch-id>.terminal` OR `{{x.output}} contains TEXT`. */
export function isValidStopWhen(expr: string): boolean {
	const trimmed = expr.trim();
	return STOP_WHEN_TERMINAL_RE.test(trimmed) || STOP_WHEN_CONTAINS_RE.test(trimmed);
}

/**
 * Validates a workflow recipe against the official M3.9a schema and limits:
 * - Required fields (`name`, `steps`), valid enums, unique IDs
 * - <= 50 static steps, nesting depth <= 8, positive `maxIterations`
 * - `stopCondition` XOR `stopWhen` on `repeat`, valid `stopWhen` and `jsonPath`
 * - Template ordering (`{{previous.output}}` disallowed in 1st node of container and inside `parallel`)
 * - `fileCheck.path` confined within `workspaceRoot`
 * - Built-in sub-agents disallowed as step agents
 * - `watch` command disallows templates and enforces minimum poll intervals
 * Pure — unit-testable.
 */
export function validateWorkflow(recipe: WorkflowRecipe, workspaceRoot?: string): WorkflowValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!recipe || typeof recipe !== 'object') {
		return { valid: false, errors: ['Workflow recipe must be an object.'], warnings, staticStepCount: 0, maxDepth: 0 };
	}
	if (typeof recipe.name !== 'string' || !recipe.name.trim()) {
		errors.push('Workflow recipe requires a non-empty "name".');
	}
	if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
		errors.push('Workflow recipe requires a non-empty "steps" array.');
		return { valid: false, errors, warnings, staticStepCount: 0, maxDepth: 0 };
	}

	const seenIds = new Set<string>();
	let staticStepCount = 0;
	let maxDepth = 0;
	const rootAbs = workspaceRoot ? path.resolve(workspaceRoot) : undefined;

	const visitList = (nodes: readonly WorkflowNode[], depth: number, inParallel: boolean) => {
		if (depth > maxDepth) {
			maxDepth = depth;
		}
		if (depth > MAX_NESTING_DEPTH) {
			errors.push(`Workflow exceeds maximum nesting depth of ${MAX_NESTING_DEPTH}.`);
			return;
		}
		nodes.forEach((node, idx) => {
			if (!node || typeof node !== 'object') {
				errors.push('Workflow contains an invalid node.');
				return;
			}
			if (typeof node.id !== 'string' || !node.id.trim()) {
				errors.push(`Node of type "${node.type}" is missing a non-empty "id".`);
			} else if (seenIds.has(node.id)) {
				errors.push(`Duplicate node ID "${node.id}".`);
			} else {
				seenIds.add(node.id);
			}

			switch (node.type) {
				case 'step': {
					staticStepCount++;
					if (typeof node.agent !== 'string' || !node.agent.trim()) {
						errors.push(`Step "${node.id}" is missing "agent".`);
					} else if (BUILTIN_SUBAGENT_NAMES.has(node.agent.trim().toLowerCase())) {
						errors.push(`Step "${node.id}" cannot use built-in sub-agent "${node.agent}" as a step agent.`);
					}
					if (typeof node.prompt !== 'string' || !node.prompt.trim()) {
						errors.push(`Step "${node.id}" is missing "prompt".`);
					} else if (/\{\{\s*previous\.output\s*\}\}/.test(node.prompt)) {
						if (inParallel) {
							errors.push(`Step "${node.id}" cannot use "{{previous.output}}" inside a parallel block.`);
						} else if (idx === 0) {
							errors.push(`Step "${node.id}" cannot use "{{previous.output}}" as the first node of a container.`);
						}
					}
					if (node.completion && !VALID_COMPLETION_SIGNALS.has(node.completion)) {
						errors.push(`Step "${node.id}" has invalid completion signal "${node.completion}".`);
					}
					break;
				}
				case 'sequence': {
					if (!Array.isArray(node.steps) || node.steps.length === 0) {
						errors.push(`Sequence "${node.id}" must contain at least one child node.`);
					} else {
						visitList(node.steps, depth + 1, inParallel);
					}
					break;
				}
				case 'repeat': {
					if (!Number.isInteger(node.maxIterations) || node.maxIterations <= 0) {
						errors.push(`Repeat "${node.id}" requires a positive integer "maxIterations".`);
					}
					if (node.onMaxIterations && !VALID_MAX_ACTIONS.has(node.onMaxIterations)) {
						errors.push(`Repeat "${node.id}" has invalid onMaxIterations "${node.onMaxIterations}".`);
					}
					if (node.stopCondition && node.stopWhen) {
						errors.push(`Repeat "${node.id}" cannot specify both "stopCondition" and "stopWhen".`);
					}
					if (node.stopWhen && !isValidStopWhen(node.stopWhen)) {
						errors.push(`Repeat "${node.id}" has malformed stopWhen "${node.stopWhen}".`);
					}
					if (node.stopCondition?.completionSignal && !VALID_COMPLETION_SIGNALS.has(node.stopCondition.completionSignal)) {
						errors.push(`Repeat "${node.id}" has invalid stopCondition.completionSignal "${node.stopCondition.completionSignal}".`);
					}
					if (node.stopCondition?.fileCheck) {
						const fc = node.stopCondition.fileCheck;
						if (!fc.path || !fc.path.trim()) {
							errors.push(`Repeat "${node.id}" fileCheck requires a non-empty path.`);
						} else {
							const normalized = fc.path.replace(/\\/g, '/');
							if (path.isAbsolute(fc.path) || normalized.startsWith('..') || normalized.includes('/../')) {
								errors.push(`Repeat "${node.id}" fileCheck path "${fc.path}" must stay inside the workspace.`);
							} else if (rootAbs) {
								const resolved = path.resolve(rootAbs, fc.path);
								if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
									errors.push(`Repeat "${node.id}" fileCheck path "${fc.path}" escapes the workspace.`);
								}
							}
						}
						if (fc.jsonPath !== undefined && !isValidWorkflowJsonPath(fc.jsonPath)) {
							errors.push(`Repeat "${node.id}" has invalid fileCheck jsonPath "${fc.jsonPath}".`);
						}
					}
					if (!Array.isArray(node.steps) || node.steps.length === 0) {
						errors.push(`Repeat "${node.id}" must contain at least one child node.`);
					} else {
						visitList(node.steps, depth + 1, inParallel);
					}
					break;
				}
				case 'parallel': {
					if (node.joinPolicy && !VALID_JOIN_POLICIES.has(node.joinPolicy)) {
						errors.push(`Parallel "${node.id}" has invalid joinPolicy "${node.joinPolicy}".`);
					}
					if (!Array.isArray(node.branches) || node.branches.length === 0) {
						errors.push(`Parallel "${node.id}" must contain at least one branch.`);
					} else {
						visitList(node.branches, depth + 1, true);
					}
					break;
				}
				case 'watch': {
					if (!VALID_WATCH_HANDLERS.has(node.handler)) {
						errors.push(`Watch "${node.id}" has invalid handler "${node.handler}".`);
					}
					const poll = node.config?.pollIntervalSec;
					if (node.handler === 'command') {
						const cmd = node.config?.command;
						if (typeof cmd !== 'string' || !cmd.trim()) {
							errors.push(`Watch "${node.id}" (command) requires config.command.`);
						} else if (/\{\{.*\}\}/.test(cmd)) {
							errors.push(`Watch "${node.id}" (command) cannot use templates inside config.command.`);
						}
						if (typeof poll === 'number' && poll < 10) {
							errors.push(`Watch "${node.id}" (command) requires pollIntervalSec >= 10.`);
						}
					} else if (node.handler === 'github-pr') {
						if (typeof poll === 'number' && poll < 30) {
							errors.push(`Watch "${node.id}" (github-pr) requires pollIntervalSec >= 30.`);
						}
					}
					break;
				}
				default:
					errors.push(`Unknown workflow node type "${String((node as { type?: unknown }).type)}".`);
			}
		});
	};

	visitList(recipe.steps, 1, false);

	if (staticStepCount > MAX_STATIC_STEPS) {
		errors.push(`Workflow has ${staticStepCount} static steps (maximum is ${MAX_STATIC_STEPS}).`);
	}

	return { valid: errors.length === 0, errors, warnings, staticStepCount, maxDepth };
}
