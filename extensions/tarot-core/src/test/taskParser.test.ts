/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { markTaskCompletedInFile, parseTasksMarkdown } from '../specs/taskParser';

describe('taskParser', () => {
	it('parses checklists with mixed completed and pending items', () => {
		const md = [
			'# Tasks — demo',
			'',
			'- [x] 1. Define contracts',
			'- [ ] 2. Implement service',
			'  - [X] 2.1 Add pure helpers',
			'- [ ] 3. *Write optional PBT',
			'Normal bullet item (ignored)',
		].join('\n');

		const summary = parseTasksMarkdown(md);
		assert.equal(summary.total, 4);
		assert.equal(summary.done, 2);
		assert.equal(summary.tasks[0].completed, true);
		assert.equal(summary.tasks[1].completed, false);
		assert.equal(summary.tasks[1].lineIndex, 3);
		assert.equal(summary.tasks[2].completed, true);
		assert.equal(summary.tasks[3].title, '3. *Write optional PBT');
	});

	it('handles empty content and CRLF line endings', () => {
		assert.deepEqual(parseTasksMarkdown(''), { total: 0, done: 0, tasks: [] });
		const summary = parseTasksMarkdown('- [ ] First\r\n- [x] Second\r\n');
		assert.equal(summary.total, 2);
		assert.equal(summary.done, 1);
	});

	it('marks a specific task line completed on disk', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-taskparser-'));
		const filePath = path.join(tmpDir, 'tasks.md');
		try {
			await fs.writeFile(filePath, '# Tasks\n- [ ] 1. One\n- [ ] 2. Two\n', 'utf8');
			const updated = await markTaskCompletedInFile(filePath, 2);
			assert.equal(updated.done, 1);
			assert.equal(updated.total, 2);
			assert.equal(updated.tasks[1].completed, true);
			const raw = await fs.readFile(filePath, 'utf8');
			assert.match(raw, /- \[x\] 2\. Two/);
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});
