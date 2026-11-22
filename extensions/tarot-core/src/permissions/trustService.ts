/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Thin wrapper around `vscode.workspace.isTrusted` plus the external, out-of-repo locations for
 * user/workspace `permissions.yaml` files (AGENTS.md §2d / MIGRATION_PLAN.md M3.8a: a cloned
 * repo must never be able to inject permission rules via a committed file). Kept as the only
 * `vscode`-touching module in `permissions/`, so `permissionsService`/`policyEngine` stay unit
 * testable without the extension host (cf. `hooks/hookEngine.ts`'s own convention).
 */
export class TarotTrustService implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTrust = this.changeEmitter.event;

	constructor() {
		this.disposables.push(
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.changeEmitter.fire()),
			this.changeEmitter,
		);
	}

	isWorkspaceTrusted(): boolean {
		return vscode.workspace.isTrusted;
	}

	getUserPermissionsPath(): string {
		return path.join(os.homedir(), '.tarot', 'settings', 'permissions.yaml');
	}

	/**
	 * Workspace-scoped `permissions.yaml` lives **outside** the repository, keyed by a hash of
	 * the workspace's absolute path, so a cloned repo can never ship its own override.
	 */
	getWorkspacePermissionsPath(workspaceRoot: string): string {
		const hash = crypto.createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 16);
		return path.join(os.homedir(), '.tarot-ide', 'workspace-roots', hash, 'permissions.yaml');
	}

	requireTrustedOrWarn(message: string): boolean {
		if (this.isWorkspaceTrusted()) {
			return true;
		}
		void vscode.window.showWarningMessage(message);
		return false;
	}

	dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
