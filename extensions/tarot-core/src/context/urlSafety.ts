/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola. All rights reserved.
 *  Licensed under the GNU General Public License v3.0. See LICENSE in the project root.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'node:net';

export type SafeUrlValidationResult =
	| { readonly ok: true; readonly url: URL }
	| { readonly ok: false; readonly reason: string };

/**
 * Pure SSRF validation for user-supplied `#URL` context fetches.
 * Requires `https:`, rejects embedded credentials, and blocks loopback,
 * link-local, metadata, and RFC1918 / ULA private addresses.
 */
export function validateSafeHttpsUrl(rawUrl: string): SafeUrlValidationResult {
	const trimmed = rawUrl.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, reason: 'Invalid URL format.' };
	}

	if (parsed.protocol !== 'https:') {
		return { ok: false, reason: 'Only https:// URLs are allowed.' };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, reason: 'URLs with embedded credentials are not allowed.' };
	}

	const rawHost = parsed.hostname.toLowerCase();
	const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
	if (!host) {
		return { ok: false, reason: 'Missing hostname.' };
	}

	if (
		host === 'localhost'
		|| host.endsWith('.localhost')
		|| host.endsWith('.local')
		|| host.endsWith('.internal')
	) {
		return { ok: false, reason: 'Local or internal hostnames are blocked.' };
	}

	const ipType = net.isIP(host);
	if (ipType === 4 && isPrivateIpv4(host)) {
		return { ok: false, reason: 'Private or loopback IPv4 addresses are blocked.' };
	}
	if (ipType === 6 && isPrivateIpv6(host)) {
		return { ok: false, reason: 'Private or loopback IPv6 addresses are blocked.' };
	}

	return { ok: true, url: parsed };
}

function isPrivateIpv4(ip: string): boolean {
	const parts = ip.split('.').map(n => Number.parseInt(n, 10));
	if (parts.length !== 4 || parts.some(n => !Number.isFinite(n) || n < 0 || n > 255)) {
		return true;
	}
	const [a, b] = parts;
	if (a === 0 || a === 10 || a === 127) {
		return true;
	}
	if (a === 169 && b === 254) {
		return true; // Link-local & cloud metadata (169.254.169.254)
	}
	if (a === 172 && b >= 16 && b <= 31) {
		return true;
	}
	if (a === 192 && b === 168) {
		return true;
	}
	if (a === 100 && b >= 64 && b <= 127) {
		return true; // CGNAT
	}
	return false;
}

function isPrivateIpv6(ip: string): boolean {
	const lower = ip.toLowerCase();
	if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
		return true;
	}
	if (lower.startsWith('::ffff:')) {
		const mapped = lower.slice('::ffff:'.length);
		if (net.isIP(mapped) === 4) {
			return isPrivateIpv4(mapped);
		}
		return true;
	}
	return false;
}
