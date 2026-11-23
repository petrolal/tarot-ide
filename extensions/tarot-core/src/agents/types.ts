/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type BuiltInAgentId = 'claude' | 'codex' | 'agy';
export type AgentId = BuiltInAgentId | (string & {});
export type AgentMode = 'vibe' | 'spec' | 'plan';
/**
 * The 3 composer permission modes (MIGRATION_PLAN.md M3.8a, replacing the old binary
 * Autopilot/Supervised toggle): `supervised` approves per turn with hunk-level review,
 * `acceptFileChanges` applies edits directly (the old `autopilot`), `approveForMe` auto-answers
 * low-risk approval prompts via the permissions policy. All 3 are **advisory** for BYOA CLIs —
 * see `permissions/policyEngine.ts::getEnforcementKind`.
 */
export type AutonomyMode = 'supervised' | 'acceptFileChanges' | 'approveForMe';
export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentModelOption {
	readonly id: string;
	readonly label: string;
}

export type ContextProviderKind = 'file' | 'folder' | 'spec' | 'problems' | 'gitDiff' | 'terminal' | 'codebase' | 'steering' | 'mcp';

export interface CustomAgentConfig {
	readonly id: string;
	readonly displayName: string;
	readonly binary: string;
	readonly protocol?: 'cli' | 'acp';
	readonly args?: readonly string[];
	readonly versionArgs?: readonly string[];
}

export interface AgentStatus {
	readonly id: AgentId;
	readonly displayName: string;
	readonly binary: string;
	readonly available: boolean;
	readonly resolvedPath?: string;
	readonly version?: string;
	readonly installHint?: string;
	readonly error?: string;
}

export interface AttachedContext {
	readonly kind: ContextProviderKind;
	readonly label: string;
	readonly path?: string;
	readonly selection?: string;
	readonly content?: string;
}

export interface AgentRunRequest {
	readonly prompt: string;
	readonly mode: AgentMode;
	readonly autonomy: AutonomyMode;
	readonly model?: string;
	readonly effort?: ReasoningEffort;
	readonly cwd: string;
	readonly systemContext?: string;
	/** Auto-surfaced `.tarot/specs/**` content for the Spec most relevant to this turn (active editor, or the only Spec in the workspace) — see `promptBuilder.ts`. */
	readonly specContext?: string;
	readonly attachments?: readonly AttachedContext[];
	readonly conversationHistory?: readonly SessionMessage[];
	readonly timeoutMs: number;
}

export type AgentEventType = 'text' | 'thought' | 'tool_start' | 'tool_end' | 'diff' | 'status' | 'error' | 'done';

export interface AgentEvent {
	readonly type: AgentEventType;
	readonly content?: string;
	readonly toolName?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentAdapter {
	readonly id: AgentId;
	readonly displayName: string;
	readonly binary: string;
	readonly installHint: string;
	detect(): Promise<AgentStatus>;
	listModels?(): Promise<readonly AgentModelOption[]>;
	run(request: AgentRunRequest, onEvent: (event: AgentEvent) => void, token: vscode.CancellationToken): Promise<void>;
}

export interface TaskProgressItem {
	readonly label: string;
	readonly completed: boolean;
}

export interface TaskProgressCard {
	readonly title: string;
	readonly done: number;
	readonly total: number;
	readonly items: readonly TaskProgressItem[];
}

export interface SpecApprovalGate {
	readonly specDir: string;
	readonly specSlug: string;
	readonly targetPhase: 'requirements' | 'design' | 'tasks';
	readonly label: string;
	approved?: boolean;
}

/**
 * Post-hoc `fs_write` review for files this turn actually changed and the permissions policy
 * resolves to `ask` (Tarot cannot deny a BYOA agent's own write before it happens — see
 * `policyEngine.ts::getEnforcementKind` — so this is the enforcement point: keep the write, or
 * revert exactly these files back to the pre-turn checkpoint).
 */
export interface FileWriteApprovalGate {
	readonly sessionId: string;
	readonly checkpointId: string;
	readonly files: readonly string[];
	resolution?: 'kept' | 'reverted';
}

export interface SessionMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'system';
	readonly agentId?: AgentId;
	readonly mode: AgentMode;
	readonly content: string;
	readonly thought?: string;
	readonly tools?: readonly string[];
	readonly attachments?: readonly AttachedContext[];
	readonly appliedSteering?: readonly string[];
	readonly taskProgress?: TaskProgressCard;
	readonly approvalGate?: SpecApprovalGate;
	readonly fileWriteGate?: FileWriteApprovalGate;
	readonly elapsedMs?: number;
	readonly totalTokens?: number;
	readonly checkpointId?: string;
	readonly timestamp: string;
}

export interface AgentSession {
	readonly id: string;
	title: string;
	readonly createdAt: string;
	updatedAt: string;
	activeAgentId: AgentId;
	mode: AgentMode;
	autonomy: AutonomyMode;
	messages: SessionMessage[];
}
