/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { AgentEvent } from '../types';

/**
 * Pure parser for a single `--output-format stream-json` NDJSON line from Claude Code CLI.
 * When a `result` event arrives and no prior `assistant`/`content_block_delta` text was emitted
 * in this turn (common after tool_use rounds), falls back to emitting `payload.result` as text
 * so final responses are never dropped. Zero `vscode` import — unit-testable.
 */
export function parseClaudeStreamJsonLine(
	line: string,
	onEvent: (event: AgentEvent) => void,
	pendingToolUses: Map<string, string>,
	alreadyEmittedText = false,
): boolean {
	if (!line.startsWith('{')) {
		return false;
	}
	try {
		const payload = JSON.parse(line) as Record<string, unknown>;
		const type = typeof payload.type === 'string' ? payload.type : '';

		if (type === 'assistant') {
			const message = payload.message as { content?: Array<{ type?: string; text?: string; name?: string; id?: string }> } | undefined;
			let produced = false;
			for (const block of message?.content ?? []) {
				if (block.type === 'text' && block.text) {
					onEvent({ type: 'text', content: block.text });
					produced = true;
				} else if (block.type === 'tool_use' && block.name) {
					if (block.id) {
						pendingToolUses.set(block.id, block.name);
					}
					onEvent({ type: 'tool_start', toolName: block.name });
				}
			}
			return produced;
		}

		if (type === 'user') {
			const message = payload.message as { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean }> } | undefined;
			for (const block of message?.content ?? []) {
				if (block.type === 'tool_result' && block.tool_use_id) {
					const toolName = pendingToolUses.get(block.tool_use_id);
					pendingToolUses.delete(block.tool_use_id);
					if (toolName) {
						onEvent({ type: 'tool_end', toolName, metadata: { isError: !!block.is_error } });
					}
				}
			}
			return false;
		}

		if (type === 'content_block_delta') {
			const delta = payload.delta as { text?: string } | undefined;
			if (delta?.text) {
				onEvent({ type: 'text', content: delta.text });
				return true;
			}
		}

		if (type === 'result') {
			const resultText = typeof payload.result === 'string' ? payload.result : '';
			if (payload.is_error && resultText) {
				onEvent({ type: 'error', content: resultText });
				return true;
			}
			if (resultText && !alreadyEmittedText) {
				onEvent({ type: 'text', content: resultText });
				return true;
			}
			return resultText.length > 0;
		}

		return false;
	} catch {
		return false;
	}
}
