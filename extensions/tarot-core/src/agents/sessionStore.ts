/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentId, AgentMode, AgentSession, AutonomyMode, SessionMessage } from './types';

export class TarotSessionStore {
	private readonly sessions: AgentSession[] = [];
	private activeSessionId: string | undefined;

	listSessions(): readonly AgentSession[] {
		return this.sessions;
	}

	getActiveSession(activeAgentId: AgentId, mode: AgentMode, autonomy: AutonomyMode): AgentSession {
		if (this.activeSessionId) {
			const existing = this.sessions.find(s => s.id === this.activeSessionId);
			if (existing) {
				return existing;
			}
		}
		if (this.sessions.length > 0) {
			this.activeSessionId = this.sessions[0].id;
			return this.sessions[0];
		}
		return this.createSession(activeAgentId, mode, autonomy);
	}

	createSession(activeAgentId: AgentId, mode: AgentMode, autonomy: AutonomyMode): AgentSession {
		const now = new Date().toISOString();
		const session: AgentSession = {
			id: `session-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
			title: mode === 'spec' ? 'Spec: nova tarefa' : 'Nova sessão',
			createdAt: now,
			updatedAt: now,
			activeAgentId,
			mode,
			autonomy,
			messages: [],
		};
		this.sessions.push(session);
		this.activeSessionId = session.id;
		return session;
	}

	selectSession(sessionId: string): AgentSession | undefined {
		const found = this.sessions.find(s => s.id === sessionId);
		if (found) {
			this.activeSessionId = found.id;
		}
		return found;
	}

	closeSession(sessionId: string, fallbackAgentId: AgentId): AgentSession {
		const idx = this.sessions.findIndex(s => s.id === sessionId);
		if (idx !== -1) {
			this.sessions.splice(idx, 1);
		}
		if (this.sessions.length === 0) {
			return this.createSession(fallbackAgentId, 'vibe', 'autopilot');
		}
		const nextIdx = Math.min(idx, this.sessions.length - 1);
		this.activeSessionId = this.sessions[Math.max(0, nextIdx)].id;
		return this.sessions[Math.max(0, nextIdx)];
	}

	async appendMessage(session: AgentSession, message: Omit<SessionMessage, 'id' | 'timestamp'>): Promise<SessionMessage> {
		const entry: SessionMessage = {
			...message,
			id: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
		};
		if (message.role === 'user' && session.messages.length === 0) {
			const clean = message.content.replace(/\s+/g, ' ').trim();
			const prefix = session.mode === 'spec' ? 'Spec: ' : '';
			session.title = `${prefix}${clean.slice(0, 26)}${clean.length > 26 ? '…' : ''}`;
		}
		session.messages.push(entry);
		session.updatedAt = entry.timestamp;
		await this.persist(session);
		return entry;
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
			// Best-effort persistence
		}
	}
}
