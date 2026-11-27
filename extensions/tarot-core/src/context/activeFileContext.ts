/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { AttachedContext } from '../agents/types';

const MAX_AUTO_FILE_CHARS = 12_000;

export interface ActiveFileSnapshot {
	readonly fsPath: string;
	readonly relativePath: string;
	readonly content: string;
	readonly selectionText?: string;
	/** 1-based start line of non-empty selection. */
	readonly selectionStartLine?: number;
	/** 1-based end line of non-empty selection. */
	readonly selectionEndLine?: number;
}

export interface AutoActiveFileChip {
	readonly label: string;
	readonly relativePath: string;
	readonly hasSelection: boolean;
}

/**
 * Excludes Tarot's internal bookkeeping files so they never pollute automatic chat context.
 */
export function isAutoContextEligiblePath(relativePath: string): boolean {
	const norm = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
	if (!norm) {
		return false;
	}
	if (norm.startsWith('.tarot/sessions/') || norm.startsWith('.tarot/checkpoints/')) {
		return false;
	}
	return true;
}

/**
 * Formats the active editor chip label matching Cursor / Kiro / VS Code conventions:
 * e.g. `index.js`, `index.js (L12)`, or `index.js (L12-L28)`.
 */
export function formatActiveFileLabel(
	relativePath: string,
	selectionStartLine?: number,
	selectionEndLine?: number,
): string {
	const norm = relativePath.replace(/\\/g, '/');
	if (selectionStartLine && selectionStartLine > 0) {
		if (selectionEndLine && selectionEndLine > selectionStartLine) {
			return `${norm} (L${selectionStartLine}-L${selectionEndLine})`;
		}
		return `${norm} (L${selectionStartLine})`;
	}
	return norm;
}

/**
 * Checks whether the active file is already covered by a manual `#file` attachment.
 */
export function isFileAlreadyAttached(
	fsPath: string,
	relativePath: string,
	existingAttachments: readonly AttachedContext[],
): boolean {
	const normFs = fsPath.replace(/\\/g, '/');
	const normRel = relativePath.replace(/\\/g, '/');
	return existingAttachments.some(att => {
		if (att.kind !== 'file') {
			return false;
		}
		if (att.path && att.path.replace(/\\/g, '/') === normFs) {
			return true;
		}
		return att.label.replace(/\\/g, '/') === normRel;
	});
}

/**
 * Builds the lightweight UI chip descriptor for the composer's automatic Current File badge.
 */
export function buildAutoActiveFileChip(
	snapshot: ActiveFileSnapshot | undefined,
	existingAttachments: readonly AttachedContext[],
): AutoActiveFileChip | undefined {
	if (!snapshot || !isAutoContextEligiblePath(snapshot.relativePath)) {
		return undefined;
	}
	if (isFileAlreadyAttached(snapshot.fsPath, snapshot.relativePath, existingAttachments)) {
		return undefined;
	}
	const hasSelection = Boolean(snapshot.selectionText && snapshot.selectionText.trim().length > 0);
	return {
		label: formatActiveFileLabel(
			snapshot.relativePath,
			hasSelection ? snapshot.selectionStartLine : undefined,
			hasSelection ? snapshot.selectionEndLine : undefined,
		),
		relativePath: snapshot.relativePath.replace(/\\/g, '/'),
		hasSelection,
	};
}

/**
 * Builds the `AttachedContext` automatically injected into the agent prompt when the
 * user has not dismissed the Current File chip for this turn.
 */
export function buildAutoActiveFileAttachment(
	snapshot: ActiveFileSnapshot | undefined,
	existingAttachments: readonly AttachedContext[],
): AttachedContext | undefined {
	const chip = buildAutoActiveFileChip(snapshot, existingAttachments);
	if (!chip || !snapshot) {
		return undefined;
	}
	if (chip.hasSelection && snapshot.selectionText) {
		return {
			kind: 'file',
			label: chip.label,
			path: snapshot.fsPath,
			selection: snapshot.selectionText.slice(0, MAX_AUTO_FILE_CHARS),
		};
	}
	return {
		kind: 'file',
		label: chip.label,
		path: snapshot.fsPath,
		content: snapshot.content.slice(0, MAX_AUTO_FILE_CHARS),
	};
}
