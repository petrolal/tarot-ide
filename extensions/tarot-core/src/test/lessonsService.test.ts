/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { auditSteeringDocuments, promoteLessonToSkill, saveLessonToSteering } from '../steering/lessonsService';
import { SteeringDocument } from '../steering/steeringService';

describe('steering.lessonsService (M3.10)', () => {
	it('saves a user correction as an editable steering lesson and can promote it to a skill', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-lessons-test-'));
		try {
			const steeringDir = path.join(tmp, '.tarot', 'steering');
			const saved = await saveLessonToSteering(steeringDir, 'Always use pnpm instead of npm in this repo.');
			const content = await fs.readFile(saved.filePath, 'utf8');
			assert.match(content, /inclusion: always/);
			assert.match(content, /category: lesson/);
			assert.match(content, /Always use pnpm instead of npm/);

			const skillsDir = path.join(tmp, '.tarot', 'skills');
			const promoted = await promoteLessonToSkill(skillsDir, 'pnpm-workflow', 'Enforce pnpm usage', content);
			const skillMd = await fs.readFile(promoted.skillFilePath, 'utf8');
			assert.match(skillMd, /name: pnpm-workflow/);
			assert.match(skillMd, /Always use pnpm instead of npm/);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it('audits steering docs for redundant rules, obsolete model workarounds, empty docs and invalid frontmatter', () => {
		const docs: SteeringDocument[] = [
			{
				id: 'rule-a',
				fileName: 'rule-a.md',
				filePath: '/ws/.tarot/steering/rule-a.md',
				scope: 'workspace',
				inclusion: 'always',
				raw: 'Always use pnpm instead of npm when installing dependencies and running compile scripts.',
				body: 'Always use pnpm instead of npm when installing dependencies and running compile scripts.',
			},
			{
				id: 'rule-b',
				fileName: 'rule-b.md',
				filePath: '/ws/.tarot/steering/rule-b.md',
				scope: 'workspace',
				inclusion: 'always',
				raw: 'Always use pnpm instead of npm when installing dependencies and running compile scripts in this repo.',
				body: 'Always use pnpm instead of npm when installing dependencies and running compile scripts in this repo.',
			},
			{
				id: 'legacy',
				fileName: 'legacy.md',
				filePath: '/ws/.tarot/steering/legacy.md',
				scope: 'workspace',
				inclusion: 'always',
				raw: 'Temporary workaround for claude-2 JSON formatting bug.',
				body: 'Temporary workaround for claude-2 JSON formatting bug.',
			},
			{
				id: 'empty',
				fileName: 'empty.md',
				filePath: '/ws/.tarot/steering/empty.md',
				scope: 'workspace',
				inclusion: 'always',
				raw: '   ',
				body: '   ',
			},
			{
				id: 'bad-auto',
				fileName: 'bad-auto.md',
				filePath: '/ws/.tarot/steering/bad-auto.md',
				scope: 'workspace',
				inclusion: 'auto',
				raw: 'Some auto rule without description metadata.',
				body: 'Some auto rule without description metadata.',
			},
		];

		const findings = auditSteeringDocuments(docs);
		assert.ok(findings.some(f => f.kind === 'redundant' && f.fileName === 'rule-b.md'));
		assert.ok(findings.some(f => f.kind === 'obsolete-workaround' && f.fileName === 'legacy.md'));
		assert.ok(findings.some(f => f.kind === 'empty' && f.fileName === 'empty.md'));
		assert.ok(findings.some(f => f.kind === 'invalid-frontmatter' && f.fileName === 'bad-auto.md'));
	});
});
