/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { ReasoningEffort } from '../agents/types';

export type WorkflowInputHint = 'prompt' | 'file' | 'string';
export type CompletionSignal = 'success' | 'need_input' | 'error';
export type RepeatMaxAction = 'abort' | 'continue' | 'pause';
export type ParallelJoinPolicy = 'all' | 'allSettled' | 'any';
export type WatchHandlerKind = 'github-pr' | 'command';
export type WatchOutcomeKind = 'idle' | 'new-activity' | 'terminal-state';

export type WorkflowRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted';
export type WorkflowPauseReason = 'needs_input' | 'boundary' | 'iteration_cap';
export type WorkflowStepStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'skipped';

export interface StopConditionFileCheck {
	readonly path: string;
	readonly jsonPath?: string;
	readonly value: unknown;
}

export interface RepeatStopCondition {
	readonly containsText?: string;
	readonly completionSignal?: CompletionSignal;
	readonly fileCheck?: StopConditionFileCheck;
}

export interface WorkflowStepNode {
	readonly type: 'step';
	readonly id: string;
	readonly agent: string;
	readonly prompt: string;
	readonly artifacts?: readonly string[];
	readonly captureOutput?: boolean;
	readonly completion?: CompletionSignal;
	readonly modelId?: string;
	readonly effortLevel?: ReasoningEffort;
}

export interface WorkflowSequenceNode {
	readonly type: 'sequence';
	readonly id: string;
	readonly steps: readonly WorkflowNode[];
}

export interface WorkflowRepeatNode {
	readonly type: 'repeat';
	readonly id: string;
	readonly maxIterations: number;
	readonly onMaxIterations?: RepeatMaxAction;
	readonly stopCondition?: RepeatStopCondition;
	readonly stopWhen?: string;
	readonly steps: readonly WorkflowNode[];
}

export interface WorkflowParallelNode {
	readonly type: 'parallel';
	readonly id: string;
	readonly joinPolicy?: ParallelJoinPolicy;
	readonly branches: readonly WorkflowNode[];
}

export interface WorkflowWatchNode {
	readonly type: 'watch';
	readonly id: string;
	readonly handler: WatchHandlerKind;
	readonly config: Readonly<Record<string, unknown>>;
	readonly idleTimeoutSec?: number;
}

export type WorkflowNode =
	| WorkflowStepNode
	| WorkflowSequenceNode
	| WorkflowRepeatNode
	| WorkflowParallelNode
	| WorkflowWatchNode;

export interface WorkflowRecipe {
	readonly name: string;
	readonly description?: string;
	readonly inputs?: Readonly<Record<string, WorkflowInputHint>>;
	readonly modelId?: string;
	readonly effortLevel?: ReasoningEffort;
	readonly steps: readonly WorkflowNode[];
}

export type RecipeScope = 'workspace' | 'user' | 'bundled';

export interface LoadedRecipe {
	readonly name: string;
	readonly scope: RecipeScope;
	readonly sourceFile: string;
	readonly recipe: WorkflowRecipe;
}

export interface SendMessageSignal {
	readonly severity: 'success' | 'warning' | 'error' | 'info';
	readonly message: string;
}

export interface WorkflowStepState {
	readonly id: string;
	status: WorkflowStepStatus;
	agent?: string;
	output?: string;
	signal?: SendMessageSignal;
	iterations: number;
	startedAt?: string;
	finishedAt?: string;
}

export interface WorkflowRunState {
	readonly id: string;
	readonly recipeName: string;
	readonly createdAt: string;
	updatedAt: string;
	status: WorkflowRunStatus;
	pauseReason?: WorkflowPauseReason;
	inputs: Record<string, string>;
	readonly stepStates: Record<string, WorkflowStepState>;
	readonly outputs: Record<string, string>;
	readonly artifacts: Record<string, string>;
	readonly repeatProgress: Record<string, number>;
	readonly watchCursors: Record<string, unknown>;
	readonly watchTerminal: Record<string, boolean>;
	lastError?: string;
}

export const BUNDLED_WORKFLOW_AGENTS: readonly string[] = [
	'wf-planner',
	'wf-coder',
	'wf-design',
	'wf-design-reviewer',
	'wf-review-aggregator',
	'wf-pr-submitter',
	'wf-pr-responder',
	'wf-auto-researcher',
	'semantic_reviewer',
	'wf-workflow-creator',
];

export const BUILTIN_SUBAGENT_NAMES: ReadonlySet<string> = new Set([
	'context-gathering',
	'general-purpose',
	'validation',
]);
