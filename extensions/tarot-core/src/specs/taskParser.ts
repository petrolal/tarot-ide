/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';

export interface SpecTask {
	readonly lineIndex: number;
	readonly index: number;
	readonly title: string;
	readonly completed: boolean;
	readonly rawLine: string;
}

export interface SpecTaskSummary {
	readonly total: number;
	readonly done: number;
	readonly tasks: readonly SpecTask[];
}

const TASK_LINE_REGEX = /^(\s*-\s+\[)([ xX])(\]\s+)(.+)$/;

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
		tasks.push({
			lineIndex: i,
			index: tasks.length + 1,
			title: match[4].trim(),
			completed,
			rawLine,
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
