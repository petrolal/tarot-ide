/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal, hand-rolled parser for the small YAML subset used by `permissions.yaml`: block
 * mappings, block sequences (including sequences of mappings), inline `[a, b]` lists, quoted and
 * bare scalars, comments and blank lines. Not a general YAML parser — anchors, multi-doc
 * streams, flow mappings and multi-line scalars are out of scope. Follows the project's
 * zero-dependency convention (cf. `steering/steeringService.ts::parseSteeringFrontmatter`);
 * there is no `yaml`/`js-yaml` dependency anywhere in `tarot-core`.
 */

interface RawLine {
	readonly indent: number;
	readonly text: string;
	readonly lineNumber: number;
}

export class YamlLiteError extends Error { }

function stripComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '\'' && !inDouble) {
			inSingle = !inSingle;
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
		} else if (ch === '#' && !inSingle && !inDouble) {
			if (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t') {
				return line.slice(0, i);
			}
		}
	}
	return line;
}

function tokenizeLines(text: string): RawLine[] {
	const lines: RawLine[] = [];
	const rawLines = text.replace(/\r\n/g, '\n').split('\n');
	for (let i = 0; i < rawLines.length; i++) {
		const withoutComment = stripComment(rawLines[i]);
		const trimmedEnd = withoutComment.replace(/\s+$/, '');
		if (trimmedEnd.trim().length === 0) {
			continue;
		}
		if (/^\t/.test(trimmedEnd)) {
			throw new YamlLiteError(`Line ${i + 1}: tabs are not supported for indentation.`);
		}
		const indent = trimmedEnd.length - trimmedEnd.replace(/^ */, '').length;
		lines.push({ indent, text: trimmedEnd.slice(indent), lineNumber: i + 1 });
	}
	return lines;
}

function parseScalar(raw: string): unknown {
	const value = raw.trim();
	if (value.length === 0) {
		return null;
	}
	if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
	if (value.startsWith('\'') && value.endsWith('\'') && value.length >= 2) {
		return value.slice(1, -1).replace(/''/g, '\'');
	}
	if (value === 'null' || value === '~') {
		return null;
	}
	if (value === 'true') {
		return true;
	}
	if (value === 'false') {
		return false;
	}
	if (/^-?\d+(\.\d+)?$/.test(value)) {
		return Number(value);
	}
	return value;
}

function parseInlineList(raw: string): unknown[] {
	const inner = raw.trim().slice(1, -1).trim();
	if (inner.length === 0) {
		return [];
	}
	return splitTopLevelCommas(inner).map(item => parseScalar(item.trim()));
}

function splitTopLevelCommas(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	let current = '';
	for (const ch of text) {
		if (ch === '\'' && !inDouble) {
			inSingle = !inSingle;
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
		} else if (!inSingle && !inDouble) {
			if (ch === '[' || ch === '{') {
				depth++;
			} else if (ch === ']' || ch === '}') {
				depth--;
			} else if (ch === ',' && depth === 0) {
				parts.push(current);
				current = '';
				continue;
			}
		}
		current += ch;
	}
	parts.push(current);
	return parts;
}

function splitKeyValue(line: string): { key: string; rest: string } | undefined {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '\'' && !inDouble) {
			inSingle = !inSingle;
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
		} else if (ch === ':' && !inSingle && !inDouble) {
			const after = line[i + 1];
			if (after === undefined || after === ' ') {
				return { key: line.slice(0, i).trim(), rest: line.slice(i + 1).trim() };
			}
		}
	}
	return undefined;
}

/** Cursor over the tokenized lines, shared by mutation across the recursive-descent parser. */
class Cursor {
	i = 0;
	constructor(readonly lines: readonly RawLine[]) { }
	peek(): RawLine | undefined { return this.lines[this.i]; }
}

function parseBlock(cursor: Cursor, indent: number): unknown {
	const first = cursor.peek();
	if (!first || first.indent < indent) {
		return null;
	}
	if (first.text.startsWith('- ') || first.text === '-') {
		return parseSequence(cursor, first.indent);
	}
	return parseMapping(cursor, first.indent);
}

function parseSequence(cursor: Cursor, indent: number): unknown[] {
	const result: unknown[] = [];
	while (true) {
		const line = cursor.peek();
		if (!line || line.indent !== indent || !(line.text.startsWith('- ') || line.text === '-')) {
			break;
		}
		cursor.i++;
		const remainder = line.text === '-' ? '' : line.text.slice(2);
		const itemIndent = indent + 2;
		if (remainder.length === 0) {
			result.push(parseBlock(cursor, itemIndent));
			continue;
		}
		const kv = splitKeyValue(remainder);
		if (kv) {
			// `- key: value` starts an inline mapping item; sibling keys follow at `itemIndent`.
			const entry: Record<string, unknown> = {};
			entry[kv.key] = kv.rest.length > 0
				? parseInlineOrScalar(kv.rest)
				: parseBlock(cursor, itemIndent + 2);
			while (true) {
				const next = cursor.peek();
				if (!next || next.indent !== itemIndent || next.text.startsWith('- ') || next.text === '-') {
					break;
				}
				const nextKv = splitKeyValue(next.text);
				if (!nextKv) {
					break;
				}
				cursor.i++;
				entry[nextKv.key] = nextKv.rest.length > 0
					? parseInlineOrScalar(nextKv.rest)
					: parseBlock(cursor, itemIndent + 2);
			}
			result.push(entry);
		} else {
			result.push(parseScalar(remainder));
		}
	}
	return result;
}

function parseInlineOrScalar(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
		return parseInlineList(trimmed);
	}
	return parseScalar(trimmed);
}

function parseMapping(cursor: Cursor, indent: number): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	while (true) {
		const line = cursor.peek();
		if (!line || line.indent !== indent || line.text.startsWith('- ') || line.text === '-') {
			break;
		}
		const kv = splitKeyValue(line.text);
		if (!kv) {
			throw new YamlLiteError(`Line ${line.lineNumber}: expected "key: value".`);
		}
		cursor.i++;
		result[kv.key] = kv.rest.length > 0 ? parseInlineOrScalar(kv.rest) : parseBlock(cursor, indent + 1);
	}
	return result;
}

/** Parses `text` as the `permissions.yaml` YAML subset. Returns `{}` for empty/whitespace-only input. */
export function parseYamlLite(text: string): unknown {
	const lines = tokenizeLines(text);
	if (lines.length === 0) {
		return {};
	}
	const cursor = new Cursor(lines);
	const value = parseBlock(cursor, lines[0].indent);
	if (cursor.i < lines.length) {
		throw new YamlLiteError(`Line ${lines[cursor.i].lineNumber}: unexpected indentation.`);
	}
	return value;
}
