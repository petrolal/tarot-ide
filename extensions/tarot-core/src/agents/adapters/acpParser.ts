/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { AgentEvent, AgentMode, AutonomyMode } from '../types';

export interface JsonRpcMessage {
	readonly jsonrpc?: string;
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code?: number; readonly message?: string };
}

export interface AcpPermissionOption {
	readonly optionId?: string;
	readonly kind?: string;
}

/**
 * Pure permission option resolver for ACP `session/request_permission`.
 * Respects Tarot's evaluated policy decision first (`deny` / `allow`), and falls back
 * to the composer autonomy/mode when the policy returns `ask` or is unavailable.
 */
export function resolveAcpPermissionOption(
	params: Record<string, unknown> | undefined,
	mode: AgentMode,
	autonomy: AutonomyMode,
	policyDecision?: 'allow' | 'deny' | 'ask',
): AcpPermissionOption | undefined {
	const options = Array.isArray(params?.options) ? params!.options as AcpPermissionOption[] : [];
	if (options.length === 0) {
		return undefined;
	}
	const allowOpt = options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0];
	const rejectOpt = options.find(o => o.kind === 'reject_once' || o.kind === 'reject_always');

	if (policyDecision === 'deny') {
		return rejectOpt;
	}
	if (policyDecision === 'allow') {
		return allowOpt;
	}
	if (mode === 'plan' || autonomy === 'supervised') {
		return rejectOpt ?? allowOpt;
	}
	return allowOpt;
}

/**
 * Translates an ACP `session/update` notification into Tarot `AgentEvent`s.
 * Pure — no `vscode` import so it stays unit-testable via `node --test`.
 */
export function parseAcpSessionUpdate(params: Record<string, unknown> | undefined): AgentEvent[] {
	if (!params) {
		return [];
	}
	const update = (params.update && typeof params.update === 'object' ? params.update : params) as Record<string, unknown>;
	const kind = typeof update.sessionUpdate === 'string'
		? update.sessionUpdate
		: (typeof update.type === 'string' ? update.type : '');

	const contentObj = (update.content && typeof update.content === 'object' ? update.content : undefined) as Record<string, unknown> | undefined;
	const text = typeof contentObj?.text === 'string'
		? contentObj.text
		: (typeof update.text === 'string' ? update.text : undefined);

	if (kind === 'agent_message_chunk' || kind === 'text') {
		return text ? [{ type: 'text', content: text }] : [];
	}
	if (kind === 'agent_thought_chunk' || kind === 'thought') {
		return text ? [{ type: 'thought', content: text }] : [];
	}
	if (kind === 'tool_call') {
		const title = typeof update.title === 'string' ? update.title : (typeof update.toolName === 'string' ? update.toolName : 'tool');
		return [{ type: 'tool_start', toolName: title }];
	}
	if (kind === 'tool_call_update') {
		const status = typeof update.status === 'string' ? update.status : '';
		const title = typeof update.title === 'string' ? update.title : (typeof update.toolName === 'string' ? update.toolName : 'tool');
		if (status === 'completed' || status === 'failed') {
			return [{ type: 'tool_end', toolName: title }];
		}
	}
	return [];
}
