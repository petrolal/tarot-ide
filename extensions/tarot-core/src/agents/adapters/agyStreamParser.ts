/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { AgentEvent } from '../types';

export interface AgyUsageInfo {
	readonly input_tokens?: number;
	readonly output_tokens?: number;
	readonly thinking_tokens?: number;
	readonly cache_read_tokens?: number;
	readonly total_tokens?: number;
}

export interface AgyStreamParseState {
	emittedText: boolean;
	seenToolSteps: Set<number>;
}

export function createAgyStreamParseState(): AgyStreamParseState {
	return {
		emittedText: false,
		seenToolSteps: new Set<number>(),
	};
}

function formatToolLabel(stepUpdate: Record<string, unknown>): string | undefined {
	const stepType = typeof stepUpdate.step_type === 'string' ? stepUpdate.step_type : '';
	const explicitTool =
		(typeof stepUpdate.tool_name === 'string' && stepUpdate.tool_name) ||
		(typeof stepUpdate.name === 'string' && stepUpdate.name) ||
		(typeof (stepUpdate.tool_call as Record<string, unknown> | undefined)?.name === 'string'
			? String((stepUpdate.tool_call as Record<string, unknown>).name)
			: '');

	const baseName = explicitTool || (stepType && stepType !== 'user_input' && stepType !== 'agent_response' ? stepType : '');
	if (!baseName) {
		return undefined;
	}

	const args = (stepUpdate.tool_call as Record<string, unknown> | undefined)?.arguments as Record<string, unknown> | undefined;
	const target =
		(typeof stepUpdate.file_path === 'string' && stepUpdate.file_path) ||
		(typeof stepUpdate.target_file === 'string' && stepUpdate.target_file) ||
		(typeof stepUpdate.path === 'string' && stepUpdate.path) ||
		(typeof args?.Path === 'string' && args.Path) ||
		(typeof args?.TargetFile === 'string' && args.TargetFile) ||
		(typeof args?.AbsolutePath === 'string' && args.AbsolutePath) ||
		(typeof args?.path === 'string' && args.path) ||
		(typeof stepUpdate.command === 'string' && stepUpdate.command) ||
		(typeof args?.CommandLine === 'string' && args.CommandLine) ||
		'';

	return target ? `${baseName} ${target}` : baseName;
}

/**
 * Parses a single NDJSON line from `agy --output-format stream-json`.
 * Pure helper (zero `vscode` dependency) for unit testing.
 */
export function parseAgyStreamLine(line: string, state: AgyStreamParseState): AgentEvent[] {
	const trimmed = line.trim();
	if (!trimmed.startsWith('{')) {
		return [];
	}

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(trimmed) as Record<string, unknown>;
	} catch {
		return [];
	}

	const events: AgentEvent[] = [];
	const eventName = typeof payload.event === 'string' ? payload.event : '';

	if (eventName === 'step_update' && payload.step_update && typeof payload.step_update === 'object') {
		const su = payload.step_update as Record<string, unknown>;
		const stepIndex = typeof su.step_index === 'number' ? su.step_index : -1;

		const thinkingDelta =
			(typeof su.thinking_delta === 'string' && su.thinking_delta) ||
			(typeof su.thought_delta === 'string' && su.thought_delta) ||
			(typeof su.thinking === 'string' && su.thinking) ||
			'';
		if (thinkingDelta) {
			events.push({ type: 'thought', content: thinkingDelta });
		}

		const textDelta = typeof su.text_delta === 'string' ? su.text_delta : '';
		if (textDelta) {
			state.emittedText = true;
			events.push({ type: 'text', content: textDelta });
		}

		const toolLabel = formatToolLabel(su);
		if (toolLabel && (stepIndex < 0 || !state.seenToolSteps.has(stepIndex))) {
			if (stepIndex >= 0) {
				state.seenToolSteps.add(stepIndex);
			}
			// `step_update` is reported once per step with no separate completion event, so
			// start/end fire together (same caveat as the Codex adapter).
			events.push({ type: 'tool_start', toolName: toolLabel });
			events.push({ type: 'tool_end', toolName: toolLabel });
			events.push({ type: 'status', content: `Running ${toolLabel}...` });
		}

		if (su.usage && typeof su.usage === 'object') {
			events.push({ type: 'status', metadata: { usage: su.usage as AgyUsageInfo } });
		}

		return events;
	}

	if (eventName === 'result' && payload.result && typeof payload.result === 'object') {
		const res = payload.result as Record<string, unknown>;
		if (res.status === 'ERROR' || typeof res.error === 'string') {
			events.push({ type: 'error', content: typeof res.error === 'string' ? res.error : 'agy execution failed.' });
		} else if (!state.emittedText && typeof res.response === 'string' && res.response.length > 0) {
			state.emittedText = true;
			events.push({ type: 'text', content: res.response });
		}
		if (res.usage && typeof res.usage === 'object') {
			events.push({ type: 'status', metadata: { usage: res.usage as AgyUsageInfo } });
		}
		return events;
	}

	// Fallback compatibility for older/alternative JSON schemas
	if (typeof payload.delta === 'string' && payload.delta.length > 0) {
		state.emittedText = true;
		events.push({ type: 'text', content: payload.delta });
	} else if (typeof payload.text === 'string' && payload.text.length > 0) {
		state.emittedText = true;
		events.push({ type: 'text', content: payload.text });
	} else if (typeof payload.error === 'string' && payload.error.length > 0) {
		events.push({ type: 'error', content: payload.error });
	}

	return events;
}
