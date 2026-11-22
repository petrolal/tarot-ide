/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { AgentRunRequest } from './types';

/**
 * Per-section cap on Steering context and each attachment's content: every adapter passes the
 * built prompt as a single CLI argument (`commandLineLimits.ts` guards the hard OS ceiling right
 * before spawn), so one unbounded file attachment or steering doc should not alone be able to
 * dominate that budget or sit needlessly in full in the child process's argv.
 */
const MAX_SECTION_CHARS = 50_000;

function truncateSection(text: string, label: string): string {
	if (text.length <= MAX_SECTION_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_SECTION_CHARS)}\n[... ${label} truncated: ${text.length - MAX_SECTION_CHARS} more characters omitted ...]`;
}

/**
 * Builds an agent-agnostic prompt combining mode, autonomy level, Steering context,
 * prior session handoff context, attached `#` context providers, and the user's message.
 */
export function buildEffectivePrompt(request: AgentRunRequest): string {
	const parts: string[] = [];

	if (request.mode === 'spec') {
		parts.push(
			'[Tarot IDE — Spec Mode]\n' +
			'Follow Spec-Driven Development (Tarot workflow): use EARS notation (WHEN ... THE SYSTEM SHALL ...) for requirements, produce structured design and discrete tasks before editing code.'
		);
	} else if (request.mode === 'plan') {
		parts.push(
			'[Tarot IDE — Plan Mode (Read-Only)]\n' +
			'Analyze the codebase and propose a clear step-by-step plan WITHOUT modifying files or running destructive commands.'
		);
	}

	if (request.autonomy === 'supervised' && request.mode !== 'plan') {
		parts.push(
			'[Autonomy: Supervised]\n' +
			'Keep edits incremental, clearly explain each file change and wait for user review before large refactors or destructive shell commands.'
		);
	} else if (request.autonomy === 'approveForMe' && request.mode !== 'plan') {
		parts.push(
			'[Autonomy: Approve For Me]\n' +
			'Proceed with low-risk edits and read-only commands without asking; still explain any large refactor or destructive shell command before running it.'
		);
	}

	if (request.systemContext && request.systemContext.trim().length > 0) {
		parts.push(`[Project Steering Context]\n${truncateSection(request.systemContext.trim(), 'Steering Context')}`);
	}

	if (request.specContext && request.specContext.trim().length > 0) {
		parts.push(`[Active Spec Context]\n${truncateSection(request.specContext.trim(), 'Spec Context')}`);
	}

	if (request.conversationHistory && request.conversationHistory.length > 0) {
		const recent = request.conversationHistory.slice(-6);
		const transcript = recent
			.map(m => `${m.role === 'user' ? 'User' : `Assistant (${m.agentId ?? 'agent'})`}: ${m.content.slice(0, 1200)}`)
			.join('\n\n');
		parts.push(`[Prior Session Context]\n${transcript}`);
	}

	if (request.attachments && request.attachments.length > 0) {
		const attachmentBlocks = request.attachments.map(att => {
			if (att.selection && att.selection.trim().length > 0) {
				return `### #${att.label}\nPath: ${att.path ?? 'workspace'}\n\`\`\`\n${truncateSection(att.selection, `#${att.label}`)}\n\`\`\``;
			}
			if (att.content && att.content.trim().length > 0) {
				return `### #${att.label}\n${truncateSection(att.content, `#${att.label}`)}`;
			}
			return `### #${att.label}\nPath: ${att.path ?? 'workspace'}`;
		});
		parts.push(`[Attached # Context Providers]\n${attachmentBlocks.join('\n\n')}`);
	}

	parts.push(request.prompt);
	return parts.join('\n\n');
}
