/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrateLegacyHookFile } from '../hooks/hookMigration';
import { parseHookFile } from '../hooks/hookTypes';
import { selectHooksForTrigger } from '../hooks/hookEngine';

describe('hookMigration.migrateLegacyHookFile', () => {
	it('returns undefined for v1 files and anything that is not the legacy shape', () => {
		assert.equal(migrateLegacyHookFile({ version: 'v1', hooks: [] }), undefined);
		assert.equal(migrateLegacyHookFile(null), undefined);
		assert.equal(migrateLegacyHookFile('nope'), undefined);
		assert.equal(migrateLegacyHookFile({ trigger: 'onUnknown' }), undefined);
	});

	it('maps the legacy trigger names and carries the prompt over', () => {
		const result = migrateLegacyHookFile({ trigger: 'onSave', glob: '*.ts', agent: 'claude', prompt: 'Review {{file}}' });
		assert.ok(result);
		assert.equal(result!.hooks[0].trigger, 'PostFileSave');
		assert.equal((result!.hooks[0].action as { prompt?: string }).prompt, 'Review {{file}}');
	});

	it('translates a plain filename glob into a regex that still matches at any depth (the v1 schema\'s own convention)', () => {
		const result = migrateLegacyHookFile({ trigger: 'onSave', glob: '*.ts' });
		const matcher = result!.hooks[0].matcher as string;
		// Must be a syntactically valid regex (the original bug: new RegExp("*.ts") throws).
		assert.doesNotThrow(() => new RegExp(matcher, 'i'));
		assert.match('foo.ts', new RegExp(matcher, 'i'));
		assert.match('src/nested/foo.ts', new RegExp(matcher, 'i'));
		assert.doesNotMatch('foo.tsx', new RegExp(matcher, 'i'));
	});

	it('anchors a directory-scoped glob to the start of the path', () => {
		const result = migrateLegacyHookFile({ trigger: 'onSave', glob: 'src/**/*.tsx' });
		const matcher = result!.hooks[0].matcher as string;
		assert.doesNotThrow(() => new RegExp(matcher, 'i'));
		assert.match('src/components/Button.tsx', new RegExp(matcher, 'i'));
		assert.doesNotMatch('lib/src/components/Button.tsx', new RegExp(matcher, 'i'));
	});

	it('end-to-end: a migrated hook actually fires through the real selectHooksForTrigger pipeline', () => {
		const parsed = parseHookFile({ trigger: 'onSave', glob: '*.ts', agent: 'claude', prompt: 'go' }, 'legacy.json', 'workspace');
		assert.equal(parsed.migrated, true);
		assert.equal(parsed.hooks.length, 1);
		const selected = selectHooksForTrigger(parsed.hooks, 'PostFileSave', 'src/app.ts');
		assert.equal(selected.length, 1, 'the migrated hook must match a real .ts path, not silently never-match');
	});
});
