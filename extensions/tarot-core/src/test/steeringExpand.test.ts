/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola. All rights reserved.
 *  Licensed under the GNU General Public License v3.0. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { expandLiveFileReferences } from '../steering/steeringService';

describe('steeringService.expandLiveFileReferences', () => {
	it('preserves literal $&, $$ and $\' tokens inside referenced files without corruption', async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tarot-steering-expand-'));
		try {
			const fileContent = 'const price = "$$100"; const re = str.replace(/a/, "$& and $\'");';
			await fs.writeFile(path.join(tmp, 'snippet.ts'), fileContent, 'utf8');

			const expanded = await expandLiveFileReferences('See #[[file:snippet.ts]] end.', tmp);
			assert.ok(expanded.includes(fileContent), `Expected literal dollar sequences to be preserved, got:\n${expanded}`);
			assert.ok(!expanded.includes('#[[file:snippet.ts]]'));
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
