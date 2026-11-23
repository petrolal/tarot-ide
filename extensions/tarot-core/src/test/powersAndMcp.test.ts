/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { parseAcpSessionUpdate } from '../agents/adapters/acpParser';
import { formatMcpContext, parseMcpConfigJson } from '../mcp/mcpConfigService';
import { matchPowersForPrompt, PowerDefinition } from '../powers/powersService';
import { expandLiveFileReferences, TarotSteeringService } from '../steering/steeringService';

describe('powers, mcpConfigService, acpAdapter & steering M3.8b complements', () => {
	it('activates Powers by keyword and deactivates when topic changes', () => {
		const power: PowerDefinition = {
			id: 'postgres-power',
			manifest: { name: 'Postgres Power', description: 'DB tools', keywords: ['postgres', 'migration'] },
			scope: 'workspace',
			dirPath: '/ws/.tarot/powers/postgres-power',
			skills: [],
			mcpServers: [],
		};

		const hit = matchPowersForPrompt([power], 'Generate a Postgres migration for users');
		assert.equal(hit.activePowers.length, 1);
		assert.match(hit.summaryContext ?? '', /Postgres Power/);

		const miss = matchPowersForPrompt([power], 'Change button padding in CSS');
		assert.equal(miss.activePowers.length, 0);
	});

	it('parses stdio and remote MCP servers and redacts header/env values in formatted context', () => {
		const parsed = parseMcpConfigJson({
			mcpServers: {
				filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'] },
				github: { url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer super-secret-token' } },
				broken: { args: ['missing-cmd'] },
			},
		}, '/ws/.tarot/settings/mcp.json', 'workspace');

		assert.equal(parsed.servers.length, 2);
		assert.equal(parsed.errors.length, 1);
		const formatted = formatMcpContext(parsed.servers);
		assert.match(formatted, /filesystem/);
		assert.match(formatted, /github/);
		assert.doesNotMatch(formatted, /super-secret-token/);
	});

	it('translates ACP session/update notifications into Tarot AgentEvents', () => {
		const textEv = parseAcpSessionUpdate({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } });
		assert.deepEqual(textEv, [{ type: 'text', content: 'hello' }]);

		const toolEv = parseAcpSessionUpdate({ update: { sessionUpdate: 'tool_call', title: 'read_file' } });
		assert.deepEqual(toolEv, [{ type: 'tool_start', toolName: 'read_file' }]);
	});

	it('expands #[[file:...]] safely inside workspaceRoot and discovers nested AGENTS.md', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-steer-38b-'));
		try {
			await fs.mkdir(path.join(tmp, 'packages', 'api'), { recursive: true });
			await fs.writeFile(path.join(tmp, 'packages', 'api', 'AGENTS.md'), 'Always validate DTOs.', 'utf8');
			await fs.writeFile(path.join(tmp, 'schema.txt'), 'user_id: uuid', 'utf8');

			const expanded = await expandLiveFileReferences('Follow #[[file:schema.txt]] and not #[[file:../etc/passwd]]', tmp);
			assert.match(expanded, /user_id: uuid/);
			assert.match(expanded, /#\[\[file:\.\.\/etc\/passwd\]\]/);

			const svc = new TarotSteeringService();
			const docs = await svc.discover(tmp);
			assert.ok(docs.some(d => d.fileName === 'packages/api/AGENTS.md' && d.inclusion === 'fileMatch'));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
