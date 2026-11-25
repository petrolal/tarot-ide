/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { validateSafeHttpsUrl } from '../context/urlSafety';

export type GatewayKind = 'slack' | 'discord' | 'telegram' | 'teams';

/**
 * Non-secret metadata stored in `.tarot/crew/gateways.json`.
 * Webhook URLs and bot tokens MUST be stored exclusively in VS Code SecretStorage.
 */
export interface GatewayMetadata {
	readonly id: string;
	readonly kind: GatewayKind;
	readonly label: string;
	readonly enabled: boolean;
	/** Required only for Telegram (`chat_id`). */
	readonly chatId?: string;
}

export interface VerifiedWebhookEvent {
	readonly hookId: string;
	readonly receivedAt: string;
	readonly payload: Record<string, unknown>;
}

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/** Computes `sha256=<hex>` HMAC signature for local webhook authentication. Pure — unit-testable. */
export function computeWebhookSignature(secret: string, body: string): string {
	const digest = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
	return `sha256=${digest}`;
}

/** Constant-time verification of `X-Tarot-Signature` (`sha256=<hex>`). Pure — unit-testable. */
export function verifyWebhookSignature(secret: string, body: string, signatureHeader: string | undefined): boolean {
	if (!secret || !signatureHeader) {
		return false;
	}
	const expected = computeWebhookSignature(secret, body);
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(signatureHeader.trim(), 'utf8');
	if (a.length !== b.length) {
		return false;
	}
	return crypto.timingSafeEqual(a, b);
}

/** Formats an outbound message payload for Slack, Discord, Telegram, or Microsoft Teams. Pure. */
export function formatGatewayPayload(kind: GatewayKind, title: string, message: string, chatId?: string): Record<string, unknown> {
	const text = `**[Tarot Crew] ${title}**\n${message}`;
	switch (kind) {
		case 'slack':
			return { text: `*[Tarot Crew] ${title}*\n${message}` };
		case 'discord':
			return { content: text.slice(0, 1950) };
		case 'telegram':
			return { chat_id: chatId ?? '', text: `[Tarot Crew] ${title}\n${message}` };
		case 'teams':
			return { text };
	}
}

/**
 * Manages outbound omnichannel gateways (Slack, Discord, Telegram, Teams) and an opt-in
 * loopback-only (`127.0.0.1`) HMAC-authenticated local webhook server.
 */
export class TarotGatewayService {
	private server: http.Server | undefined;
	private listeningPort: number | undefined;

	getGatewaysConfigPath(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'crew', 'gateways.json');
	}

	isWebhookServerRunning(): boolean {
		return this.server !== undefined && this.listeningPort !== undefined;
	}

	getWebhookServerPort(): number | undefined {
		return this.listeningPort;
	}

	async listGateways(workspaceRoot: string): Promise<GatewayMetadata[]> {
		try {
			const raw = JSON.parse(await fs.readFile(this.getGatewaysConfigPath(workspaceRoot), 'utf8'));
			if (!Array.isArray(raw)) {
				return [];
			}
			return raw.filter((g): g is GatewayMetadata =>
				Boolean(g && typeof g === 'object' && typeof g.id === 'string' && typeof g.kind === 'string' && typeof g.label === 'string'),
			);
		} catch {
			return [];
		}
	}

	async saveGateway(workspaceRoot: string, gateway: GatewayMetadata): Promise<void> {
		const existing = await this.listGateways(workspaceRoot);
		const next = [...existing.filter(g => g.id !== gateway.id), gateway];
		const configPath = this.getGatewaysConfigPath(workspaceRoot);
		await fs.mkdir(path.dirname(configPath), { recursive: true });
		await fs.writeFile(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
	}

	/**
	 * Sends a message through a configured gateway using a secret URL/token fetched from SecretStorage.
	 * Validates the target URL with `validateSafeHttpsUrl` (anti-SSRF) before sending.
	 */
	async sendGatewayMessage(
		gateway: GatewayMetadata,
		secretUrlOrToken: string,
		title: string,
		message: string,
	): Promise<{ readonly ok: boolean; readonly status: number; readonly error?: string }> {
		const targetUrl = gateway.kind === 'telegram'
			? `https://api.telegram.org/bot${encodeURIComponent(secretUrlOrToken.trim())}/sendMessage`
			: secretUrlOrToken.trim();

		const urlCheck = await validateSafeHttpsUrl(targetUrl);
		if (!urlCheck.ok) {
			return { ok: false, status: 0, error: urlCheck.reason };
		}

		const payload = formatGatewayPayload(gateway.kind, title, message, gateway.chatId);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10_000);
		try {
			const res = await fetch(targetUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
				redirect: 'manual',
				signal: controller.signal,
			});
			return res.ok
				? { ok: true, status: res.status }
				: { ok: false, status: res.status, error: `HTTP ${res.status}` };
		} catch (err) {
			return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Starts an opt-in local webhook receiver bound strictly to `127.0.0.1`.
	 * Every `POST /webhook/<hookId>` request MUST include a valid `X-Tarot-Signature: sha256=<hex>`
	 * HMAC-SHA256 signature computed with `sharedSecret`.
	 */
	async startWebhookServer(
		sharedSecret: string,
		onEvent: (event: VerifiedWebhookEvent) => void | Promise<void>,
		port = 0,
	): Promise<number> {
		if (!sharedSecret || sharedSecret.length < 16) {
			throw new Error('Webhook shared secret must be at least 16 characters.');
		}
		await this.stopWebhookServer();

		return await new Promise<number>((resolve, reject) => {
			const srv = http.createServer((req, res) => {
				const urlPath = (req.url ?? '').split('?')[0];
				const match = urlPath.match(/^\/webhook\/([a-zA-Z0-9._-]+)$/);
				if (req.method !== 'POST' || !match) {
					res.writeHead(404, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'Not found' }));
					return;
				}
				const hookId = match[1];
				const chunks: Buffer[] = [];
				let totalBytes = 0;
				let aborted = false;

				req.on('data', (chunk: Buffer) => {
					totalBytes += chunk.length;
					if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
						aborted = true;
						res.writeHead(413, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: 'Payload too large' }));
						req.destroy();
						return;
					}
					chunks.push(chunk);
				});

				req.on('end', () => {
					if (aborted) {
						return;
					}
					const rawBody = Buffer.concat(chunks).toString('utf8');
					const sig = typeof req.headers['x-tarot-signature'] === 'string'
						? req.headers['x-tarot-signature']
						: undefined;
					if (!verifyWebhookSignature(sharedSecret, rawBody, sig)) {
						res.writeHead(401, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: 'Invalid signature' }));
						return;
					}
					let parsed: Record<string, unknown>;
					try {
						const obj = JSON.parse(rawBody || '{}');
						parsed = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj as Record<string, unknown> : { value: obj };
					} catch {
						res.writeHead(400, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: 'Invalid JSON' }));
						return;
					}
					const event: VerifiedWebhookEvent = {
						hookId,
						receivedAt: new Date().toISOString(),
						payload: parsed,
					};
					void Promise.resolve(onEvent(event)).catch(() => undefined);
					res.writeHead(202, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ accepted: true, hookId }));
				});
			});

			srv.on('error', err => reject(err));
			srv.listen(port, '127.0.0.1', () => {
				const addr = srv.address();
				const boundPort = typeof addr === 'object' && addr ? addr.port : port;
				this.server = srv;
				this.listeningPort = boundPort;
				resolve(boundPort);
			});
		});
	}

	async stopWebhookServer(): Promise<void> {
		const srv = this.server;
		this.server = undefined;
		this.listeningPort = undefined;
		if (!srv) {
			return;
		}
		await new Promise<void>(resolve => srv.close(() => resolve()));
	}

	dispose(): void {
		void this.stopWebhookServer();
	}
}
