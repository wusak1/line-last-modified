import type { DeviceInfo, DeviceSigningKey, EventVerificationStatus, HistoryEvent } from './types';

export interface StoredSigningIdentity {
	deviceId: string;
	privateKeyJwk: JsonWebKey;
	keys: DeviceSigningKey[];
	currentKeyId: string;
}

const DB_NAME = 'line-last-modified-local';
const STORE_NAME = 'device-signing-identities';

export class DeviceTrustManager {
	private identity: StoredSigningIdentity | null = null;

	async initialize(deviceId: string): Promise<void> {
		try {
			this.identity = await this.load(deviceId) ?? await generateSigningIdentity(deviceId);
			await this.save(this.identity);
		} catch {
			// Signing is optional. A denied or damaged IndexedDB must leave core history usable and unsigned.
			this.identity = null;
		}
	}

	get signingKeys(): DeviceSigningKey[] { return this.identity?.keys.map(key => ({ ...key })) ?? []; }
	get currentKeyId(): string | undefined { return this.identity?.currentKeyId; }

	async sign(event: HistoryEvent): Promise<HistoryEvent> {
		if (!this.identity) return event;
		const signature = await signHistoryEvent(event, this.identity.privateKeyJwk, this.identity.currentKeyId);
		return { ...event, signature } as HistoryEvent;
	}

	async rotate(): Promise<string> {
		if (!this.identity) throw new Error('Device signing identity is not initialized.');
		const previous = this.identity;
		const next = await generateSigningIdentity(this.identity.deviceId);
		const retiredAt = new Date().toISOString();
		const rotated: StoredSigningIdentity = {
			...previous,
			keys: [...previous.keys.map(key => key.keyId === previous.currentKeyId ? { ...key, retiredAt } : key), ...next.keys],
			privateKeyJwk: next.privateKeyJwk,
			currentKeyId: next.currentKeyId,
		};
		this.identity = rotated;
		try { await this.save(rotated); }
		catch (error) { this.identity = previous; throw error; }
		return next.currentKeyId;
	}

	async verify(event: HistoryEvent, device: DeviceInfo | undefined, trusted: Set<string>, revoked: Set<string>, ownDeviceId: string): Promise<EventVerificationStatus> {
		if (!event.signature) return 'unsigned';
		if (revoked.has(event.signature.keyId)) return 'revoked';
		const key = device?.signingKeys?.find(value => value.keyId === event.signature?.keyId);
		if (!key || !await verifyHistoryEvent(event, key.publicKeyJwk)) return 'invalid';
		return event.deviceId === ownDeviceId || trusted.has(key.keyId) ? 'verified-trusted' : 'verified-untrusted';
	}

	private async load(deviceId: string): Promise<StoredSigningIdentity | null> {
		if (typeof indexedDB === 'undefined') return null;
		const database = await openDatabase();
		const value = await request<StoredSigningIdentity | undefined>(database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(deviceId));
		database.close();
		return value ?? null;
	}

	private async save(identity: StoredSigningIdentity): Promise<void> {
		if (typeof indexedDB === 'undefined') return;
		const database = await openDatabase();
		await request(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(identity));
		database.close();
	}
}

export async function generateSigningIdentity(deviceId: string): Promise<StoredSigningIdentity> {
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
	const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
	const keyId = await signingKeyFingerprint(publicKeyJwk);
	return { deviceId, privateKeyJwk, currentKeyId: keyId,
		keys: [{ keyId, algorithm: 'ECDSA-P256-SHA256', publicKeyJwk, createdAt: new Date().toISOString() }] };
}

export async function signHistoryEvent(event: HistoryEvent, privateKeyJwk: JsonWebKey, keyId: string) {
	const key = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
	const bytes = new TextEncoder().encode(canonicalEvent(event));
	const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes);
	return { keyId, algorithm: 'ECDSA-P256-SHA256' as const, value: bytesToBase64(new Uint8Array(signature)) };
}

export async function verifyHistoryEvent(event: HistoryEvent, publicKeyJwk: JsonWebKey): Promise<boolean> {
	if (!event.signature || event.signature.algorithm !== 'ECDSA-P256-SHA256') return false;
	try {
		const key = await crypto.subtle.importKey('jwk', publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
		const signature = base64ToBytes(event.signature.value);
		return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature.buffer as ArrayBuffer, new TextEncoder().encode(canonicalEvent(event)));
	} catch { return false; }
}

export async function signingKeyFingerprint(publicKeyJwk: JsonWebKey): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(publicKeyJwk)));
	return [...new Uint8Array(digest)].slice(0, 16).map(value => value.toString(16).padStart(2, '0')).join('');
}

function canonicalEvent(event: HistoryEvent): string {
	const { signature: _signature, ...unsigned } = event;
	return stableStringify(unsigned);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
	return JSON.stringify(value);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const value of bytes) binary += String.fromCharCode(value);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open(DB_NAME, 2);
		open.onupgradeneeded = () => {
			if (!open.result.objectStoreNames.contains('journal-snapshots')) open.result.createObjectStore('journal-snapshots', { keyPath: 'id' });
			if (!open.result.objectStoreNames.contains(STORE_NAME)) open.result.createObjectStore(STORE_NAME, { keyPath: 'deviceId' });
		};
		open.onsuccess = () => resolve(open.result);
		open.onerror = () => reject(open.error);
	});
}

function request<T = unknown>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
