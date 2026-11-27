/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { parseGitSkillUrl, parseSkillMarkdown, resolveSkillsForPrompt, SkillDefinition, TarotSkillsService } from '../skills/skillsService';

function makeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
	return {
		id: 'react-perf',
		name: 'React Performance',
		description: 'Optimize React rendering and memoization',
		scope: 'workspace',
		dirPath: '/ws/.tarot/skills/react-perf',
		skillFilePath: '/ws/.tarot/skills/react-perf/SKILL.md',
		body: 'Always profile with React DevTools before memoizing.',
		hasScripts: false,
		hasReferences: false,
		...overrides,
	};
}

describe('skillsService', () => {
	it('parses SKILL.md frontmatter and body', () => {
		const parsed = parseSkillMarkdown('---\nname: SQL Audit\ndescription: Review SQL queries for injection\n---\n\nCheck parameterized queries.', 'sql-audit');
		assert.equal(parsed.name, 'SQL Audit');
		assert.equal(parsed.description, 'Review SQL queries for injection');
		assert.equal(parsed.body, 'Check parameterized queries.');
	});

	it('applies progressive disclosure: catalog only until matched or invoked via /name or $name', () => {
		const skills = [makeSkill({})];

		const unrelated = resolveSkillsForPrompt(skills, 'Fix the Dockerfile entrypoint');
		assert.match(unrelated.catalogContext ?? '', /\/react-perf/);
		assert.equal(unrelated.activeSkills.length, 0);
		assert.equal(unrelated.activeContext, undefined);

		const bySlash = resolveSkillsForPrompt(skills, '/react-perf check App.tsx');
		assert.equal(bySlash.activeSkills.length, 1);
		assert.match(bySlash.activeContext ?? '', /React DevTools/);

		const byDollar = resolveSkillsForPrompt(skills, 'Please use $react-perf here');
		assert.equal(byDollar.activeSkills.length, 1);

		const byTopic = resolveSkillsForPrompt(skills, 'Help me optimize React rendering performance');
		assert.equal(byTopic.activeSkills.length, 1);
	});

	it('parses GitHub and GitLab tree URLs with subpaths and blocks unsafe URLs', () => {
		const parsed = parseGitSkillUrl('https://github.com/acme/skills/tree/main/packages/sql-audit');
		assert.deepEqual(parsed, {
			repoUrl: 'https://github.com/acme/skills.git',
			repoName: 'skills',
			branch: 'main',
			subpath: 'packages/sql-audit',
		});
		assert.equal(parseGitSkillUrl('file:///etc/passwd'), undefined);
		assert.equal(parseGitSkillUrl('https://localhost/acme/skills'), undefined);
		assert.equal(parseGitSkillUrl('https://github.com/acme/skills/tree/--upload-pack=evil/sub'), undefined);
		assert.equal(parseGitSkillUrl('https://github.com/acme/skills/tree/main/../../etc'), undefined);
	});

	it('imports a skill from a local folder and lets workspace override global', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-skills-test-'));
		try {
			const srcSkill = path.join(tmp, 'src-skill');
			await fs.mkdir(srcSkill, { recursive: true });
			await fs.writeFile(path.join(srcSkill, 'SKILL.md'), '---\nname: Local Skill\ndescription: Test skill\n---\nBody content', 'utf8');

			const wsRoot = path.join(tmp, 'ws');
			const service = new TarotSkillsService();
			const imported = await service.importFromLocalFolder(srcSkill, service.getWorkspaceSkillsDir(wsRoot));
			assert.equal(imported.id, 'src-skill');
			assert.equal(imported.name, 'Local Skill');

			const untrusted = await service.discover(wsRoot, false);
			assert.equal(untrusted.some(s => s.id === 'src-skill' && s.scope === 'workspace'), false);

			const discovered = await service.discover(wsRoot, true);
			assert.ok(discovered.some(s => s.id === 'src-skill' && s.scope === 'workspace'));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
