/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentId, AgentMode, AgentSession, SessionMessage } from './types';

export class TarotSessionStore {
	private currentSession: AgentSession | undefined;

	getOrCreateSession(activeAgentId: AgentId, mode: AgentMode): AgentSession {
		if (!this.currentSession) {
			this.currentSession = this.createSession(activeAgentId, mode);
		}
		return this.currentSession;
	}

	resetSession(activeAgentId: AgentId, mode: AgentMode): AgentSession {
		this.currentSession = this.createSession(activeAgentId, mode);
		return this.currentSession;
	}

	async appendMessage(session: AgentSession, message: Omit<SessionMessage, 'id' | 'timestamp'>): Promise<SessionMessage> {
		const entry: SessionMessage = {
			...message,
			id: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
		};
		session.messages.push(entry);
		session.updatedAt = entry.timestamp;
		await this.persist(session);
		return entry;
	}

	private createSession(activeAgentId: AgentId, mode: AgentMode): AgentSession {
		const now = new Date().toISOString();
		return {
			id: `session-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
			title: 'New Session',
			createdAt: now,
			updatedAt: now,
			activeAgentId,
			mode,
			messages: [],
		};
	}

	private async persist(session: AgentSession): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) {
			return;
		}
		try {
			const dir = path.join(folder.uri.fsPath, '.tarot', 'sessions');
			await fs.mkdir(dir, { recursive: true });
			const filePath = path.join(dir, `${session.id}.json`);
			await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf8');
		} catch {
			// Best-effort persistence (e.g., read-only workspace)
		}
	}
}
