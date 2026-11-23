/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal, hand-rolled parser for the YAML subset used by `permissions.yaml`: block mappings,
 * block sequences (including sequences of mappings), inline `[a, b]` lists, literal/folded
 * multi-line block scalars (`|` / `>` with `-`/`+` chomping), quoted and bare scalars, comments
 * and blank lines. Unsupported YAML features (anchors `&`, aliases `*`, merge keys `<<`, inline
 * flow mappings `{ ... }`, multi-document `---`/`...` streams) fail fast with an actionable
 * `YamlLiteError` instead of silently misparsing. Follows the project's zero-dependency
 * convention (cf. `steering/steeringService.ts::parseSteeringFrontmatter`).
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

function tokenizeLines(rawLines: readonly string[]): RawLine[] {
	const lines: RawLine[] = [];
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
		const text = trimmedEnd.slice(indent);
		if (indent === 0 && (text === '---' || text === '...')) {
			throw new YamlLiteError(`Line ${i + 1}: multi-document YAML markers ("${text}") are not supported.`);
		}
		lines.push({ indent, text, lineNumber: i + 1 });
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
	constructor(
		readonly lines: readonly RawLine[],
		readonly rawLines: readonly string[],
	) { }
	peek(): RawLine | undefined { return this.lines[this.i]; }
}

const BLOCK_SCALAR_HEADER_RE = /^([|>])([+-])?$/;
const ANCHOR_RE = /^&[a-zA-Z_][a-zA-Z0-9_-]*(?:\s|$)/;
const ALIAS_RE = /^\*[a-zA-Z_][a-zA-Z0-9_-]*$/;

function assertSupportedValueSyntax(trimmed: string, lineNumber: number): void {
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		throw new YamlLiteError(`Line ${lineNumber}: inline flow mappings ("{ ... }") are not supported; use block mapping syntax.`);
	}
	if (ANCHOR_RE.test(trimmed) || ALIAS_RE.test(trimmed)) {
		throw new YamlLiteError(`Line ${lineNumber}: YAML anchors ("&") and aliases ("*") are not supported.`);
	}
}

function parseBlockScalar(cursor: Cursor, parentIndent: number, header: string, headerLineNumber: number): string {
	const match = BLOCK_SCALAR_HEADER_RE.exec(header)!;
	const style = match[1] as '|' | '>';
	const chomp = (match[2] ?? '') as '' | '-' | '+';

	const collected: string[] = [];
	let blockIndent: number | undefined;
	let lastConsumedLine = headerLineNumber;

	for (let idx = headerLineNumber; idx < cursor.rawLines.length; idx++) {
		const raw = cursor.rawLines[idx];
		if (/^\t/.test(raw)) {
			throw new YamlLiteError(`Line ${idx + 1}: tabs are not supported for indentation.`);
		}
		const isBlank = raw.trim().length === 0;
		if (isBlank) {
			if (blockIndent !== undefined) {
				collected.push('');
				lastConsumedLine = idx + 1;
			}
			continue;
		}
		const lineIndent = raw.length - raw.replace(/^ */, '').length;
		if (blockIndent === undefined) {
			if (lineIndent <= parentIndent) {
				break;
			}
			blockIndent = lineIndent;
		} else if (lineIndent < blockIndent) {
			break;
		}
		collected.push(raw.slice(blockIndent));
		lastConsumedLine = idx + 1;
	}

	while (cursor.i < cursor.lines.length && cursor.lines[cursor.i].lineNumber <= lastConsumedLine) {
		cursor.i++;
	}

	if (collected.length === 0) {
		return '';
	}

	let trailingBlanks = 0;
	while (trailingBlanks < collected.length && collected[collected.length - 1 - trailingBlanks] === '') {
		trailingBlanks++;
	}
	const bodyLines = collected.slice(0, collected.length - trailingBlanks);

	let content: string;
	if (style === '|') {
		content = bodyLines.join('\n');
	} else {
		// Folded (`>`): single newlines between non-empty lines fold to spaces; blank lines separate paragraphs.
		const parts: string[] = [];
		for (let i = 0; i < bodyLines.length; i++) {
			const line = bodyLines[i];
			if (line === '') {
				parts.push('\n');
			} else {
				if (parts.length > 0 && parts[parts.length - 1] !== '\n') {
					parts.push(' ');
				}
				parts.push(line);
			}
		}
		content = parts.join('');
	}

	if (chomp === '-') {
		return content;
	}
	if (chomp === '+') {
		return content + '\n'.repeat(1 + trailingBlanks);
	}
	return content.length > 0 ? `${content}\n` : '';
}

function parseValue(cursor: Cursor, rest: string, parentIndent: number, lineNumber: number, nestedIndent: number): unknown {
	const trimmed = rest.trim();
	if (trimmed.length === 0) {
		return parseBlock(cursor, nestedIndent);
	}
	if (BLOCK_SCALAR_HEADER_RE.test(trimmed)) {
		return parseBlockScalar(cursor, parentIndent, trimmed, lineNumber);
	}
	assertSupportedValueSyntax(trimmed, lineNumber);
	return parseInlineOrScalar(trimmed);
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
			if (kv.key === '<<') {
				throw new YamlLiteError(`Line ${line.lineNumber}: YAML merge keys ("<<") are not supported.`);
			}
			// `- key: value` starts an inline mapping item; sibling keys follow at `itemIndent`.
			const entry: Record<string, unknown> = {};
			entry[kv.key] = parseValue(cursor, kv.rest, itemIndent, line.lineNumber, itemIndent + 2);
			while (true) {
				const next = cursor.peek();
				if (!next || next.indent !== itemIndent || next.text.startsWith('- ') || next.text === '-') {
					break;
				}
				const nextKv = splitKeyValue(next.text);
				if (!nextKv) {
					break;
				}
				if (nextKv.key === '<<') {
					throw new YamlLiteError(`Line ${next.lineNumber}: YAML merge keys ("<<") are not supported.`);
				}
				cursor.i++;
				entry[nextKv.key] = parseValue(cursor, nextKv.rest, itemIndent, next.lineNumber, itemIndent + 2);
			}
			result.push(entry);
		} else {
			assertSupportedValueSyntax(remainder.trim(), line.lineNumber);
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
		if (kv.key === '<<') {
			throw new YamlLiteError(`Line ${line.lineNumber}: YAML merge keys ("<<") are not supported.`);
		}
		cursor.i++;
		result[kv.key] = parseValue(cursor, kv.rest, indent, line.lineNumber, indent + 1);
	}
	return result;
}

/** Parses `text` as the `permissions.yaml` YAML subset. Returns `{}` for empty/whitespace-only input. */
export function parseYamlLite(text: string): unknown {
	const rawLines = text.replace(/\r\n/g, '\n').split('\n');
	const lines = tokenizeLines(rawLines);
	if (lines.length === 0) {
		return {};
	}
	const cursor = new Cursor(lines, rawLines);
	const value = parseBlock(cursor, lines[0].indent);
	if (cursor.i < lines.length) {
		throw new YamlLiteError(`Line ${lines[cursor.i].lineNumber}: unexpected indentation.`);
	}
	return value;
}
