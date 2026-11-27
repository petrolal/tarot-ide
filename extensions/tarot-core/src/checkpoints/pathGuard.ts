/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/**
 * `true` only if `fsPath` is `root` itself or strictly nested under it. A plain
 * `fsPath.startsWith(root)` (TD-05) also matches an unrelated sibling that merely shares `root`
 * as a string prefix (e.g. root `/app` matching `/app-staging/x.ts`), letting checkpoint
 * fingerprinting/restore reach outside the intended workspace root.
 */
export function isPathInsideRoot(fsPath: string, root: string): boolean {
	const rel = path.relative(root, fsPath);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
