/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseYamlLite, YamlLiteError } from '../permissions/yamlLite';

describe('yamlLite', () => {
	it('parses an empty document as {}', () => {
		assert.deepEqual(parseYamlLite(''), {});
		assert.deepEqual(parseYamlLite('   \n  # just a comment\n'), {});
	});

	it('parses scalars: numbers, booleans, null and quoted strings', () => {
		const doc = parseYamlLite([
			'version: 1',
			'enabled: true',
			'disabled: false',
			'nothing: null',
			'label: "hello \\"world\\""',
			'single: \'it\'\'s fine\'',
		].join('\n')) as Record<string, unknown>;
		assert.equal(doc.version, 1);
		assert.equal(doc.enabled, true);
		assert.equal(doc.disabled, false);
		assert.equal(doc.nothing, null);
		assert.equal(doc.label, 'hello "world"');
		assert.equal(doc.single, 'it\'s fine');
	});

	it('parses a block sequence of mappings with nested lists', () => {
		const text = [
			'version: 1',
			'rules:',
			'  - capability: fs_write',
			'    effect: ask',
			'    match:',
			'      - "src/**"',
			'    exclude:',
			'      - "src/**/*.test.ts"',
			'    reason: "Ask before editing source"',
			'  - capability: shell',
			'    effect: deny',
			'    match: ["rm *", "sudo *"]',
		].join('\n');
		const doc = parseYamlLite(text) as { version: number; rules: Array<Record<string, unknown>> };
		assert.equal(doc.version, 1);
		assert.equal(doc.rules.length, 2);
		assert.equal(doc.rules[0].capability, 'fs_write');
		assert.equal(doc.rules[0].effect, 'ask');
		assert.deepEqual(doc.rules[0].match, ['src/**']);
		assert.deepEqual(doc.rules[0].exclude, ['src/**/*.test.ts']);
		assert.equal(doc.rules[0].reason, 'Ask before editing source');
		assert.deepEqual(doc.rules[1].match, ['rm *', 'sudo *']);
	});

	it('strips end-of-line comments but keeps "#" inside quoted strings', () => {
		const doc = parseYamlLite([
			'rules:',
			'  - capability: shell',
			'    effect: deny # block everything dangerous',
			'    reason: "do not allow #rm"',
		].join('\n')) as { rules: Array<Record<string, unknown>> };
		assert.equal(doc.rules[0].effect, 'deny');
		assert.equal(doc.rules[0].reason, 'do not allow #rm');
	});

	it('rejects tab indentation', () => {
		assert.throws(() => parseYamlLite('version: 1\n\trules: []'), YamlLiteError);
	});

	it('parses literal (|, |-) and folded (>, >-) multi-line block scalars', () => {
		const doc = parseYamlLite([
			'version: 1',
			'rules:',
			'  - capability: fs_write',
			'    effect: ask',
			'    reason: |-',
			'      Line one',
			'      Line two # not a comment',
			'  - capability: shell',
			'    effect: deny',
			'    reason: >-',
			'      Folded line one',
			'      folded line two',
		].join('\n')) as { rules: Array<Record<string, unknown>> };
		assert.equal(doc.rules[0].reason, 'Line one\nLine two # not a comment');
		assert.equal(doc.rules[1].reason, 'Folded line one folded line two');
	});

	it('rejects unsupported YAML features (anchors, aliases, merge keys, flow mappings, multi-doc) clearly', () => {
		assert.throws(() => parseYamlLite('base: &defaults\n  effect: deny'), /anchors/i);
		assert.throws(() => parseYamlLite('rules:\n  - *defaults'), /aliases/i);
		assert.throws(() => parseYamlLite('rules:\n  - <<: *defaults\n    effect: deny'), /merge keys/i);
		assert.throws(() => parseYamlLite('rule: { capability: shell, effect: deny }'), /flow mappings/i);
		assert.throws(() => parseYamlLite('---\nversion: 1'), /multi-document/i);
	});
});
