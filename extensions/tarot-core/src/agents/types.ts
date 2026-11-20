/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type BuiltInAgentId = 'claude' | 'codex' | 'agy';
export type AgentId = BuiltInAgentId | (string & {});
export type AgentMode = 'vibe' | 'spec' | 'plan';
export type AutonomyMode = 'autopilot' | 'supervised';

export type ContextProviderKind = 'file' | 'folder' | 'spec' | 'problems' | 'gitDiff' | 'terminal' | 'codebase' | 'steering';

export interface CustomAgentConfig {
	readonly id: string;
	readonly displayName: string;
	readonly binary: string;
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
	readonly cwd: string;
	readonly systemContext?: string;
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
	readonly elapsedMs?: number;
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
