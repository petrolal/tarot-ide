/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure line-level diff hunk engine for Cursor-style per-hunk Accept / Reject review.
 * Zero external dependencies and zero VS Code API imports so it can be unit-tested directly.
 */

export interface DiffHunk {
	readonly id: number;
	/** 0-based start line index in the "before" document. */
	readonly oldStart: number;
	/** Number of lines in the "before" document covered by this hunk. */
	readonly oldCount: number;
	/** 0-based start line index in the "after" (working) document. */
	readonly newStart: number;
	/** Number of lines in the "after" (working) document covered by this hunk. */
	readonly newCount: number;
	readonly oldLines: readonly string[];
	readonly newLines: readonly string[];
}

interface SplitText {
	readonly lines: string[];
	readonly eol: '\r\n' | '\n';
	readonly hadTrailingNewline: boolean;
}

function splitLines(text: string): SplitText {
	const eol: '\r\n' | '\n' = text.includes('\r\n') ? '\r\n' : '\n';
	if (text.length === 0) {
		return { lines: [], eol, hadTrailingNewline: false };
	}
	const normalized = text.replace(/\r\n/g, '\n');
	const hadTrailingNewline = normalized.endsWith('\n');
	const raw = normalized.split('\n');
	if (hadTrailingNewline) {
		raw.pop();
	}
	return { lines: raw, eol, hadTrailingNewline };
}

function joinLines(lines: readonly string[], eol: '\r\n' | '\n', trailingNewline: boolean): string {
	if (lines.length === 0) {
		return '';
	}
	return lines.join(eol) + (trailingNewline ? eol : '');
}

const MAX_LCS_CELLS = 1_500_000;

/**
 * Computes contiguous changed hunks between `beforeText` and `afterText`.
 * Trims common prefix/suffix first so edits inside large files stay fast.
 */
export function computeDiffHunks(beforeText: string, afterText: string): DiffHunk[] {
	if (beforeText === afterText) {
		return [];
	}
	const before = splitLines(beforeText).lines;
	const after = splitLines(afterText).lines;

	// Trim common prefix
	let prefix = 0;
	const minLen = Math.min(before.length, after.length);
	while (prefix < minLen && before[prefix] === after[prefix]) {
		prefix++;
	}

	// Trim common suffix
	let suffix = 0;
	while (
		suffix < before.length - prefix &&
		suffix < after.length - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix++;
	}

	const midA = before.slice(prefix, before.length - suffix);
	const midB = after.slice(prefix, after.length - suffix);

	if (midA.length === 0 && midB.length === 0) {
		return [];
	}

	// Fast path for pure insertion, pure deletion, or huge diffs
	if (midA.length === 0 || midB.length === 0 || midA.length * midB.length > MAX_LCS_CELLS) {
		return [{
			id: 0,
			oldStart: prefix,
			oldCount: midA.length,
			newStart: prefix,
			newCount: midB.length,
			oldLines: midA,
			newLines: midB,
		}];
	}

	// LCS DP table on middle slice
	const m = midA.length;
	const n = midB.length;
	const dp = new Int32Array((m + 1) * (n + 1));
	const stride = n + 1;
	for (let i = m - 1; i >= 0; i--) {
		const rowOffset = i * stride;
		const nextRowOffset = (i + 1) * stride;
		for (let j = n - 1; j >= 0; j--) {
			if (midA[i] === midB[j]) {
				dp[rowOffset + j] = dp[nextRowOffset + j + 1] + 1;
			} else {
				const down = dp[nextRowOffset + j];
				const right = dp[rowOffset + j + 1];
				dp[rowOffset + j] = down >= right ? down : right;
			}
		}
	}

	// Backtrack into contiguous change hunks
	const hunks: DiffHunk[] = [];
	let i = 0;
	let j = 0;
	while (i < m || j < n) {
		if (i < m && j < n && midA[i] === midB[j]) {
			i++;
			j++;
			continue;
		}
		const hunkOldStart = prefix + i;
		const hunkNewStart = prefix + j;
		const oldLines: string[] = [];
		const newLines: string[] = [];

		while (i < m || j < n) {
			if (i < m && j < n && midA[i] === midB[j]) {
				break;
			}
			if (i < m && (j >= n || dp[(i + 1) * stride + j] >= dp[i * stride + j + 1])) {
				oldLines.push(midA[i]);
				i++;
			} else if (j < n) {
				newLines.push(midB[j]);
				j++;
			}
		}

		hunks.push({
			id: hunks.length,
			oldStart: hunkOldStart,
			oldCount: oldLines.length,
			newStart: hunkNewStart,
			newCount: newLines.length,
			oldLines,
			newLines,
		});
	}

	return hunks;
}

/**
 * Reverts a single hunk in `afterText` back to its `oldLines` from `beforeText`.
 */
export function applyRejectHunk(afterText: string, hunk: DiffHunk): string {
	const split = splitLines(afterText);
	const next = [
		...split.lines.slice(0, hunk.newStart),
		...hunk.oldLines,
		...split.lines.slice(hunk.newStart + hunk.newCount),
	];
	return joinLines(next, split.eol, split.hadTrailingNewline || next.length > 0);
}

/**
 * Accepts a single hunk by advancing `beforeText` to include `hunk.newLines`,
 * so that hunk disappears from the pending diff while remaining hunks stay visible.
 */
export function applyAcceptHunk(beforeText: string, hunk: DiffHunk): string {
	const split = splitLines(beforeText);
	const next = [
		...split.lines.slice(0, hunk.oldStart),
		...hunk.newLines,
		...split.lines.slice(hunk.oldStart + hunk.oldCount),
	];
	return joinLines(next, split.eol, split.hadTrailingNewline || next.length > 0);
}

export function countDiffStats(hunks: readonly DiffHunk[]): { readonly added: number; readonly removed: number } {
	let added = 0;
	let removed = 0;
	for (const h of hunks) {
		added += h.newCount;
		removed += h.oldCount;
	}
	return { added, removed };
}

export interface InlineDiffPreviewLine {
	readonly kind: 'context' | 'add' | 'del';
	readonly text: string;
}

export interface InlineDiffPreviewHunk {
	readonly header: string;
	readonly lines: readonly InlineDiffPreviewLine[];
}

/**
 * Builds compact, Cursor-style colored diff preview hunks (with up to `contextLines`
 * of surrounding context and a hard line budget) for rendering inside chat messages.
 */
export function buildInlineDiffPreviewHunks(
	beforeText: string,
	afterText: string,
	contextLines = 2,
	maxTotalLines = 36,
): InlineDiffPreviewHunk[] {
	const hunks = computeDiffHunks(beforeText, afterText);
	if (hunks.length === 0) {
		return [];
	}
	const afterLines = splitLines(afterText).lines;
	const result: InlineDiffPreviewHunk[] = [];
	let budget = maxTotalLines;

	for (const hunk of hunks) {
		if (budget <= 0) {
			break;
		}
		const lines: InlineDiffPreviewLine[] = [];
		const preStart = Math.max(0, hunk.newStart - contextLines);
		for (let i = preStart; i < hunk.newStart && budget > 0; i++) {
			lines.push({ kind: 'context', text: afterLines[i] ?? '' });
			budget--;
		}
		for (const delLine of hunk.oldLines) {
			if (budget <= 0) {
				break;
			}
			lines.push({ kind: 'del', text: delLine });
			budget--;
		}
		for (const addLine of hunk.newLines) {
			if (budget <= 0) {
				break;
			}
			lines.push({ kind: 'add', text: addLine });
			budget--;
		}
		const postStart = hunk.newStart + hunk.newCount;
		const postEnd = Math.min(afterLines.length, postStart + contextLines);
		for (let i = postStart; i < postEnd && budget > 0; i++) {
			lines.push({ kind: 'context', text: afterLines[i] ?? '' });
			budget--;
		}
		const header = `@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`;
		result.push({ header, lines });
	}
	return result;
}

/**
 * Pure parser for a single `git status --porcelain -uall` line.
 * Distinguishes tracked modifications/deletions from untracked/added files so
 * pre-turn Git HEAD diffs show the real Before content instead of an empty file.
 */
export function parsePorcelainStatusLine(line: string): { readonly relativePath: string; readonly status: 'added' | 'modified' | 'deleted' } | undefined {
	if (line.length < 4) {
		return undefined;
	}
	const code = line.slice(0, 2);
	let raw = line.slice(3).trim();
	if (!raw) {
		return undefined;
	}
	if (raw.includes(' -> ')) {
		raw = raw.split(' -> ').pop()!.trim();
	}
	if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
		raw = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
	// Skip directory markers if any slip through
	if (raw.endsWith('/')) {
		return undefined;
	}
	let status: 'added' | 'modified' | 'deleted' = 'modified';
	if (code === '??' || code === 'A ' || code === 'AM' || code === 'AA') {
		status = 'added';
	} else if (code.includes('D')) {
		status = 'deleted';
	}
	return { relativePath: raw.replace(/\\/g, '/'), status };
}
