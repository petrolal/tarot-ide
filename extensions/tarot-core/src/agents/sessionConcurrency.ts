/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { AgentMode, AgentSession } from './types';

export type SessionCardStatus = 'running' | 'needsInput' | 'parked' | 'idle';
export type SessionFilterKind = 'all' | 'active' | 'needsInput' | 'parked' | 'spec';

export interface SessionCardSummary {
	readonly id: string;
	readonly title: string;
	readonly summary: string;
	readonly repoName: string;
	readonly repoRoot?: string;
	readonly worktreeBranch?: string;
	readonly mode: AgentMode;
	readonly activeAgentId: string;
	readonly updatedAt: string;
	readonly status: SessionCardStatus;
	readonly parkedApprovals: number;
	readonly isPersistedOnly?: boolean;
}

export interface ActiveSessionRunDescriptor {
	readonly sessionId: string;
	readonly mode: AgentMode;
	readonly profileId?: string;
	readonly cwd: string;
	readonly isWorktree: boolean;
}

export interface ConcurrencyCheckResult {
	readonly allowed: boolean;
	readonly blockReason?: string;
	readonly sharedWorkspaceWarning?: string;
}

/**
 * Classifies a session's status badge for the Sessions sidebar and Agent Focus Mode (M3.9c).
 * Priority: `parked` (pending approvals) > `needsInput` (pending spec/file-write gate) > `running` > `idle`.
 * Pure — zero `vscode` import so it is unit-testable via `node --test`.
 */
export function classifySessionStatus(
	session: Pick<AgentSession, 'messages'>,
	isRunning: boolean,
	parkedApprovals = 0,
): SessionCardStatus {
	if (parkedApprovals > 0) {
		return 'parked';
	}
	const hasPendingGate = session.messages.some(m =>
		(m.approvalGate && !m.approvalGate.approved)
		|| (m.fileWriteGate && !m.fileWriteGate.resolution),
	);
	if (hasPendingGate) {
		return 'needsInput';
	}
	return isRunning ? 'running' : 'idle';
}

/** Filters session cards by free-text query and status/mode filter pill (M3.9c). Pure. */
export function filterSessionCards(
	cards: readonly SessionCardSummary[],
	query: string,
	filter: SessionFilterKind = 'all',
): SessionCardSummary[] {
	const q = query.trim().toLowerCase();
	return cards.filter(card => {
		if (filter === 'active' && card.status !== 'running') {
			return false;
		}
		if (filter === 'needsInput' && card.status !== 'needsInput') {
			return false;
		}
		if (filter === 'parked' && card.status !== 'parked') {
			return false;
		}
		if (filter === 'spec' && card.mode !== 'spec') {
			return false;
		}
		if (!q) {
			return true;
		}
		return (
			card.title.toLowerCase().includes(q)
			|| card.summary.toLowerCase().includes(q)
			|| card.repoName.toLowerCase().includes(q)
			|| card.activeAgentId.toLowerCase().includes(q)
			|| card.status.toLowerCase().includes(q)
			|| (card.worktreeBranch ?? '').toLowerCase().includes(q)
		);
	});
}

function isExclusiveSpecProfile(mode: AgentMode, profileId?: string): boolean {
	if (mode === 'spec') {
		return true;
	}
	return profileId === 'spec' || profileId === 'quick-spec' || profileId === 'bug-fix';
}

/**
 * Enforces M3.9c safe concurrency rules:
 * - Spec / Quick Spec / Bug Fix sessions serialize per workspace ("The agent is currently busy").
 * - Plan and custom agents can run in parallel without blocking.
 * - Two concurrent write-capable sessions targeting the same directory without isolated worktrees
 *   emit a `sharedWorkspaceWarning` so the UI can offer a managed Git worktree.
 */
export function checkSessionConcurrency(
	activeRuns: readonly ActiveSessionRunDescriptor[],
	candidate: ActiveSessionRunDescriptor,
): ConcurrencyCheckResult {
	const others = activeRuns.filter(r => r.sessionId !== candidate.sessionId);
	if (others.length === 0) {
		return { allowed: true };
	}

	const candidateIsSpec = isExclusiveSpecProfile(candidate.mode, candidate.profileId);
	if (candidateIsSpec) {
		const conflictingSpec = others.find(r => isExclusiveSpecProfile(r.mode, r.profileId) && r.cwd === candidate.cwd);
		if (conflictingSpec) {
			return {
				allowed: false,
				blockReason: 'The agent is currently busy with another Spec session in this workspace.',
			};
		}
	}

	const candidateIsReadOnly = candidate.mode === 'plan';
	if (!candidateIsReadOnly && !candidate.isWorktree) {
		const sameDirWriter = others.find(r => r.mode !== 'plan' && !r.isWorktree && r.cwd === candidate.cwd);
		if (sameDirWriter) {
			return {
				allowed: true,
				sharedWorkspaceWarning: 'Another active session is running in the same workspace directory. Consider isolating this session in a Git worktree.',
			};
		}
	}

	return { allowed: true };
}
