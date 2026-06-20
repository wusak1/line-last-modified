import type { DevicePlatform, LineLastModifiedSettings, LineQuery } from './types';

export function normalizeLine(line: string): string {
	return line.trim().replace(/\s+/g, ' ');
}

// Small synchronous SHA-256 implementation. Editor updates cannot wait for WebCrypto.
export function sha256(input: string): string {
	return bytesToHex(sha256Bytes(new TextEncoder().encode(input)));
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
	const words: number[] = [];
	const bitLength = bytes.length * 8;
	for (const byte of bytes) words.push(byte);
	words.push(0x80);
	while ((words.length % 64) !== 56) words.push(0);
	for (let i = 7; i >= 0; i--) words.push(Math.floor(bitLength / (2 ** (i * 8))) & 0xff);

	const k = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	];
	const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
	const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

	for (let offset = 0; offset < words.length; offset += 64) {
		const w = new Array<number>(64);
		for (let i = 0; i < 16; i++) {
			const p = offset + i * 4;
			w[i] = ((words[p] << 24) | (words[p + 1] << 16) | (words[p + 2] << 8) | words[p + 3]) | 0;
		}
		for (let i = 16; i < 64; i++) {
			const s0 = rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
		}
		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 64; i++) {
			const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + s1 + ch + k[i] + w[i]) | 0;
			const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (s0 + maj) | 0;
			hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
		}
		h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
		h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
	}
	const output = new Uint8Array(32);
	for (let index = 0; index < h.length; index++) {
		const value = h[index] >>> 0;
		output[index * 4] = value >>> 24; output[index * 4 + 1] = value >>> 16;
		output[index * 4 + 2] = value >>> 8; output[index * 4 + 3] = value;
	}
	return output;
}

export function hmacSha256(key: string, input: string): string {
	let keyBytes = new TextEncoder().encode(key);
	if (keyBytes.length > 64) keyBytes = new Uint8Array(sha256Bytes(keyBytes));
	const block = new Uint8Array(64); block.set(keyBytes);
	const innerPad = block.map(value => value ^ 0x36);
	const outerPad = block.map(value => value ^ 0x5c);
	const message = new TextEncoder().encode(input);
	const inner = new Uint8Array(innerPad.length + message.length); inner.set(innerPad); inner.set(message, innerPad.length);
	const innerHash = sha256Bytes(inner);
	const outer = new Uint8Array(outerPad.length + innerHash.length); outer.set(outerPad); outer.set(innerHash, outerPad.length);
	return bytesToHex(sha256Bytes(outer));
}

function bytesToHex(bytes: Uint8Array): string { return [...bytes].map(value => value.toString(16).padStart(2, '0')).join(''); }

export function hashLine(line: string): string {
	return sha256(line).slice(0, 12);
}

export function hashNormalizedLine(line: string): string {
	return sha256(normalizeLine(line)).slice(0, 12);
}

export function keyedHashLine(line: string, key?: string): string { return (key ? hmacSha256(key, line) : sha256(line)).slice(0, 12); }
export function keyedHashNormalizedLine(line: string, key?: string): string { return (key ? hmacSha256(key, normalizeLine(line)) : sha256(normalizeLine(line))).slice(0, 12); }

export function buildLineHashes(query: LineQuery): Pick<LineQuery, 'filePath' | 'lineNumber' | 'lineText'> & {
	contentHash: string;
	normalizedContentHash: string;
	beforeContextHash?: string;
	afterContextHash?: string;
} {
	return {
		filePath: query.filePath,
		lineNumber: query.lineNumber,
		lineText: query.lineText,
		contentHash: keyedHashLine(query.lineText, query.hashKey),
		normalizedContentHash: keyedHashNormalizedLine(query.lineText, query.hashKey),
		beforeContextHash: query.beforeLine === undefined ? undefined : keyedHashNormalizedLine(query.beforeLine, query.hashKey),
		afterContextHash: query.afterLine === undefined ? undefined : keyedHashNormalizedLine(query.afterLine, query.hashKey),
	};
}

export function relativeTime(timestamp: string | number, now = Date.now()): string {
	const value = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
	if (!Number.isFinite(value)) return 'at an unknown time';
	const delta = now - value;
	if (delta < -60_000) return 'in the future';
	if (delta < 60_000) return 'just now';
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
	const weeks = Math.floor(days / 7);
	if (days < 30) return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
	const months = Math.floor(days / 30);
	if (days < 365) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
	const years = Math.floor(days / 365);
	return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

export function absoluteTime(timestamp: string | number): string {
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return 'Unknown time';
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function displayTime(timestamp: string | number, settings: LineLastModifiedSettings, now = Date.now()): string {
	if (settings.displayMode === 'absolute') return absoluteTime(timestamp);
	if (settings.displayMode === 'both') return `${relativeTime(timestamp, now)} (${absoluteTime(timestamp)})`;
	const thresholdValue = Number(settings.absoluteTimeAfter);
	if (Number.isFinite(thresholdValue) && thresholdValue > 0) {
		const unitMs = settings.absoluteTimeAfterUnit === 'hours' ? 3_600_000 : 86_400_000;
		const timestampMs = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
		if (Number.isFinite(timestampMs) && now - timestampMs >= thresholdValue * unitMs) return absoluteTime(timestamp);
	}
	return relativeTime(timestamp, now);
}

export function timestampFontFamily(settings: LineLastModifiedSettings): string {
	return settings.timestampFontFamily.trim() || 'var(--font-monospace)';
}

export function timestampFontSizePx(settings: LineLastModifiedSettings): number {
	const value = Number(settings.timestampFontSizePx);
	return Number.isFinite(value) ? Math.min(32, Math.max(8, value)) : 11;
}

export function safeId(prefix: string): string {
	const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	return `${prefix}-${random.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)}`;
}

export function defaultDeviceName(platform: DevicePlatform): string {
	return platform === 'mobile' || platform === 'tablet' ? 'Mobile device' : 'Desktop device';
}

export function normalizeVaultPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

export interface VaultMetadataPathValidation {
	valid: boolean;
	normalized: string;
	error?: string;
}

export function validateSyncMetadataDir(path: string): VaultMetadataPathValidation {
	const raw = path.trim();
	const normalized = normalizeVaultPath(raw);
	if (!raw || !normalized) {
		return { valid: false, normalized, error: 'Metadata folder cannot be empty.' };
	}
	if (/^(?:[a-zA-Z]:|[\\/]{1,2})/.test(raw)) {
		return { valid: false, normalized, error: 'Metadata folder must be relative to the vault.' };
	}
	const segments = raw.replace(/\\/g, '/').split('/');
	if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
		return { valid: false, normalized, error: 'Metadata folder cannot contain empty, . or .. path segments.' };
	}
	if (normalized.toLowerCase() === '.obsidian' || normalized.toLowerCase().startsWith('.obsidian/')) {
		return { valid: false, normalized, error: 'Metadata folder cannot be inside the .obsidian configuration folder.' };
	}
	return { valid: true, normalized };
}

export function isPathExcluded(filePath: string, settings: LineLastModifiedSettings): boolean {
	const normalized = normalizeVaultPath(filePath);
	const excludedFolders = new Set([...settings.excludedFolders, settings.syncMetadataDir].map(normalizeVaultPath));
	for (const folder of excludedFolders) {
		if (folder && (normalized === folder || normalized.startsWith(`${folder}/`))) return true;
	}
	return settings.excludedFiles.map(normalizeVaultPath).includes(normalized);
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delay: () => number): (...args: Parameters<T>) => void {
	let timer: number | undefined;
	return (...args: Parameters<T>) => {
		if (timer !== undefined) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = undefined;
			fn(...args);
		}, delay());
	};
}
