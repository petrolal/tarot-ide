/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';

export interface SpecTaskProperty {
	readonly number: string;
	readonly description: string;
}

export interface SpecTask {
	readonly lineIndex: number;
	readonly index: number;
	readonly title: string;
	readonly completed: boolean;
	readonly rawLine: string;
	/** Leading numbering extracted from the title (e.g. "2.1"), used as the dependency graph key. */
	readonly numberLabel?: string;
	/** `true` when the title carries the Kiro `*` optional marker right after the numbering. */
	readonly optional: boolean;
	/** `_Requirements: 1.1, 1.2_` references found in the detail lines below the task. */
	readonly requirementRefs: readonly string[];
	/** `_Depends: 1, 2.1_` explicit dependency annotation; drives `taskGraph` wave computation. */
	readonly dependsOn: readonly string[];
	/** `**Property N: ...**` metadata for Property-Based Testing tasks. */
	readonly property?: SpecTaskProperty;
	/** `**Validates: Requirements x.y**` metadata for PBT tasks. */
	readonly validates: readonly string[];
}

export interface SpecTaskSummary {
	readonly total: number;
	readonly done: number;
	readonly tasks: readonly SpecTask[];
}

const TASK_LINE_REGEX = /^(\s*-\s+\[)([ xX])(\]\s+)(.+)$/;
const OPTIONAL_MARKER_REGEX = /^[\d.]+\.?\s*\*/;
const NUMBER_LABEL_REGEX = /^(\d+(?:\.\d+)*)/;
const REQUIREMENTS_REGEX = /_Requirements:\s*([^_]+)_/i;
const DEPENDS_REGEX = /_Depends:\s*([^_]+)_/i;
const PROPERTY_REGEX = /\*\*Property\s+(\d+):\s*([^*]+)\*\*/i;
const VALIDATES_REGEX = /\*\*Validates:\s*Requirements\s*([^*]+)\*\*/i;

function splitRefs(raw: string): string[] {
	return raw.split(',').map(r => r.trim()).filter(Boolean);
}

export function parseTasksMarkdown(content: string): SpecTaskSummary {
	const lines = content.split(/\r?\n/);
	const tasks: SpecTask[] = [];
	let done = 0;

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const match = rawLine.match(TASK_LINE_REGEX);
		if (!match) {
			continue;
		}
		const completed = match[2].toLowerCase() === 'x';
		if (completed) {
			done++;
		}
		const title = match[4].trim();
		const numberLabel = title.match(NUMBER_LABEL_REGEX)?.[1];

		// Detail lines: everything below this checkbox until the next one, used for
		// `_Requirements:_`, `_Depends:_`, `**Property N:**` and `**Validates:**` metadata.
		let requirementRefs: string[] = [];
		let dependsOn: string[] = [];
		let property: SpecTaskProperty | undefined;
		let validates: string[] = [];
		for (let j = i + 1; j < lines.length && !TASK_LINE_REGEX.test(lines[j]); j++) {
			const detail = lines[j];
			const reqMatch = detail.match(REQUIREMENTS_REGEX);
			if (reqMatch) {
				requirementRefs = requirementRefs.concat(splitRefs(reqMatch[1]));
			}
			const depMatch = detail.match(DEPENDS_REGEX);
			if (depMatch) {
				dependsOn = dependsOn.concat(splitRefs(depMatch[1]));
			}
			const propMatch = detail.match(PROPERTY_REGEX);
			if (propMatch && !property) {
				property = { number: propMatch[1].trim(), description: propMatch[2].trim() };
			}
			const validatesMatch = detail.match(VALIDATES_REGEX);
			if (validatesMatch) {
				validates = validates.concat(splitRefs(validatesMatch[1]));
			}
		}

		tasks.push({
			lineIndex: i,
			index: tasks.length + 1,
			title,
			completed,
			rawLine,
			numberLabel,
			optional: OPTIONAL_MARKER_REGEX.test(title),
			requirementRefs,
			dependsOn,
			property,
			validates,
		});
	}

	return {
		total: tasks.length,
		done,
		tasks,
	};
}

export async function markTaskCompletedInFile(filePath: string, lineIndex: number): Promise<SpecTaskSummary> {
	const raw = await fs.readFile(filePath, 'utf8');
	const eol = raw.includes('\r\n') ? '\r\n' : '\n';
	const lines = raw.split(/\r?\n/);

	if (lineIndex >= 0 && lineIndex < lines.length) {
		const match = lines[lineIndex].match(TASK_LINE_REGEX);
		if (match && match[2] === ' ') {
			lines[lineIndex] = `${match[1]}x${match[3]}${match[4]}`;
			await fs.writeFile(filePath, lines.join(eol), 'utf8');
		}
	}

	return parseTasksMarkdown(lines.join(eol));
}

export interface CompletedTaskLineRange {
	readonly startLine: number;
	readonly endLine: number;
}

/**
 * Finds all completed task blocks (`- [x] ...` plus their indented sub-lines such as
 * `_Requirements:_`, `**Property N:**`, `**Validates:**`) in a Spec `tasks.md` file. Pure.
 */
export function computeCompletedTaskLineRanges(text: string): CompletedTaskLineRange[] {
	const lines = text.split(/\r?\n/);
	const ranges: CompletedTaskLineRange[] = [];

	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(\s*)[-*]\s+\[[xX]\]\s+/);
		if (!m) {
			continue;
		}
		const baseIndent = m[1].length;
		let endLine = i;
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j];
			if (!next.trim() || /^\s*#/.test(next)) {
				break;
			}
			const nextItem = next.match(/^(\s*)[-*]\s+\[[ xX]\]\s+/);
			if (nextItem && nextItem[1].length <= baseIndent) {
				break;
			}
			const leadingSpaces = next.match(/^(\s*)/)?.[1].length ?? 0;
			if (leadingSpaces > baseIndent) {
				endLine = j;
			} else {
				break;
			}
		}
		ranges.push({ startLine: i, endLine });
		i = endLine;
	}
	return ranges;
}
