/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { forkSessionMessages } from '../context/compactionService';
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
			title: mode === 'spec' ? vscode.l10n.t('Spec: new task') : vscode.l10n.t('New session'),
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
			return this.createSession(fallbackAgentId, 'vibe', 'acceptFileChanges');
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

	async saveSession(session: AgentSession): Promise<void> {
		session.updatedAt = new Date().toISOString();
		await this.persist(session);
	}

	/** Creates a new session forked from `source` up to `upToMessageId` without touching workspace files. */
	async forkSession(source: AgentSession, upToMessageId: string): Promise<AgentSession> {
		const now = new Date().toISOString();
		const forked: AgentSession = {
			id: `session-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
			title: vscode.l10n.t('Fork: {0}', source.title),
			createdAt: now,
			updatedAt: now,
			activeAgentId: source.activeAgentId,
			mode: source.mode,
			autonomy: source.autonomy,
			messages: forkSessionMessages(source.messages, upToMessageId),
		};
		this.sessions.push(forked);
		this.activeSessionId = forked.id;
		await this.persist(forked);
		return forked;
	}

	/** Truncates session messages back to right before the turn that owns `checkpointId` (Restore = files + context). */
	async truncateBeforeCheckpoint(session: AgentSession, checkpointId: string): Promise<boolean> {
		const idx = session.messages.findIndex(m => m.checkpointId === checkpointId);
		if (idx === -1) {
			return false;
		}
		// Also drop the triggering user message immediately preceding this assistant message if present.
		const cutAt = idx > 0 && session.messages[idx - 1].role === 'user' ? idx - 1 : idx;
		session.messages = session.messages.slice(0, cutAt);
		await this.saveSession(session);
		return true;
	}

	/** Lists all persisted sessions from `.tarot/sessions/*.json`, sorted newest-first. */
	async listPersistedSessions(workspaceRoot?: string): Promise<AgentSession[]> {
		const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return [];
		}
		const dir = path.join(root, '.tarot', 'sessions');
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return [];
		}
		const loaded: AgentSession[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) {
				continue;
			}
			try {
				const parsed = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')) as AgentSession;
				if (parsed && typeof parsed.id === 'string' && Array.isArray(parsed.messages)) {
					loaded.push(parsed);
				}
			} catch {
				// Skip corrupt session file
			}
		}
		return loaded.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
	}

	/** Hydrates the most recent persisted sessions into open tabs on startup (if none are open yet). */
	async hydrateFromDisk(workspaceRoot?: string, maxTabs = 3): Promise<number> {
		if (this.sessions.length > 0) {
			return 0;
		}
		const persisted = await this.listPersistedSessions(workspaceRoot);
		const toOpen = persisted.slice(0, maxTabs);
		for (const s of toOpen) {
			this.sessions.push(s);
		}
		if (toOpen.length > 0) {
			this.activeSessionId = toOpen[0].id;
		}
		return toOpen.length;
	}

	/** Opens a persisted session in the tab bar (or focuses it if already open). */
	openPersistedSession(session: AgentSession): AgentSession {
		const existing = this.sessions.find(s => s.id === session.id);
		if (existing) {
			this.activeSessionId = existing.id;
			return existing;
		}
		this.sessions.push(session);
		this.activeSessionId = session.id;
		return session;
	}

	/** Deletes a persisted session file from `.tarot/sessions/`. */
	async deletePersistedSession(sessionId: string, workspaceRoot?: string): Promise<void> {
		const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			return;
		}
		await fs.rm(path.join(root, '.tarot', 'sessions', `${sessionId}.json`), { force: true }).catch(() => undefined);
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
