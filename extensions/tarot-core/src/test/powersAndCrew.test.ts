/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
	markTaskDoneInMarkdown,
	parseTaskMarkdown,
	TarotCrewService,
} from '../crew/crewService';
import {
	CURATED_POWERS_CATALOG,
	matchPowersForPrompt,
	parsePowerMarkdown,
	TarotPowersService,
} from '../powers/powersService';
import { TarotSkillsService } from '../skills/skillsService';

describe('Powers management & POWER.md compatibility', () => {
	it('parses POWER.md YAML frontmatter and body', () => {
		const raw = [
			'---',
			'name: Stripe Payments',
			'version: 1.2.0',
			'author: Community',
			'description: Checkout and webhook guidelines',
			'keywords:',
			'  - stripe',
			'  - billing',
			'---',
			'',
			'# Stripe Guide',
			'Verify webhook signatures.',
		].join('\n');
		const parsed = parsePowerMarkdown(raw, 'stripe');
		assert.equal(parsed.manifest.name, 'Stripe Payments');
		assert.equal(parsed.manifest.version, '1.2.0');
		assert.equal(parsed.manifest.author, 'Community');
		assert.deepEqual(parsed.manifest.keywords, ['stripe', 'billing']);
		assert.ok(parsed.body.includes('Verify webhook signatures'));
	});

	it('activates Powers via /power:<id>, #<id>, /<id>, and keywords', () => {
		const powers = [{
			id: 'security-audit',
			manifest: { name: 'Security Audit', description: 'AppSec', keywords: ['owasp', 'ssrf'] },
			scope: 'workspace' as const,
			dirPath: '/tmp/security-audit',
			manifestPath: '/tmp/security-audit/plugin.json',
			skills: [],
			mcpServers: [],
		}];
		assert.equal(matchPowersForPrompt(powers, 'Run /power:security-audit on auth.ts').activePowers.length, 1);
		assert.equal(matchPowersForPrompt(powers, 'Use #security-audit here').activePowers.length, 1);
		assert.equal(matchPowersForPrompt(powers, 'Check for SSRF vulnerabilities').activePowers.length, 1);
		assert.equal(matchPowersForPrompt(powers, 'Change button color to blue').activePowers.length, 0);
	});

	it('installs curated Power, creates custom Power, discovers POWER.md, and enforces uninstall confinement', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-powers-mgmt-'));
		try {
			const skillsSvc = new TarotSkillsService();
			const powersSvc = new TarotPowersService(skillsSvc);
			const powersRoot = path.join(tmp, '.tarot', 'powers');

			assert.ok(CURATED_POWERS_CATALOG.length >= 5);
			const curated = await powersSvc.installCuratedPower('testing-tdd', powersRoot);
			assert.equal(curated.id, 'testing-tdd');
			assert.equal(curated.skills.length, 1);

			const created = await powersSvc.createPowerTemplate(powersRoot, 'my-custom', 'Custom domain', ['custom', 'domain']);
			assert.equal(created.id, 'my-custom');
			assert.deepEqual(created.manifest.keywords, ['custom', 'domain']);

			// Legacy POWER.md fallback
			const legacyDir = path.join(powersRoot, 'legacy-power');
			await fs.mkdir(legacyDir, { recursive: true });
			await fs.writeFile(path.join(legacyDir, 'POWER.md'), '---\nname: Legacy\nkeywords:\n  - legacy\n---\nLegacy instructions.', 'utf8');
			const loadedLegacy = await powersSvc.readSinglePower(legacyDir, 'legacy-power', 'workspace');
			assert.ok(loadedLegacy);
			assert.equal(loadedLegacy.skills.length, 1);

			// Uninstall confinement blocks paths outside allowed roots
			await assert.rejects(
				() => powersSvc.uninstallPower(tmp, [powersRoot]),
				/outside allowed powers directories/i,
			);
			await powersSvc.uninstallPower(created.dirPath, [powersRoot]);
			const existsAfter = await fs.access(created.dirPath).then(() => true).catch(() => false);
			assert.equal(existsAfter, false);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it('creates Agent Skill scaffold with path confinement', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-skills-tpl-'));
		try {
			const skillsSvc = new TarotSkillsService();
			const skill = await skillsSvc.createSkillTemplate(tmp, 'release-check', 'Checklist de release');
			assert.equal(skill.id, 'release-check');
			assert.equal(skill.description, 'Checklist de release');
			const raw = await fs.readFile(skill.skillFilePath, 'utf8');
			assert.ok(raw.includes('name: release-check'));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

describe('Tarot Crew service (Crewmates, Memory, Knowledge Library, TASK.md)', () => {
	it('parses and updates TASK.md checkboxes deterministically', () => {
		const md = '# TASK: Auth\n\n- [ ] Step one\n- [x] Step two\n- [ ] Step three\n';
		const items = parseTaskMarkdown(md);
		assert.equal(items.length, 3);
		assert.equal(items[0].done, false);
		assert.equal(items[1].done, true);
		const updated = markTaskDoneInMarkdown(md, items[0].lineNumber);
		assert.equal(parseTaskMarkdown(updated).filter(t => t.done).length, 2);
	});

	it('manages Crewmates, Work Ledger, Persistent Memory, Knowledge Library, and Context', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-crew-test-'));
		try {
			const crewSvc = new TarotCrewService();
			const cm = await crewSvc.createCrewmate({
				workspaceRoot: tmp,
				scope: 'workspace',
				name: 'Atlas',
				role: 'Release Engineer',
				description: 'Handles releases and QA checks',
			});
			assert.equal(cm.id, 'atlas');
			assert.equal(cm.starred, false);

			const starred = await crewSvc.toggleStar(cm);
			assert.equal(starred, true);

			await crewSvc.appendLedgerEntry(cm, { kind: 'task', summary: 'Validated build', status: 'ok' });
			const ledger = await crewSvc.readLedger(cm);
			assert.equal(ledger.length, 2); // creation note + task entry
			assert.equal(ledger[0].summary, 'Validated build');

			const prefsPath = await crewSvc.ensureMemoryFile(tmp, 'preferences');
			assert.ok(await fs.access(prefsPath).then(() => true).catch(() => false));
			await crewSvc.appendDailyHistory(tmp, 'Completed smoke test');

			// Knowledge Library explicit add -> pending -> scan -> query -> remove
			const docsDir = path.join(tmp, 'docs');
			await fs.mkdir(docsDir, { recursive: true });
			await fs.writeFile(path.join(docsDir, 'arch.md'), '# Architecture\n\nTarot uses an Extension-First architecture with BYOA local CLI agents.\n', 'utf8');

			const src = await crewSvc.addKnowledgeSource(tmp, docsDir);
			assert.equal(src.status, 'pending');
			const indexed = await crewSvc.scanKnowledgeSource(tmp, src.id);
			assert.equal(indexed.status, 'indexed');
			assert.ok(indexed.chunkCount >= 1);

			const hits = await crewSvc.queryKnowledge(tmp, 'Extension-First BYOA architecture', 3);
			assert.ok(hits.length >= 1);
			assert.ok(hits[0].excerpt.includes('Extension-First'));

			const ctx = await crewSvc.buildCrewContext(tmp, cm, 'Extension-First architecture');
			assert.ok(ctx?.includes('Crew Preferences'));
			assert.ok(ctx?.includes('Crewmate Memory (Atlas'));
			assert.ok(ctx?.includes('Knowledge Library Matches'));

			// TASK.md template & discovery
			await crewSvc.createTaskTemplate(tmp, 'refactor-auth', 'Refactor Auth');
			const taskFiles = await crewSvc.discoverTaskFiles(tmp);
			assert.equal(taskFiles.length, 1);
			assert.equal(taskFiles[0].totalCount, 3);
			assert.equal(taskFiles[0].doneCount, 0);

			await crewSvc.removeKnowledgeSource(tmp, src.id);
			assert.equal((await crewSvc.listKnowledgeSources(tmp)).length, 0);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
