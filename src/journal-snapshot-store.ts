export interface LocalJournalSnapshot {
	id: string;
	deviceId: string;
	filePath: string;
	createdAt: string;
	content: string;
}

const DB_NAME = 'line-last-modified-local';
const STORE_NAME = 'journal-snapshots';

export class LocalJournalSnapshotStore {
	async save(deviceId: string, filePath: string, content: string, retentionDays: number): Promise<void> {
		if (typeof indexedDB === 'undefined') return;
		const database = await this.open();
		const createdAt = new Date().toISOString();
		const snapshot: LocalJournalSnapshot = { id: `${deviceId}:${Date.now()}:${Math.random().toString(36).slice(2)}`, deviceId, filePath, createdAt, content };
		await this.request(database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(snapshot));
		await this.cleanup(database, deviceId, Math.max(1, retentionDays));
		database.close();
	}

	async list(deviceId: string, filePath?: string): Promise<LocalJournalSnapshot[]> {
		if (typeof indexedDB === 'undefined') return [];
		const database = await this.open();
		const values = await this.request<LocalJournalSnapshot[]>(database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll());
		database.close();
		return values.filter(value => value.deviceId === deviceId && (!filePath || value.filePath === filePath))
			.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	}

	private open(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, 2);
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
				if (!request.result.objectStoreNames.contains('device-signing-identities')) request.result.createObjectStore('device-signing-identities', { keyPath: 'deviceId' });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	private async cleanup(database: IDBDatabase, deviceId: string, retentionDays: number): Promise<void> {
		const transaction = database.transaction(STORE_NAME, 'readwrite');
		const store = transaction.objectStore(STORE_NAME);
		const values = await this.request<LocalJournalSnapshot[]>(store.getAll());
		const cutoff = Date.now() - retentionDays * 86_400_000;
		for (const value of values) if (value.deviceId === deviceId && Date.parse(value.createdAt) < cutoff) store.delete(value.id);
		await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
	}

	private request<T = unknown>(request: IDBRequest<T>): Promise<T> {
		return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
	}
}

export class JournalProtectionTracker {
	private protected = new Set<string>();
	has(filePath: string): boolean { return this.protected.has(filePath); }
	mark(filePath: string): void { this.protected.add(filePath); }
}
