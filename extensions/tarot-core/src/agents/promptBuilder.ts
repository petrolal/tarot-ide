/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { AgentRunRequest } from './types';

/**
 * Builds an agent-agnostic prompt combining mode instructions, Steering context,
 * prior session handoff context, attached files/selections, and the user's message.
 */
export function buildEffectivePrompt(request: AgentRunRequest): string {
	const parts: string[] = [];

	if (request.mode === 'spec') {
		parts.push(
			'[Tarot IDE — Spec Mode]\n' +
			'Follow Spec-Driven Development: structure work cleanly into requirements, design, and actionable tasks when requested.'
		);
	}

	if (request.systemContext && request.systemContext.trim().length > 0) {
		parts.push(`[Project Steering Context]\n${request.systemContext.trim()}`);
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
				return `- File: ${att.path}\n\`\`\`\n${att.selection}\n\`\`\``;
			}
			return `- File: ${att.path}`;
		});
		parts.push(`[Attached Workspace Context]\n${attachmentBlocks.join('\n')}`);
	}

	parts.push(request.prompt);
	return parts.join('\n\n');
}
