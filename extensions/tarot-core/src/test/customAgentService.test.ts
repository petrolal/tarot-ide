/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { parseCustomAgentFile, TarotCustomAgentService } from '../agents/customAgentService';

describe('customAgentService', () => {
	it('parses markdown custom agent with frontmatter tools, excludedTools and permissions', () => {
		const md = [
			'---',
			'name: Security Reviewer',
			'description: Audits diffs for security vulnerabilities',
			'tools: [fs_read, diagnostics]',
			'excludedTools: [shell]',
			'includeMcpJson: false',
			'permissions:',
			'  version: 1',
			'  rules:',
			'    - capability: fs_write',
			'      effect: deny',
			'---',
			'',
			'Focus strictly on OWASP Top 10 and auth boundaries.',
		].join('\n');

		const profile = parseCustomAgentFile(md, '.md', 'team/security', 'workspace', '/ws/.tarot/agents/team/security.md');
		assert.ok(profile);
		assert.equal(profile.id, 'team/security');
		assert.equal(profile.name, 'Security Reviewer');
		assert.deepEqual(profile.tools, ['fs_read', 'diagnostics']);
		assert.deepEqual(profile.excludedTools, ['shell']);
		assert.equal(profile.includeMcpJson, false);
		assert.equal(profile.permissions?.length, 1);
		assert.equal(profile.permissions?.[0].effect, 'deny');
		assert.match(profile.prompt ?? '', /OWASP Top 10/);
	});

	it('discovers nested workspace custom agents alongside built-ins', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-agents-test-'));
		try {
			const nested = path.join(tmp, '.tarot', 'agents', 'team');
			await fs.mkdir(nested, { recursive: true });
			await fs.writeFile(
				path.join(nested, 'planner.json'),
				JSON.stringify({ name: 'Team Planner', description: 'Plans sprints', prompt: 'Be concise.' }),
				'utf8',
			);
			const svc = new TarotCustomAgentService();
			const profiles = await svc.discover(tmp);
			assert.ok(profiles.some(p => p.id === 'default' && p.origin === 'builtIn'));
			const planner = profiles.find(p => p.id === 'team/planner');
			assert.ok(planner);
			assert.equal(planner.origin, 'workspace');
			assert.equal(planner.name, 'Team Planner');
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
