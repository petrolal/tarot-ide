/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { AgentSession, AttachedContext, SessionMessage } from '../agents/types';

export interface ContextMeterSnapshot {
	readonly usedTokens: number;
	readonly windowTokens: number;
	readonly percent: number;
	readonly isRealTokens: boolean;
}

export interface CompactionOptions {
	readonly excludeMessages?: number;
	readonly postCompactionContext?: string;
}

export interface CompactionResult {
	readonly compacted: boolean;
	readonly messages: SessionMessage[];
	readonly removedCount: number;
	readonly droppedSteering: readonly string[];
}

const DEFAULT_WINDOW_TOKENS = 200_000;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Computes the real context meter (MIGRATION_PLAN.md M3.8c): anchors on the latest real
 * `totalTokens` reported by the local agent CLI and adds calibrated token estimates for any
 * messages or attachments added after that turn. Pure — unit-testable.
 */
export function computeContextMeter(
	messages: readonly Pick<SessionMessage, 'content' | 'thought' | 'totalTokens'>[],
	attachments: readonly Pick<AttachedContext, 'content' | 'selection'>[],
	options?: { readonly windowTokens?: number },
): ContextMeterSnapshot {
	const windowTokens = Math.max(8_000, options?.windowTokens ?? DEFAULT_WINDOW_TOKENS);

	let lastRealIdx = -1;
	let baseTokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const t = messages[i].totalTokens;
		if (typeof t === 'number' && t > 0) {
			lastRealIdx = i;
			baseTokens = t;
			break;
		}
	}

	let deltaTokens = 0;
	for (let i = lastRealIdx + 1; i < messages.length; i++) {
		deltaTokens += estimateTokens(messages[i].content);
		if (messages[i].thought) {
			deltaTokens += estimateTokens(messages[i].thought!);
		}
	}
	for (const att of attachments) {
		deltaTokens += estimateTokens(att.content ?? '') + estimateTokens(att.selection ?? '') + 30;
	}

	const usedTokens = baseTokens + deltaTokens;
	const percent = Math.min(100, Math.round((usedTokens / windowTokens) * 100));
	return {
		usedTokens,
		windowTokens,
		percent,
		isRealTokens: lastRealIdx !== -1,
	};
}

/**
 * Compacts older conversation turns into a structured summary while keeping the last
 * `excludeMessages` literal messages (MIGRATION_PLAN.md M3.8c). Preserves user intent,
 * task progress, modified files, decisions/constraints, next steps, and lists dropped
 * steering/skills so the agent knows what to reload. Compresses tool logs and thoughts.
 */
export function compactConversationMessages(
	messages: readonly SessionMessage[],
	options?: CompactionOptions,
): CompactionResult {
	const keepCount = Math.max(1, options?.excludeMessages ?? 4);
	if (messages.length <= keepCount + 1) {
		return { compacted: false, messages: [...messages], removedCount: 0, droppedSteering: [] };
	}

	const toCompact = messages.slice(0, messages.length - keepCount);
	const tail = messages.slice(messages.length - keepCount);

	const firstUser = toCompact.find(m => m.role === 'user');
	const lastUser = [...toCompact].reverse().find(m => m.role === 'user');
	const latestTaskProgress = [...toCompact].reverse().find(m => m.taskProgress)?.taskProgress;

	const modifiedFiles = new Set<string>();
	const decisions: string[] = [];
	const droppedSteering = new Set<string>();
	let compressedToolCalls = 0;

	for (const msg of toCompact) {
		if (msg.fileWriteGate) {
			for (const f of msg.fileWriteGate.files) {
				modifiedFiles.add(f);
			}
		}
		if (msg.attachments) {
			for (const att of msg.attachments) {
				if (att.kind === 'file' && att.label) {
					modifiedFiles.add(att.label);
				}
			}
		}
		if (msg.tools) {
			compressedToolCalls += msg.tools.length;
		}
		if (msg.approvalGate?.approved) {
			decisions.push(`Approved spec gate: ${msg.approvalGate.specSlug} → ${msg.approvalGate.targetPhase}`);
		}
		if (msg.appliedSteering) {
			for (const s of msg.appliedSteering) {
				droppedSteering.add(s);
			}
		}
	}

	const summaryLines: string[] = [
		'## [Compacted Session Summary]',
		`- **Compressed**: ${toCompact.length} earlier message(s) and ${compressedToolCalls} tool call(s).`,
	];

	if (firstUser) {
		summaryLines.push(`- **Original Intent**: ${firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
	}
	if (latestTaskProgress) {
		const remaining = latestTaskProgress.items.filter(i => !i.completed).map(i => i.label).slice(0, 5);
		summaryLines.push(`- **Task Status**: ${latestTaskProgress.title} (${latestTaskProgress.done}/${latestTaskProgress.total} completed)${remaining.length > 0 ? ` · Pending: ${remaining.join('; ')}` : ''}`);
	}
	if (modifiedFiles.size > 0) {
		summaryLines.push(`- **Files Touched / Referenced**: ${[...modifiedFiles].slice(0, 20).join(', ')}`);
	}
	if (decisions.length > 0) {
		summaryLines.push(`- **Decisions & Constraints**: ${decisions.join('; ')}`);
	}
	if (lastUser && lastUser !== firstUser) {
		summaryLines.push(`- **Latest Compacted Direction / Next Steps**: ${lastUser.content.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
	}
	if (droppedSteering.size > 0) {
		summaryLines.push(`- **Dropped Steering / Skills (reload if needed)**: ${[...droppedSteering].join(', ')}`);
	}
	if (options?.postCompactionContext?.trim()) {
		summaryLines.push('', '### PostCompaction Hook Context', options.postCompactionContext.trim());
	}

	const summaryMessage: SessionMessage = {
		id: `compacted-${Date.now()}`,
		role: 'system',
		mode: tail[tail.length - 1]?.mode ?? 'vibe',
		content: summaryLines.join('\n'),
		timestamp: new Date().toISOString(),
	};

	return {
		compacted: true,
		messages: [summaryMessage, ...tail],
		removedCount: toCompact.length,
		droppedSteering: [...droppedSteering],
	};
}

/**
 * Forks conversation history up to `upToMessageId` without carrying file-checkpoint artifacts
 * (forking never modifies workspace files). Pure — unit-testable.
 */
export function forkSessionMessages(messages: readonly SessionMessage[], upToMessageId: string): SessionMessage[] {
	const idx = messages.findIndex(m => m.id === upToMessageId);
	const slice = idx === -1 ? [...messages] : messages.slice(0, idx + 1);
	return slice.map(m => ({
		...m,
		checkpointId: undefined,
		fileWriteGate: undefined,
	}));
}

/** Exports a session to human-readable Markdown (`.md`). Pure — unit-testable. */
export function formatSessionExportMarkdown(session: AgentSession): string {
	const lines: string[] = [
		`# ${session.title}`,
		'',
		`- **Session ID**: \`${session.id}\``,
		`- **Agent**: \`${session.activeAgentId}\``,
		`- **Mode**: \`${session.mode}\` · **Autonomy**: \`${session.autonomy}\``,
		`- **Created**: ${session.createdAt}`,
		'',
		'---',
		'',
	];
	for (const msg of session.messages) {
		const heading = msg.role === 'user'
			? '## User'
			: msg.role === 'assistant'
				? `## Assistant (${msg.agentId ?? session.activeAgentId})`
				: '## System';
		lines.push(heading, '', msg.content, '');
		if (msg.tools && msg.tools.length > 0) {
			lines.push(`> Tools: ${msg.tools.join(', ')}`, '');
		}
	}
	return lines.join('\n');
}

/** Exports a session as `{ sessionJson, messagesJsonl }` for structured archive export. */
export function formatSessionExportBundle(session: AgentSession): { sessionJson: string; messagesJsonl: string } {
	const { messages, ...meta } = session;
	return {
		sessionJson: JSON.stringify({ ...meta, messageCount: messages.length }, null, 2) + '\n',
		messagesJsonl: messages.map(m => JSON.stringify(m)).join('\n') + (messages.length > 0 ? '\n' : ''),
	};
}
