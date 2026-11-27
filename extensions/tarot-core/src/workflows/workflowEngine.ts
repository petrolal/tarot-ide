/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ReasoningEffort } from '../agents/types';
import { validateWorkflow } from './recipeValidator';
import { TarotWorkflowRunStore } from './runStore';
import { resolveWorkflowTemplate } from './templateResolver';
import { runWatchPoll, WatchPollResult } from './watchHandlers';
import {
	RepeatStopCondition,
	SendMessageSignal,
	WorkflowNode,
	WorkflowRecipe,
	WorkflowRepeatNode,
	WorkflowRunState,
	WorkflowRunStatus,
	WorkflowStepNode,
	WorkflowWatchNode,
} from './workflowTypes';

export interface WorkflowStepExecutionRequest {
	readonly runId: string;
	readonly step: WorkflowStepNode;
	readonly resolvedPrompt: string;
	readonly modelId?: string;
	readonly effortLevel?: ReasoningEffort;
	readonly workspaceRoot: string;
}

export interface WorkflowStepExecutionResult {
	readonly ok: boolean;
	readonly output: string;
	readonly signal?: SendMessageSignal;
	readonly artifacts?: Readonly<Record<string, string>>;
}

export interface WorkflowEngineHooks {
	readonly executeStep: (req: WorkflowStepExecutionRequest) => Promise<WorkflowStepExecutionResult>;
	readonly executeWatch?: (node: WorkflowWatchNode, run: WorkflowRunState) => Promise<WatchPollResult>;
	readonly shouldPause?: () => boolean;
	readonly shouldAbort?: () => boolean;
	readonly parentModelId?: string;
	readonly parentEffortLevel?: ReasoningEffort;
	readonly onStateChange?: (run: WorkflowRunState) => void;
	/** Optional override (ms) for delay between `watch` idle polls (useful in unit tests). */
	readonly watchPollDelayMs?: number;
}

/**
 * Extracts a structured `send_message` signal from a BYOA CLI's stdout when native MCP tool
 * signaling is not available, supporting markers like `[SEND_MESSAGE:warning] Need API key`.
 * Pure — unit-testable.
 */
export function parseSendMessageFromOutput(output: string): SendMessageSignal | undefined {
	const m = /\[SEND_MESSAGE:(success|warning|error|info)\]\s*([^\n]+)/i.exec(output);
	if (!m) {
		return undefined;
	}
	return {
		severity: m[1].toLowerCase() as SendMessageSignal['severity'],
		message: m[2].trim(),
	};
}

/** Resolves dotted jsonPath (optional leading `$.`) on a parsed JSON object. */
export function readDottedJsonPath(obj: unknown, jsonPath: string): unknown {
	const cleaned = jsonPath.trim().startsWith('$.') ? jsonPath.trim().slice(2) : jsonPath.trim();
	const parts = cleaned.split('.');
	let current: unknown = obj;
	for (const part of parts) {
		if (!current || typeof current !== 'object' || !(part in (current as Record<string, unknown>))) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/** Resolves effective model & effort: step > workflow > parent session > undefined (agent default). */
export function resolveStepModelAndEffort(
	step: WorkflowStepNode,
	recipe: WorkflowRecipe,
	parentModelId?: string,
	parentEffortLevel?: ReasoningEffort,
): { readonly modelId?: string; readonly effortLevel?: ReasoningEffort } {
	return {
		modelId: step.modelId ?? recipe.modelId ?? parentModelId,
		effortLevel: step.effortLevel ?? recipe.effortLevel ?? parentEffortLevel,
	};
}

/**
 * Core M3.9a Workflow Execution Engine:
 * - Validates recipe via `validateWorkflow` before running.
 * - Executes `step`, `sequence`, `repeat`, `parallel` (`all`/`allSettled`/`any`) and `watch`.
 * - Persists checkpoints at every node boundary via `TarotWorkflowRunStore` so runs can pause
 *   cooperatively and resume cleanly after an IDE restart.
 * - Supports `updateWorkflow` to swap in a revised remaining plan while preserving completed nodes.
 * Pure Node.js — zero `vscode` import so the entire engine is unit-testable via `node --test`.
 */
/**
 * Relative importance of each terminal/semi-terminal run status, used by `escalateRunStatus` to
 * resolve TD-10: `parallel` branches run concurrently (`Promise.all`) and each mutates the same
 * shared `run.status` directly with no other coordination, so whichever branch writes last used
 * to win outright — a branch that fails after a sibling already paused for input could silently
 * clobber the pause into a failure, hiding that the run is actually blocked on a human.
 */
const RUN_STATUS_PRIORITY: Record<WorkflowRunStatus, number> = {
	pending: 0,
	running: 0,
	completed: 1,
	failed: 2,
	paused: 3,
	aborted: 4,
};

export class TarotWorkflowEngine {
	constructor(private readonly runStore: TarotWorkflowRunStore) { }

	/**
	 * Sets `run.status` (and optionally `run.pauseReason`) only if `status` is at least as
	 * important as whatever is already there, per `RUN_STATUS_PRIORITY`. See TD-10.
	 */
	private escalateRunStatus(run: WorkflowRunState, status: WorkflowRunStatus, pauseReason?: WorkflowRunState['pauseReason']): void {
		if (RUN_STATUS_PRIORITY[status] < RUN_STATUS_PRIORITY[run.status]) {
			return;
		}
		run.status = status;
		if (pauseReason !== undefined) {
			run.pauseReason = pauseReason;
		}
	}

	createRunState(recipe: WorkflowRecipe, inputs: Readonly<Record<string, string>>): WorkflowRunState {
		const now = new Date().toISOString();
		return {
			id: `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
			recipeName: recipe.name,
			createdAt: now,
			updatedAt: now,
			status: 'pending',
			inputs,
			stepStates: {},
			outputs: {},
			artifacts: {},
			repeatProgress: {},
			watchCursors: {},
			watchTerminal: {},
		};
	}

	async run(
		recipe: WorkflowRecipe,
		workspaceRoot: string,
		inputs: Readonly<Record<string, string>>,
		hooks: WorkflowEngineHooks,
		existingRun?: WorkflowRunState,
	): Promise<WorkflowRunState> {
		const validation = validateWorkflow(recipe, workspaceRoot);
		if (!validation.valid) {
			throw new Error(`Invalid workflow "${recipe.name}": ${validation.errors.join(' ')}`);
		}

		const run = existingRun ?? this.createRunState(recipe, { ...inputs });
		if (existingRun) {
			run.inputs = { ...run.inputs, ...inputs };
		}
		run.status = 'running';
		run.pauseReason = undefined;
		await this.checkpoint(workspaceRoot, run, hooks);

		try {
			const ok = await this.executeNodeList(recipe, recipe.steps, workspaceRoot, run, hooks);
			if (run.status === 'running') {
				run.status = ok ? 'completed' : 'failed';
			}
		} catch (err) {
			run.status = 'failed';
			run.lastError = err instanceof Error ? err.message : String(err);
		}

		await this.checkpoint(workspaceRoot, run, hooks);
		return run;
	}

	/**
	 * Validates and resumes a run with an updated recipe plan, preserving every node already
	 * recorded as `completed` in `run.stepStates`.
	 */
	async updateWorkflow(
		revisedRecipe: WorkflowRecipe,
		workspaceRoot: string,
		run: WorkflowRunState,
		hooks: WorkflowEngineHooks,
	): Promise<WorkflowRunState> {
		const validation = validateWorkflow(revisedRecipe, workspaceRoot);
		if (!validation.valid) {
			throw new Error(`Invalid updated workflow: ${validation.errors.join(' ')}`);
		}
		return this.run(revisedRecipe, workspaceRoot, run.inputs, hooks, run);
	}

	private async checkpoint(workspaceRoot: string, run: WorkflowRunState, hooks: WorkflowEngineHooks): Promise<void> {
		await this.runStore.saveRun(workspaceRoot, run);
		hooks.onStateChange?.(run);
	}

	private async executeNodeList(
		recipe: WorkflowRecipe,
		nodes: readonly WorkflowNode[],
		workspaceRoot: string,
		run: WorkflowRunState,
		hooks: WorkflowEngineHooks,
	): Promise<boolean> {
		let previousOutput: string | undefined;

		for (const node of nodes) {
			if (hooks.shouldAbort?.()) {
				this.escalateRunStatus(run, 'aborted');
				return false;
			}
			if (hooks.shouldPause?.()) {
				this.escalateRunStatus(run, 'paused', 'boundary');
				return false;
			}

			const ok = await this.executeNode(recipe, node, workspaceRoot, run, hooks, previousOutput);
			if (!ok || run.status !== 'running') {
				return false;
			}
			if (node.id in run.outputs) {
				previousOutput = run.outputs[node.id];
			}
			await this.checkpoint(workspaceRoot, run, hooks);
		}
		return true;
	}

	private async executeNode(
		recipe: WorkflowRecipe,
		node: WorkflowNode,
		workspaceRoot: string,
		run: WorkflowRunState,
		hooks: WorkflowEngineHooks,
		previousOutput?: string,
		suppressRunFailure = false,
	): Promise<boolean> {
		switch (node.type) {
			case 'step': {
				const existing = run.stepStates[node.id];
				if (existing?.status === 'completed') {
					return true;
				}
				const inputStr = run.inputs.task ?? run.inputs.input ?? Object.values(run.inputs)[0] ?? '';
				const { resolved } = resolveWorkflowTemplate(node.prompt, {
					input: inputStr,
					inputs: run.inputs,
					previousOutput,
					stepOutputs: run.outputs,
					artifacts: run.artifacts,
				});
				let effectivePrompt = resolved;
				if (run.inputs.user_reply) {
					effectivePrompt = `${resolved}\n\n[User reply]: ${run.inputs.user_reply}`;
					delete run.inputs.user_reply;
				}

				const stepState = existing ?? { id: node.id, status: 'running', agent: node.agent, iterations: 0 };
				stepState.status = 'running';
				stepState.iterations += 1;
				stepState.startedAt = new Date().toISOString();
				run.stepStates[node.id] = stepState;
				await this.checkpoint(workspaceRoot, run, hooks);

				const { modelId, effortLevel } = resolveStepModelAndEffort(node, recipe, hooks.parentModelId, hooks.parentEffortLevel);
				const res = await hooks.executeStep({
					runId: run.id,
					step: node,
					resolvedPrompt: effectivePrompt,
					modelId,
					effortLevel,
					workspaceRoot,
				});

				const signal = res.signal ?? parseSendMessageFromOutput(res.output);
				stepState.output = res.output;
				stepState.signal = signal;
				stepState.finishedAt = new Date().toISOString();

				if (node.captureOutput !== false) {
					run.outputs[node.id] = res.output;
				}
				if (res.artifacts) {
					Object.assign(run.artifacts, res.artifacts);
				}

				if (signal?.severity === 'warning' || (!signal && node.completion === 'need_input')) {
					stepState.status = 'paused';
					this.escalateRunStatus(run, 'paused', 'needs_input');
					return false;
				}
				if (!res.ok || signal?.severity === 'error' || (!signal && node.completion === 'error')) {
					stepState.status = 'failed';
					if (!suppressRunFailure) {
						this.escalateRunStatus(run, 'failed');
					}
					run.lastError = signal?.message || `Step "${node.id}" failed.`;
					return false;
				}
				stepState.status = 'completed';
				return true;
			}

			case 'sequence':
				return this.executeNodeList(recipe, node.steps, workspaceRoot, run, hooks);

			case 'repeat':
				return this.executeRepeat(recipe, node, workspaceRoot, run, hooks);

			case 'parallel': {
				const policy = node.joinPolicy ?? 'all';
				const allowBranchFailure = policy !== 'all';
				const branchResults = await Promise.all(
					node.branches.map(branch => this.executeNode(recipe, branch, workspaceRoot, run, hooks, undefined, allowBranchFailure)),
				);
				if (run.status === 'paused' || run.status === 'aborted') {
					return false;
				}
				if (policy === 'allSettled') {
					return true;
				}
				if (policy === 'any') {
					if (branchResults.some(Boolean)) {
						return true;
					}
					this.escalateRunStatus(run, 'failed');
					run.lastError = run.lastError || `All branches in parallel "${node.id}" failed.`;
					return false;
				}
				if (branchResults.every(Boolean)) {
					return true;
				}
				this.escalateRunStatus(run, 'failed');
				return false;
			}

			case 'watch': {
				const startedAtMs = Date.now();
				const defaultPollSec = node.handler === 'github-pr' ? 30 : 10;
				const rawPollSec = typeof node.config.pollIntervalSec === 'number' ? node.config.pollIntervalSec : defaultPollSec;
				const pollDelayMs = hooks.watchPollDelayMs ?? Math.max(defaultPollSec, rawPollSec) * 1000;
				const idleTimeoutMs = typeof node.idleTimeoutSec === 'number' && node.idleTimeoutSec > 0
					? node.idleTimeoutSec * 1000
					: undefined;

				while (true) {
					if (hooks.shouldAbort?.()) {
						this.escalateRunStatus(run, 'aborted');
						return false;
					}
					if (hooks.shouldPause?.()) {
						this.escalateRunStatus(run, 'paused', 'boundary');
						return false;
					}

					const poll = hooks.executeWatch
						? await hooks.executeWatch(node, run)
						: await runWatchPoll(node, {
							workspacePath: workspaceRoot,
							cursor: run.watchCursors[node.id],
							config: node.config,
						});
					if (poll.cursor !== undefined) {
						run.watchCursors[node.id] = poll.cursor;
					}
					if (poll.error) {
						this.escalateRunStatus(run, 'failed');
						run.lastError = poll.error;
						return false;
					}
					if (poll.outcome === 'terminal-state') {
						run.watchTerminal[node.id] = true;
					}
					if (poll.payload !== undefined) {
						run.outputs[node.id] = typeof poll.payload === 'string' ? poll.payload : JSON.stringify(poll.payload);
					}
					await this.checkpoint(workspaceRoot, run, hooks);

					if (poll.outcome !== 'idle') {
						return true;
					}
					if (idleTimeoutMs !== undefined && Date.now() - startedAtMs >= idleTimeoutMs) {
						return true;
					}
					if (pollDelayMs > 0) {
						await new Promise(resolve => setTimeout(resolve, pollDelayMs));
					}
				}
			}
		}
	}

	private async executeRepeat(
		recipe: WorkflowRecipe,
		node: WorkflowRepeatNode,
		workspaceRoot: string,
		run: WorkflowRunState,
		hooks: WorkflowEngineHooks,
	): Promise<boolean> {
		let completedIterations = run.repeatProgress[node.id] ?? 0;

		// A `repeat` container always runs at least once (MIGRATION_PLAN.md M3.9a).
		while (completedIterations < node.maxIterations) {
			// When resuming after a mid-iteration pause, keep already-completed steps in this
			// iteration intact instead of resetting them; only reset at the start of a fresh pass.
			const resumingMidIteration = this.hasResumableStepState(node.steps, run);
			if (!resumingMidIteration) {
				this.resetStepStatuses(node.steps, run);
			}

			const ok = await this.executeNodeList(recipe, node.steps, workspaceRoot, run, hooks);
			if (!ok || run.status !== 'running') {
				return false;
			}

			completedIterations++;
			run.repeatProgress[node.id] = completedIterations;

			const stopped = await this.evaluateRepeatStop(node, workspaceRoot, run);
			// Mark child steps pending only after checkpointing if another iteration will follow,
			// so a completed repeat retains its final step states.
			if (!stopped && completedIterations < node.maxIterations) {
				this.resetStepStatuses(node.steps, run);
			}
			await this.checkpoint(workspaceRoot, run, hooks);
			if (stopped) {
				return true;
			}
		}

		const action = node.onMaxIterations ?? 'abort';
		if (action === 'continue') {
			return true;
		}
		if (action === 'pause') {
			this.escalateRunStatus(run, 'paused', 'iteration_cap');
			return false;
		}
		this.escalateRunStatus(run, 'aborted');
		run.lastError = `Repeat "${node.id}" reached maxIterations (${node.maxIterations}).`;
		return false;
	}

	private hasResumableStepState(nodes: readonly WorkflowNode[], run: WorkflowRunState): boolean {
		let hasCompleted = false;
		let hasIncomplete = false;
		const walk = (list: readonly WorkflowNode[]) => {
			for (const n of list) {
				if (n.type === 'step') {
					const st = run.stepStates[n.id]?.status;
					if (st === 'completed') {
						hasCompleted = true;
					} else {
						hasIncomplete = true;
					}
				} else if (n.type === 'sequence' || n.type === 'repeat') {
					walk(n.steps);
				} else if (n.type === 'parallel') {
					walk(n.branches);
				}
			}
		};
		walk(nodes);
		return hasCompleted && hasIncomplete;
	}

	private resetStepStatuses(nodes: readonly WorkflowNode[], run: WorkflowRunState): void {
		for (const n of nodes) {
			if (n.type === 'step' && run.stepStates[n.id]) {
				run.stepStates[n.id].status = 'pending';
			} else if (n.type === 'sequence' || n.type === 'repeat') {
				this.resetStepStatuses(n.steps, run);
			} else if (n.type === 'parallel') {
				this.resetStepStatuses(n.branches, run);
			}
		}
	}

	private async evaluateRepeatStop(
		node: WorkflowRepeatNode,
		workspaceRoot: string,
		run: WorkflowRunState,
	): Promise<boolean> {
		if (node.stopWhen) {
			const expr = node.stopWhen.trim();
			const termMatch = /^([a-zA-Z0-9_-]+)\.terminal$/.exec(expr);
			if (termMatch) {
				return run.watchTerminal[termMatch[1]] === true;
			}
			const containsMatch = /^\{\{\s*([a-zA-Z0-9_.-]+)\.output\s*\}\}\s+contains\s+(.+)$/.exec(expr);
			if (containsMatch) {
				const output = run.outputs[containsMatch[1]] ?? '';
				return output.includes(containsMatch[2].trim());
			}
			return false;
		}
		if (node.stopCondition) {
			return this.evaluateStopCondition(node.stopCondition, node.steps, workspaceRoot, run);
		}
		return false;
	}

	private findLastStepNode(nodes: readonly WorkflowNode[]): WorkflowNode | undefined {
		for (let i = nodes.length - 1; i >= 0; i--) {
			const n = nodes[i];
			if (n.type === 'step' || n.type === 'watch') {
				return n;
			}
			if (n.type === 'sequence' || n.type === 'repeat') {
				const found = this.findLastStepNode(n.steps);
				if (found) {
					return found;
				}
			} else if (n.type === 'parallel') {
				const found = this.findLastStepNode(n.branches);
				if (found) {
					return found;
				}
			}
		}
		return undefined;
	}

	private async evaluateStopCondition(
		cond: RepeatStopCondition,
		bodySteps: readonly WorkflowNode[],
		workspaceRoot: string,
		run: WorkflowRunState,
	): Promise<boolean> {
		const lastChild = this.findLastStepNode(bodySteps) ?? bodySteps[bodySteps.length - 1];
		const lastOutput = lastChild ? (run.outputs[lastChild.id] ?? '') : '';
		const lastSignal = lastChild ? run.stepStates[lastChild.id]?.signal?.severity : undefined;

		if (cond.containsText !== undefined) {
			return lastOutput.includes(cond.containsText);
		}
		if (cond.completionSignal !== undefined) {
			if (cond.completionSignal === 'success') {
				return lastSignal === 'success' || (!lastSignal && lastChild !== undefined && run.stepStates[lastChild.id]?.status === 'completed');
			}
			if (cond.completionSignal === 'need_input') {
				return lastSignal === 'warning';
			}
			return lastSignal === 'error';
		}
		if (cond.fileCheck) {
			const target = path.resolve(workspaceRoot, cond.fileCheck.path);
			const rootAbs = path.resolve(workspaceRoot);
			if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
				return false;
			}
			try {
				const raw = await fs.readFile(target, 'utf8');
				const actual = cond.fileCheck.jsonPath
					? readDottedJsonPath(JSON.parse(raw), cond.fileCheck.jsonPath)
					: raw.trim();
				if (Array.isArray(cond.fileCheck.value)) {
					return cond.fileCheck.value.includes(actual);
				}
				return actual === cond.fileCheck.value;
			} catch {
				return false;
			}
		}
		return false;
	}
}
