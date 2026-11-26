/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

export type ReviewFileStatus = 'added' | 'modified' | 'deleted';

export interface PendingReviewFile {
	readonly relativePath: string;
	readonly status: ReviewFileStatus;
	readonly backupAbsPath?: string;
}

export interface ReviewSessionState {
	readonly cwd: string;
	readonly sessionId: string;
	readonly checkpointId: string;
	readonly pending: readonly PendingReviewFile[];
	readonly activeIndex: number;
}

export function createReviewSessionState(
	cwd: string,
	sessionId: string,
	checkpointId: string,
	files: readonly PendingReviewFile[],
): ReviewSessionState | undefined {
	if (files.length === 0) {
		return undefined;
	}
	const deduped: PendingReviewFile[] = [];
	const seen = new Set<string>();
	for (const f of files) {
		const norm = f.relativePath.replace(/\\/g, '/');
		if (seen.has(norm)) {
			continue;
		}
		seen.add(norm);
		deduped.push({ ...f, relativePath: norm });
	}
	if (deduped.length === 0) {
		return undefined;
	}
	return {
		cwd,
		sessionId,
		checkpointId,
		pending: deduped,
		activeIndex: 0,
	};
}

export function getActiveReviewFile(state: ReviewSessionState | undefined): PendingReviewFile | undefined {
	if (!state || state.pending.length === 0) {
		return undefined;
	}
	const idx = Math.max(0, Math.min(state.activeIndex, state.pending.length - 1));
	return state.pending[idx];
}

export function removeReviewFile(
	state: ReviewSessionState | undefined,
	relativePath: string,
): ReviewSessionState | undefined {
	if (!state) {
		return undefined;
	}
	const norm = relativePath.replace(/\\/g, '/');
	const removedIdx = state.pending.findIndex(f => f.relativePath === norm);
	if (removedIdx === -1) {
		return state;
	}
	const nextPending = state.pending.filter(f => f.relativePath !== norm);
	if (nextPending.length === 0) {
		return undefined;
	}
	const nextIndex = removedIdx < state.activeIndex
		? state.activeIndex - 1
		: Math.min(state.activeIndex, nextPending.length - 1);
	return {
		...state,
		pending: nextPending,
		activeIndex: Math.max(0, nextIndex),
	};
}

export function advanceReviewFile(state: ReviewSessionState | undefined): ReviewSessionState | undefined {
	if (!state || state.pending.length <= 1) {
		return state;
	}
	return {
		...state,
		activeIndex: (state.activeIndex + 1) % state.pending.length,
	};
}

export function selectReviewFile(
	state: ReviewSessionState | undefined,
	relativePath: string,
): ReviewSessionState | undefined {
	if (!state) {
		return undefined;
	}
	const norm = relativePath.replace(/\\/g, '/');
	const idx = state.pending.findIndex(f => f.relativePath === norm);
	if (idx === -1) {
		return state;
	}
	return { ...state, activeIndex: idx };
}
