import { normalizePath, type App, type DataAdapter } from 'obsidian';
import { deduplicateByEventId, parseJsonLines, toJsonLines } from './jsonl';
import { findPotentialConflicts, matchLineEvents } from './line-identity';
import { buildFileLineage } from './file-lifecycle';
import { HybridClock, compareHistoryEvents } from './hybrid-clock';
import type {
	DeviceInfo,
	EventMatch,
	EventVerificationStatus,
	FileLifecycleEvent,
	GitBlameCacheFile,
	GitBlameCacheLineV2,
	GitBlameRecord,
	HistoryEvent,
	LineEditEvent,
	LineLastModifiedSettings,
	LineQuery,
	MetadataDiagnostics,
	ReviewEvent,
	ResolutionEvent,
} from './types';
import { buildLineHashes, keyedHashLine, keyedHashNormalizedLine, normalizeVaultPath, safeId } from './utils';

interface FileState {
	mtime: number;
	size: number;
}

interface EventIndexCache {
	version: 1;
	generatedAt: string;
	fileStates: Record<string, FileState>;
	eventsByFile: Record<string, HistoryEvent[]>;
	parseErrorsByFile: Record<string, number>;
}

interface NoteEventIndex {
	events: LineEditEvent[];
	byDevice: Map<string, LineEditEvent[]>;
	byLine: Map<number, LineEditEvent[]>;
	byContentHash: Map<string, LineEditEvent[]>;
	byNormalizedHash: Map<string, LineEditEvent[]>;
}

interface CompactionManifest {
	version: 2;
	generation: string;
	snapshotPath: string;
	createdAt: string;
	eventCount: number;
	supersededFiles: string[];
}

const COMPACTION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface LineHistoryMatches {
	memory: EventMatch | null;
	local: EventMatch | null;
	sync: EventMatch | null;
}

export interface MetadataServiceOptions {
	app: App;
	settings: () => LineLastModifiedSettings;
	device: () => DeviceInfo;
	nextSequence: () => number;
	onStateChanged: () => void;
	signEvent?: (event: HistoryEvent) => Promise<HistoryEvent>;
	verifyEvent?: (event: HistoryEvent, device: DeviceInfo | undefined) => Promise<EventVerificationStatus>;
}

function isLineEditEvent(value: unknown): value is LineEditEvent {
	if (!value || typeof value !== 'object') return false;
	const event = value as Partial<LineEditEvent>;
	return typeof event.eventId === 'string' && typeof event.deviceId === 'string' &&
		typeof event.filePath === 'string' && Number.isInteger(event.lineNumber) &&
		typeof event.editedAt === 'string' && event.source === 'local-edit' && (!event.eventType || event.eventType === 'edit');
}

function isHistoryEvent(value: unknown): value is HistoryEvent {
	if (isLineEditEvent(value)) return true;
	if (!value || typeof value !== 'object') return false;
	const event = value as Partial<HistoryEvent>;
	return event.schemaVersion === 2 && typeof event.eventId === 'string' && typeof event.deviceId === 'string' &&
		typeof event.filePath === 'string' && typeof event.fileIncarnationId === 'string' &&
		(event.eventType === 'rename' || event.eventType === 'delete' || event.eventType === 'review' || event.eventType === 'resolution');
}

function isBlameCache(value: unknown): value is GitBlameCacheFile {
	if (!value || typeof value !== 'object') return false;
	const cache = value as Partial<GitBlameCacheFile>;
	return (cache.version === 1 || cache.version === 2) && typeof cache.filePath === 'string' &&
		typeof cache.generatedAt === 'string' && !!cache.lines && typeof cache.lines === 'object';
}

export class SyncMetadataService {
	private readonly missingContentHashKey = safeId('missing-content-hash-key');
	private readonly adapter: DataAdapter;
	private pendingByLine = new Map<string, LineEditEvent>();
	private pendingLifecycle: HistoryEvent[] = [];
	private persistedEvents = new Map<string, HistoryEvent>();
	private eventsByNote = new Map<string, NoteEventIndex>();
	private eventsByIncarnation = new Map<string, LineEditEvent[]>();
	private resolutionsByIncarnation = new Map<string, ResolutionEvent[]>();
	private resolutionsByPath = new Map<string, ResolutionEvent[]>();
	private eventsByLogFile = new Map<string, HistoryEvent[]>();
	private activeIncarnationByPath = new Map<string, string>();
	private pathsByIncarnation = new Map<string, Set<string>>();
	private renameConflictIncarnations = new Set<string>();
	private pathsWithDeletion = new Set<string>();
	private fileStates: Record<string, FileState> = {};
	private parseErrorsByFile: Record<string, number> = {};
	private blameCaches = new Map<string, GitBlameCacheFile>();
	private flushTimer: number | undefined;
	private reloadPromise: Promise<void> | null = null;
	private reloadRequested = false;
	private flushPromise: Promise<void> | null = null;
	private flushRequested = false;
	private diagnostics: MetadataDiagnostics;
	private readonly clock: HybridClock;
	private knownDevices = new Map<string, DeviceInfo>();
	private verificationByEventId = new Map<string, EventVerificationStatus>();

	constructor(private readonly options: MetadataServiceOptions) {
		this.adapter = options.app.vault.adapter;
		this.clock = new HybridClock(options.device().deviceId);
		this.diagnostics = { rootPath: this.root, loadedEvents: 0, pendingEvents: 0, parseErrors: 0 };
	}

	get root(): string {
		return normalizeVaultPath(this.options.settings().syncMetadataDir || 'line-last-modified');
	}

	async initialize(): Promise<void> {
		this.diagnostics.rootPath = this.root;
		if (!this.options.settings().enableSyncMetadata) {
			this.persistedEvents.clear();
			this.eventsByNote.clear();
			this.eventsByLogFile.clear();
			this.eventsByIncarnation.clear();
			this.resolutionsByIncarnation.clear();
			this.resolutionsByPath.clear();
			this.activeIncarnationByPath.clear();
			this.blameCaches.clear();
			this.updateDiagnostics();
			this.options.onStateChanged();
			return;
		}
		await this.ensureFolder(this.root);
		await this.ensureFolder(`${this.root}/events/${this.options.device().deviceId}`);
		await this.ensureFolder(`${this.root}/devices`);
		await this.ensureFolder(`${this.root}/blame-cache/${this.options.device().deviceId}`);
		await this.ensureFolder(`${this.root}/cache/${this.options.device().deviceId}`);
		await this.writeDeviceInfo();
		await this.loadDevices();
		await this.reloadExternalData();
	}

	async reloadExternalData(): Promise<void> {
		if (!this.options.settings().enableSyncMetadata) return;
		this.reloadRequested = true;
		if (this.reloadPromise) return this.reloadPromise;
		this.reloadPromise = this.runReloadLoop().finally(() => { this.reloadPromise = null; });
		return this.reloadPromise;
	}

	private async runReloadLoop(): Promise<void> {
		let immediatePasses = 0;
		while (this.reloadRequested) {
			this.reloadRequested = false;
			await this.reloadInternal();
			immediatePasses += 1;
			if (this.reloadRequested && immediatePasses >= 3) {
				await new Promise<void>(resolve => window.setTimeout(resolve, 50));
				immediatePasses = 0;
			}
		}
	}

	private async reloadInternal(): Promise<void> {
		try {
			await this.loadDevices();
			await this.loadEvents();
			await this.loadBlameCaches();
			this.diagnostics.lastScanAt = new Date().toISOString();
			this.diagnostics.lastError = undefined;
			this.updateDiagnostics();
			this.options.onStateChanged();
		} catch (error) {
			this.diagnostics.lastError = error instanceof Error ? error.message : String(error);
			console.error('Line Last Modified: metadata reload failed', error);
		}
	}

	recordEdit(query: LineQuery): LineEditEvent | null {
		const settings = this.options.settings();
		if (!settings.enableLocalEditTracking) return null;
		const canStoreHashes = settings.storeContentHash && (settings.contentHashMode === 'sha256' || !!settings.contentHashKey);
		const hashKey = this.contentHashKey(settings);
		const hashes = buildLineHashes({ ...query, hashKey });
		const device = this.options.device();
		const sequence = this.options.nextSequence();
		const incarnation = this.ensureIncarnation(query.filePath);
		const event: LineEditEvent = {
			schemaVersion: 2,
			eventType: 'edit',
			eventId: `${device.deviceId}-${sequence}-${safeId('event').slice(-8)}`,
			deviceId: device.deviceId,
			deviceName: settings.privacyMode === 'full' ? device.deviceName : undefined,
			filePath: query.filePath,
			lineNumber: query.lineNumber,
			contentHash: canStoreHashes ? hashes.contentHash : undefined,
			normalizedContentHash: canStoreHashes ? hashes.normalizedContentHash : undefined,
			beforeContextHash: canStoreHashes ? hashes.beforeContextHash : undefined,
			afterContextHash: canStoreHashes ? hashes.afterContextHash : undefined,
			preview: settings.storeLinePreview && settings.privacyMode === 'full' ? query.lineText.slice(0, 120) : undefined,
			editedAt: new Date().toISOString(),
			localSequence: sequence,
			source: 'local-edit',
			status: 'uncommitted',
			fileIncarnationId: incarnation,
			hlc: this.clock.next(),
			operation: query.operation ?? 'edit',
			previousContentHash: query.previousLineText !== undefined && canStoreHashes ? buildLineHashes({ ...query, lineText: query.previousLineText, hashKey }).contentHash : undefined,
			moveTransactionId: query.moveTransactionId,
		};
		this.pendingByLine.set(`${query.filePath}\u0000${query.lineNumber}`, event);
		if (this.flushPromise) this.flushRequested = true;
		this.updateDiagnostics();
		this.scheduleFlush();
		this.options.onStateChanged();
		return event;
	}

	recordRename(previousPath: string, filePath: string): FileLifecycleEvent | null {
		if (!this.options.settings().enableLocalEditTracking || previousPath === filePath) return null;
		const incarnation = this.activeIncarnationByPath.get(previousPath) ?? this.ensureIncarnation(previousPath);
		this.activeIncarnationByPath.delete(previousPath);
		this.activeIncarnationByPath.set(filePath, incarnation);
		const aliases = this.pathsByIncarnation.get(incarnation) ?? new Set<string>();
		aliases.add(previousPath);
		aliases.add(filePath);
		this.pathsByIncarnation.set(incarnation, aliases);
		const event = this.lifecycleEvent('rename', filePath, incarnation, previousPath);
		this.queueLifecycle(event);
		return event;
	}

	recordDelete(filePath: string): FileLifecycleEvent | null {
		if (!this.options.settings().enableLocalEditTracking) return null;
		const incarnation = this.activeIncarnationByPath.get(filePath) ?? this.ensureIncarnation(filePath);
		this.activeIncarnationByPath.delete(filePath);
		this.pathsWithDeletion.add(filePath);
		const event = this.lifecycleEvent('delete', filePath, incarnation);
		this.queueLifecycle(event);
		return event;
	}

	recordReview(filePath: string): ReviewEvent {
		const device = this.options.device();
		const sequence = this.options.nextSequence();
		const reviewedAt = new Date().toISOString();
		const event: ReviewEvent = {
			schemaVersion: 2, eventType: 'review', eventId: `${device.deviceId}-${sequence}-${safeId('review').slice(-8)}`,
			deviceId: device.deviceId, deviceName: this.options.settings().privacyMode === 'full' ? device.deviceName : undefined,
			filePath, fileIncarnationId: this.ensureIncarnation(filePath), reviewedAt, localSequence: sequence, hlc: this.clock.next(),
		};
		this.queueLifecycle(event);
		return event;
	}

	recordResolution(filePath: string, resolvedEventIds: string[], strategy: ResolutionEvent['strategy'], chosenEventId?: string): ResolutionEvent {
		const device = this.options.device();
		const localSequence = this.options.nextSequence();
		const event: ResolutionEvent = {
			schemaVersion: 2, eventType: 'resolution', eventId: `${device.deviceId}-${localSequence}-${safeId('resolution').slice(-8)}`,
			deviceId: device.deviceId, deviceName: this.options.settings().privacyMode === 'full' ? device.deviceName : undefined,
			filePath, fileIncarnationId: this.ensureIncarnation(filePath), resolvedEventIds: [...new Set(resolvedEventIds)],
			strategy, chosenEventId, resolvedAt: new Date().toISOString(), localSequence, hlc: this.clock.next(),
		};
		this.queueLifecycle(event);
		return event;
	}

	getResolutionsForFile(filePath: string): ResolutionEvent[] {
		const incarnation = this.activeIncarnationByPath.get(filePath);
		const persisted = incarnation ? this.resolutionsByIncarnation.get(incarnation) ?? [] : this.resolutionsByPath.get(filePath) ?? [];
		return [...persisted, ...this.pendingLifecycle.filter((event): event is ResolutionEvent => event.eventType === 'resolution' &&
			(incarnation ? event.fileIncarnationId === incarnation : event.filePath === filePath))]
			.sort((a, b) => compareHistoryEvents(a, b));
	}

	findLineHistory(query: LineQuery): LineHistoryMatches {
		query = { ...query, hashKey: this.contentHashKey(this.options.settings()) };
		const deviceId = this.options.device().deviceId;
		const pending = this.pendingEditsForPath(query.filePath).map(event => event.filePath === query.filePath ? event : { ...event, filePath: query.filePath });
		const persisted = this.editEventsForPath(query.filePath).map(event => event.filePath === query.filePath ? event : { ...event, filePath: query.filePath });
		const allEvents = [...pending, ...persisted];
		const addCrossDeviceConflicts = (match: EventMatch | null): EventMatch | null => {
			if (!match) return null;
			const conflicts = findPotentialConflicts(match.event, allEvents, query);
			const candidateIds = [match.event.eventId, ...conflicts.map(event => event.eventId)];
			const resolution = [...this.getResolutionsForFile(query.filePath)].reverse().find(value => candidateIds.length > 1 && candidateIds.every(id => value.resolvedEventIds.includes(id)));
			const chosen = resolution?.strategy === 'choose' ? allEvents.find(event => event.eventId === resolution.chosenEventId) : undefined;
			return {
				...match,
				event: chosen ?? match.event,
				verificationStatus: this.getEventVerification((chosen ?? match.event).eventId),
				potentialConflict: !resolution && (match.potentialConflict || conflicts.length > 0 ||
					(!!match.event.fileIncarnationId && this.renameConflictIncarnations.has(match.event.fileIncarnationId))),
				nearbyEvents: [...conflicts, ...match.nearbyEvents.filter(event => !conflicts.some(conflict => conflict.eventId === event.eventId))],
			};
		};
		return {
			memory: addCrossDeviceConflicts(matchLineEvents(pending, query)),
			local: addCrossDeviceConflicts(matchLineEvents(persisted.filter(event => event.deviceId === deviceId), query)),
			sync: addCrossDeviceConflicts(matchLineEvents(persisted.filter(event => event.deviceId !== deviceId), query)),
		};
	}

	getCachedBlame(filePath: string, lineNumber: number, query?: LineQuery): { record: GitBlameRecord; cache: GitBlameCacheFile } | null {
		const settings = this.options.settings();
		if (settings.contentHashMode === 'hmac-sha256' && !settings.contentHashKey) return null;
		const cache = this.blameCaches.get(filePath);
		let value = cache?.lines[String(lineNumber)];
		if (cache?.version === 2 && query) {
			const hashes = buildLineHashes({ ...query, hashKey: this.contentHashKey(settings) });
			const candidates = Object.entries(cache.lines).filter(([, entry]) => 'record' in entry).map(([storedLine, entry]) => ({ line: Number(storedLine), entry: entry as GitBlameCacheLineV2 }));
			const exact = candidates.find(candidate => candidate.entry.contentHash === hashes.contentHash && Math.abs(candidate.line - lineNumber) <= 20);
			const normalized = candidates.find(candidate => candidate.entry.normalizedContentHash === hashes.normalizedContentHash &&
				Math.abs(candidate.line - lineNumber) <= 20 &&
				(candidate.entry.beforeContextHash === hashes.beforeContextHash || candidate.entry.afterContextHash === hashes.afterContextHash));
			value = exact?.entry ?? normalized?.entry;
		}
		const record = value && 'record' in value ? value.record : value;
		return cache && record ? { record, cache } : null;
	}

	async writeBlameCache(filePath: string, headCommit: string, records: Map<number, GitBlameRecord>): Promise<void> {
		if (!this.options.settings().enableSyncMetadata || !records.size) return;
		const device = this.options.device();
		const settings = this.options.settings();
		if (settings.contentHashMode === 'hmac-sha256' && !settings.contentHashKey) return;
		const hashKey = this.contentHashKey(settings);
		const storedRecords = new Map([...records].map(([line, record]) => {
			const { rawContent: _rawContent, ...clean } = record;
			return [line, settings.privacyMode === 'full' ? clean : { ...clean, authorName: 'Hidden', authorEmail: undefined, summary: undefined }];
		}));
		const cache: GitBlameCacheFile = {
			version: 2,
			filePath,
			fileIncarnationId: this.ensureIncarnation(filePath),
			generatedAt: new Date().toISOString(),
			generatedByDeviceId: device.deviceId,
			generatedByDeviceName: settings.privacyMode === 'full' ? device.deviceName : undefined,
			headCommit,
			lines: Object.fromEntries([...storedRecords].map(([line, record]) => [String(line), {
				record,
				contentHash: records.get(line)?.rawContent !== undefined ? keyedHashLine(records.get(line)?.rawContent ?? '', hashKey) : record.contentHash ?? buildLineHashes({ filePath, lineNumber: line, lineText: `${record.commitHash}:${record.lineNumber}`, hashKey }).contentHash,
				normalizedContentHash: records.get(line)?.rawContent !== undefined ? keyedHashNormalizedLine(records.get(line)?.rawContent ?? '', hashKey) : record.normalizedContentHash ?? buildLineHashes({ filePath, lineNumber: line, lineText: `${record.commitHash}:${record.lineNumber}`, hashKey }).normalizedContentHash,
				beforeContextHash: records.get(line - 1)?.rawContent !== undefined ? keyedHashNormalizedLine(records.get(line - 1)?.rawContent ?? '', hashKey) : record.beforeContextHash,
				afterContextHash: records.get(line + 1)?.rawContent !== undefined ? keyedHashNormalizedLine(records.get(line + 1)?.rawContent ?? '', hashKey) : record.afterContextHash,
			} satisfies GitBlameCacheLineV2])),
		};
		const fileName = `${buildLineHashes({ filePath, lineNumber: 1, lineText: filePath }).contentHash}.json`;
		const path = normalizePath(`${this.root}/blame-cache/${device.deviceId}/${fileName}`);
		await this.adapter.write(path, JSON.stringify(cache));
		this.blameCaches.set(filePath, cache);
	}

	private contentHashKey(settings: LineLastModifiedSettings): string | undefined {
		if (settings.contentHashMode === 'sha256') return undefined;
		return settings.contentHashKey || this.missingContentHashKey;
	}

	async flush(): Promise<void> {
		if (this.flushTimer !== undefined) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (!this.options.settings().enableSyncMetadata) return;
		if (this.flushPromise) {
			this.flushRequested = true;
			return this.flushPromise;
		}
		this.flushPromise = this.runFlushLoop().finally(() => { this.flushPromise = null; });
		return this.flushPromise;
	}

	private async runFlushLoop(): Promise<void> {
		do {
			this.flushRequested = false;
			await this.flushOnce();
		} while (this.flushRequested);
	}

	private async flushOnce(): Promise<void> {
		if (!this.pendingByLine.size && !this.pendingLifecycle.length) return;
		const snapshot = this.pendingByLine;
		this.pendingByLine = new Map();
		const lifecycleSnapshot = this.pendingLifecycle;
		this.pendingLifecycle = [];
			const unsignedEvents: HistoryEvent[] = [...snapshot.values(), ...lifecycleSnapshot];
			const events = this.options.signEvent ? await Promise.all(unsignedEvents.map(event => this.options.signEvent?.(event) ?? event)) : unsignedEvents;
		const groups = new Map<string, HistoryEvent[]>();
		let hadFailure = false;
		for (const event of events) {
			const path = await this.logPathFor(this.eventTimestamp(event));
			const values = groups.get(path) ?? [];
			values.push(event);
			groups.set(path, values);
		}

		for (const [path, group] of groups) {
			try {
				await this.adapter.append(path, toJsonLines(group));
				const existing = this.eventsByLogFile.get(path) ?? [];
				existing.push(...group);
				this.eventsByLogFile.set(path, deduplicateByEventId(existing));
				for (const event of group) {
					this.persistedEvents.set(event.eventId, event);
					this.verificationByEventId.set(event.eventId, event.signature ? 'verified-trusted' : 'unsigned');
					if (isLineEditEvent(event)) this.addToNoteIndex(event);
					else if (event.eventType === 'resolution') this.addResolutionIndex(event);
				}
				const stat = await this.adapter.stat(path);
				if (stat) this.fileStates[path] = { mtime: stat.mtime, size: stat.size };
				this.parseErrorsByFile[path] = 0;
			} catch (error) {
				hadFailure = true;
				for (const event of group) {
					if (!isLineEditEvent(event)) { this.pendingLifecycle.push(event); continue; }
					const key = `${event.filePath}\u0000${event.lineNumber}`;
					const newer = this.pendingByLine.get(key);
					if (!newer || newer.localSequence < event.localSequence) this.pendingByLine.set(key, event);
				}
				this.diagnostics.lastError = error instanceof Error ? error.message : String(error);
				console.error(`Line Last Modified: failed to append ${path}`, error);
			}
		}
		this.diagnostics.lastFlushAt = new Date().toISOString();
		this.updateDiagnostics();
		await this.writeIndex();
		this.options.onStateChanged();
		if (hadFailure) this.scheduleFlush();
	}

	async compactOwnLogs(): Promise<{ before: number; after: number }> {
		await this.flush();
		const ownPrefix = normalizePath(`${this.root}/events/${this.options.device().deviceId}`);
		const snapshotRoot = normalizePath(`${this.root}/snapshots/${this.options.device().deviceId}`);
		const files = [...await this.listFilesRecursive(ownPrefix), ...await this.listFilesRecursive(snapshotRoot)].filter(path => path.endsWith('.jsonl'));
		const all = deduplicateByEventId(files.flatMap(path => this.eventsByLogFile.get(path) ?? []));
		const latest = new Map<string, LineEditEvent>();
		for (const event of all) {
			if (!isLineEditEvent(event)) continue;
			const key = `${event.filePath}\u0000${event.lineNumber}\u0000${event.contentHash ?? ''}`;
			const previous = latest.get(key);
			if (!previous || Date.parse(event.editedAt) > Date.parse(previous.editedAt)) latest.set(key, event);
		}
		const lifecycle = all.filter(event => !isLineEditEvent(event));
		const compacted: HistoryEvent[] = [...lifecycle, ...latest.values()].sort(compareHistoryEvents);
		const generation = `${Date.now()}-${safeId('generation').slice(-8)}`;
		await this.ensureFolder(snapshotRoot);
		const output = normalizePath(`${snapshotRoot}/${generation}.jsonl`);
		await this.adapter.write(output, toJsonLines(compacted));
		const verified = parseJsonLines(await this.adapter.read(output), isHistoryEvent);
		const expectedIds = new Set(compacted.map(event => event.eventId));
		if (verified.errors || verified.values.length !== expectedIds.size || verified.values.some(event => !expectedIds.has(event.eventId))) {
			throw new Error('Compaction snapshot verification failed; original logs were preserved.');
		}
		const manifestRoot = normalizePath(`${this.root}/manifests`);
		await this.ensureFolder(manifestRoot);
		const manifestPath = normalizePath(`${manifestRoot}/${this.options.device().deviceId}.json`);
		let previousManifest: CompactionManifest | null = null;
		if (await this.adapter.exists(manifestPath)) {
			try { previousManifest = JSON.parse(await this.adapter.read(manifestPath)) as CompactionManifest; } catch { /* An invalid old manifest never authorizes deletion. */ }
		}
		await this.adapter.write(manifestPath, JSON.stringify({
			version: 2, generation, snapshotPath: output, createdAt: new Date().toISOString(), eventCount: compacted.length,
			supersededFiles: files,
		}));
		if (previousManifest && Date.now() - Date.parse(previousManifest.createdAt) >= COMPACTION_RETENTION_MS &&
			await this.verifyCompactionManifest(previousManifest)) {
			for (const file of previousManifest.supersededFiles) {
				const owned = file.startsWith(`${ownPrefix}/`) || file.startsWith(`${snapshotRoot}/`);
				if (owned && file !== output && await this.adapter.exists(file)) await this.adapter.remove(file);
			}
		}
		await this.loadEvents();
		return { before: all.length, after: compacted.length };
	}

	async auditOwnMetadataPrivacy(): Promise<{ files: number; events: number; deviceNames: number; previews: number; identityFields: number }> {
		await this.flush();
		const deviceId = this.options.device().deviceId;
		const eventFiles = [...await this.listFilesRecursive(normalizePath(`${this.root}/events/${deviceId}`)),
			...await this.listFilesRecursive(normalizePath(`${this.root}/snapshots/${deviceId}`))].filter(path => path.endsWith('.jsonl'));
		const events = deduplicateByEventId(eventFiles.flatMap(path => this.eventsByLogFile.get(path) ?? []));
		const blameFiles = (await this.listFilesRecursive(normalizePath(`${this.root}/blame-cache/${deviceId}`))).filter(path => path.endsWith('.json'));
		let identityFields = 0;
		for (const path of blameFiles) {
			try {
				const cache = JSON.parse(await this.adapter.read(path)) as GitBlameCacheFile;
				if (cache.generatedByDeviceName) identityFields += 1;
				for (const value of Object.values(cache.lines)) {
					const record = 'record' in value ? value.record : value;
					if (record.authorName && record.authorName !== 'Hidden') identityFields += 1;
					if (record.authorEmail) identityFields += 1;
					if (record.summary) identityFields += 1;
				}
			} catch { /* Malformed optional caches are reported by normal diagnostics and never block the audit. */ }
		}
		const deviceFile = normalizePath(`${this.root}/devices/${deviceId}.json`);
		if (await this.adapter.exists(deviceFile)) {
			try { if ((JSON.parse(await this.adapter.read(deviceFile)) as DeviceInfo).deviceName) identityFields += 1; } catch { /* ignore malformed optional device info */ }
		}
		return {
			files: eventFiles.length + blameFiles.length + (await this.adapter.exists(deviceFile) ? 1 : 0), events: events.length,
			deviceNames: events.filter(event => !!event.deviceName).length,
			previews: events.filter(event => isLineEditEvent(event) && !!event.preview).length,
			identityFields,
		};
	}

	async rewriteOwnMetadataPrivacy(): Promise<{ files: number; events: number }> {
		await this.flush();
		const deviceId = this.options.device().deviceId;
		const files = [...await this.listFilesRecursive(normalizePath(`${this.root}/events/${deviceId}`)),
			...await this.listFilesRecursive(normalizePath(`${this.root}/snapshots/${deviceId}`))].filter(path => path.endsWith('.jsonl'));
		let count = 0;
		for (const path of files) {
			const events = this.eventsByLogFile.get(path) ?? [];
			const rewritten = await Promise.all(events.map(async event => {
				const safe = { ...event, deviceName: undefined, signature: undefined } as HistoryEvent;
				if (isLineEditEvent(safe)) safe.preview = undefined;
				return this.options.signEvent ? this.options.signEvent(safe) : safe;
			}));
			await this.adapter.write(path, toJsonLines(rewritten));
			count += rewritten.length;
		}
		const blameFiles = (await this.listFilesRecursive(normalizePath(`${this.root}/blame-cache/${deviceId}`))).filter(path => path.endsWith('.json'));
		for (const path of blameFiles) {
			try {
				const cache = JSON.parse(await this.adapter.read(path)) as GitBlameCacheFile;
				cache.generatedByDeviceName = undefined;
				for (const value of Object.values(cache.lines)) {
					const record = 'record' in value ? value.record : value;
					record.authorName = 'Hidden'; record.authorEmail = undefined; record.summary = undefined;
				}
				await this.adapter.write(path, JSON.stringify(cache));
			} catch { /* Preserve malformed optional caches instead of risking destructive rewrites. */ }
		}
		const deviceFile = normalizePath(`${this.root}/devices/${deviceId}.json`);
		if (await this.adapter.exists(deviceFile)) {
			try {
				const info = JSON.parse(await this.adapter.read(deviceFile)) as DeviceInfo;
				info.deviceName = undefined;
				await this.adapter.write(deviceFile, JSON.stringify(info));
			} catch { /* Preserve malformed optional device info. */ }
		}
		await this.loadEvents();
		await this.loadBlameCaches();
		return { files: files.length + blameFiles.length + (await this.adapter.exists(deviceFile) ? 1 : 0), events: count };
	}

	getDiagnostics(): MetadataDiagnostics {
		return { ...this.diagnostics };
	}

	getKnownDevices(): DeviceInfo[] { return [...this.knownDevices.values()].map(device => ({ ...device, signingKeys: device.signingKeys?.map(key => ({ ...key })) })); }
	getEventVerification(eventId: string): EventVerificationStatus { return this.verificationByEventId.get(eventId) ?? 'unsigned'; }

	getLatestEventForFile(filePath: string): LineEditEvent | null {
		const events = [...this.editEventsForPath(filePath), ...this.pendingEditsForPath(filePath)];
		let latest: LineEditEvent | null = null;
		for (const event of events) if (!latest || compareHistoryEvents(event, latest) > 0) latest = event;
		return latest;
	}

	getEventsForFile(filePath: string): LineEditEvent[] {
		const pending = this.pendingEditsForPath(filePath);
		const persisted = this.editEventsForPath(filePath);
		return deduplicateByEventId([...persisted, ...pending]).sort((a, b) => Date.parse(a.editedAt) - Date.parse(b.editedAt));
	}

	getLatestReviewForFile(filePath: string): ReviewEvent | null {
		const incarnation = this.activeIncarnationByPath.get(filePath);
		const aliases = incarnation ? this.pathsByIncarnation.get(incarnation) ?? new Set([filePath]) : new Set([filePath]);
		let latest: ReviewEvent | null = null;
		for (const event of this.persistedEvents.values()) {
			if (event.eventType !== 'review') continue;
			if (incarnation ? event.fileIncarnationId !== incarnation : !aliases.has(event.filePath)) continue;
			if (!latest || compareHistoryEvents(event, latest) > 0) latest = event;
		}
		for (const event of this.pendingLifecycle) {
			if (event.eventType !== 'review') continue;
			if (incarnation ? event.fileIncarnationId !== incarnation : event.filePath !== filePath) continue;
			if (!latest || compareHistoryEvents(event, latest) > 0) latest = event;
		}
		return latest;
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer);
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, this.options.settings().editFlushDebounceMs);
	}

	private async logPathFor(editedAt: string): Promise<string> {
		const date = new Date(editedAt);
		const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
		const base = normalizePath(`${this.root}/events/${this.options.device().deviceId}/${month}`);
		const maxBytes = Math.max(0.1, this.options.settings().maxEventLogSizeMB) * 1024 * 1024;
		for (let part = 0; part < 1000; part++) {
			const path = `${base}${part ? `-${part}` : ''}.jsonl`;
			const stat = await this.adapter.stat(path);
			if (!stat || stat.size < maxBytes) return path;
		}
		return `${base}-${Date.now()}.jsonl`;
	}

	private async loadEvents(): Promise<void> {
		const eventsRoot = normalizePath(`${this.root}/events`);
		await this.ensureFolder(eventsRoot);
		const snapshotsRoot = normalizePath(`${this.root}/snapshots`);
		await this.ensureFolder(snapshotsRoot);
		const files = [...await this.listFilesRecursive(eventsRoot), ...await this.listFilesRecursive(snapshotsRoot)].filter(path => path.endsWith('.jsonl'));
		const cached = await this.readIndex();
		const nextEventsByFile = new Map<string, HistoryEvent[]>();
		const nextStates: Record<string, FileState> = {};
		const nextErrors: Record<string, number> = {};
		let changed = !cached;
		for (const path of files) {
			const stat = await this.adapter.stat(path);
			if (!stat) continue;
			const state = { mtime: stat.mtime, size: stat.size };
			nextStates[path] = state;
			const oldState = cached?.fileStates[path];
			if (oldState && oldState.mtime === state.mtime && oldState.size === state.size) {
				nextEventsByFile.set(path, cached?.eventsByFile[path] ?? []);
				nextErrors[path] = cached?.parseErrorsByFile[path] ?? 0;
			} else {
				changed = true;
				const parsed = parseJsonLines(await this.adapter.read(path), isHistoryEvent);
				nextEventsByFile.set(path, parsed.values);
				nextErrors[path] = parsed.errors;
			}
		}
		if (cached && Object.keys(cached.fileStates).some(path => !nextStates[path])) changed = true;
		this.eventsByLogFile = nextEventsByFile;
		this.fileStates = nextStates;
		this.parseErrorsByFile = nextErrors;
		this.persistedEvents.clear();
		this.eventsByNote.clear();
		this.eventsByIncarnation.clear();
		this.resolutionsByIncarnation.clear();
		this.resolutionsByPath.clear();
		const allEvents = deduplicateByEventId([...nextEventsByFile.values()].flat());
		this.verificationByEventId.clear();
		if (this.options.verifyEvent) {
			for (let index = 0; index < allEvents.length; index += 100) {
				const batch = allEvents.slice(index, index + 100);
				const values = await Promise.all(batch.map(event => this.options.verifyEvent?.(event, this.knownDevices.get(event.deviceId)) ?? 'unsigned'));
				batch.forEach((event, offset) => this.verificationByEventId.set(event.eventId, values[offset]));
				if (index + 100 < allEvents.length) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
			}
		}
		const lineage = buildFileLineage(allEvents);
		this.activeIncarnationByPath = lineage.activeByPath;
		this.pathsByIncarnation = lineage.pathsByIncarnation;
		this.renameConflictIncarnations = new Set(lineage.renameConflicts.keys());
		this.pathsWithDeletion = new Set(allEvents.filter(event => event.eventType === 'delete').map(event => event.filePath));
		for (const event of allEvents) {
			this.persistedEvents.set(event.eventId, event);
			if (isLineEditEvent(event)) this.addToNoteIndex(event);
			else if (event.eventType === 'resolution') this.addResolutionIndex(event);
			if (event.hlc) this.clock.observe(event.hlc);
		}
		this.updateDiagnostics();
		if (changed) await this.writeIndex();
	}

	private async loadBlameCaches(): Promise<void> {
		const root = normalizePath(`${this.root}/blame-cache`);
		await this.ensureFolder(root);
		const files = (await this.listFilesRecursive(root)).filter(path => path.endsWith('.json'));
		const caches = new Map<string, GitBlameCacheFile>();
		for (const path of files) {
			try {
				const value: unknown = JSON.parse(await this.adapter.read(path));
				if (!isBlameCache(value)) continue;
				const currentPath = value.fileIncarnationId
					? [...this.activeIncarnationByPath.entries()].find(([, incarnation]) => incarnation === value.fileIncarnationId)?.[0] ?? value.filePath
					: value.filePath;
				const existing = caches.get(currentPath);
				if (!existing || Date.parse(value.generatedAt) > Date.parse(existing.generatedAt)) caches.set(currentPath, value);
			} catch {
				// A partially synced or malformed cache is optional; event history still works.
			}
		}
		this.blameCaches = caches;
	}

	private async readIndex(): Promise<EventIndexCache | null> {
		const path = normalizePath(`${this.root}/cache/${this.options.device().deviceId}/index.json`);
		if (!await this.adapter.exists(path)) return null;
		try {
			const value = JSON.parse(await this.adapter.read(path)) as EventIndexCache;
			return value.version === 1 && value.fileStates && value.eventsByFile ? value : null;
		} catch {
			return null;
		}
	}

	private async writeIndex(): Promise<void> {
		if (!this.options.settings().enableSyncMetadata) return;
		const cache: EventIndexCache = {
			version: 1,
			generatedAt: new Date().toISOString(),
			fileStates: this.fileStates,
			eventsByFile: Object.fromEntries(this.eventsByLogFile),
			parseErrorsByFile: this.parseErrorsByFile,
		};
		await this.adapter.write(normalizePath(`${this.root}/cache/${this.options.device().deviceId}/index.json`), JSON.stringify(cache));
	}

	private async writeDeviceInfo(): Promise<void> {
		const device = this.options.device();
		const settings = this.options.settings();
		const safe: DeviceInfo = {
			...device,
			deviceName: settings.privacyMode === 'full' ? device.deviceName : undefined,
			lastSeenAt: new Date().toISOString(),
		};
		const path = normalizePath(`${this.root}/devices/${device.deviceId}.json`);
		if (await this.adapter.exists(path)) {
			try {
				const previous = JSON.parse(await this.adapter.read(path)) as DeviceInfo;
				const keys = new Map([...(previous.signingKeys ?? []), ...(safe.signingKeys ?? [])].map(key => [key.keyId, key]));
				safe.signingKeys = [...keys.values()];
			} catch { /* Replace malformed own device info with the safe current record. */ }
		}
		await this.adapter.write(path, JSON.stringify(safe));
	}

	private async loadDevices(): Promise<void> {
		const root = normalizePath(`${this.root}/devices`);
		await this.ensureFolder(root);
		const devices = new Map<string, DeviceInfo>();
		for (const path of (await this.listFilesRecursive(root)).filter(value => value.endsWith('.json'))) {
			try {
				const value = JSON.parse(await this.adapter.read(path)) as DeviceInfo;
				if (value && typeof value.deviceId === 'string' && typeof value.createdAt === 'string') devices.set(value.deviceId, value);
			} catch { /* A malformed synced device card does not block event history. */ }
		}
		this.knownDevices = devices;
	}

	private addToNoteIndex(event: LineEditEvent): void {
		let index = this.eventsByNote.get(event.filePath);
		if (!index) {
			index = {
				events: [], byDevice: new Map(), byLine: new Map(),
				byContentHash: new Map(), byNormalizedHash: new Map(),
			};
			this.eventsByNote.set(event.filePath, index);
		}
		if (index.events.some(existing => existing.eventId === event.eventId)) return;
		index.events.push(event);
		this.pushIndexValue(index.byDevice, event.deviceId, event);
		this.pushIndexValue(index.byLine, event.lineNumber, event);
		if (event.contentHash) this.pushIndexValue(index.byContentHash, event.contentHash, event);
		if (event.normalizedContentHash) this.pushIndexValue(index.byNormalizedHash, event.normalizedContentHash, event);
		if (event.fileIncarnationId) this.pushIndexValue(this.eventsByIncarnation, event.fileIncarnationId, event);
	}

	private addResolutionIndex(event: ResolutionEvent): void {
		this.pushResolutionValue(this.resolutionsByIncarnation, event.fileIncarnationId, event);
		this.pushResolutionValue(this.resolutionsByPath, event.filePath, event);
	}

	private pushResolutionValue(map: Map<string, ResolutionEvent[]>, key: string, event: ResolutionEvent): void {
		const values = map.get(key) ?? [];
		if (!values.some(value => value.eventId === event.eventId)) values.push(event);
		map.set(key, values);
	}

	private editEventsForPath(filePath: string): LineEditEvent[] {
		const incarnation = this.activeIncarnationByPath.get(filePath);
		if (!incarnation) return this.eventsByNote.get(filePath)?.events.filter(event => !event.fileIncarnationId) ?? [];
		const aliases = this.pathsByIncarnation.get(incarnation) ?? new Set([filePath]);
		const legacy = [...aliases].flatMap(path => this.pathsWithDeletion.has(path) ? [] : this.eventsByNote.get(path)?.events.filter(event => !event.fileIncarnationId) ?? []);
		return deduplicateByEventId([...(this.eventsByIncarnation.get(incarnation) ?? []), ...legacy]);
	}

	private pendingEditsForPath(filePath: string): LineEditEvent[] {
		const incarnation = this.activeIncarnationByPath.get(filePath);
		return [...this.pendingByLine.values()].filter(event => incarnation ? event.fileIncarnationId === incarnation : event.filePath === filePath);
	}

	private ensureIncarnation(filePath: string): string {
		const current = this.activeIncarnationByPath.get(filePath);
		if (current) return current;
		const incarnation = safeId('file');
		this.activeIncarnationByPath.set(filePath, incarnation);
		this.pathsByIncarnation.set(incarnation, new Set([filePath]));
		return incarnation;
	}

	private lifecycleEvent(type: 'rename' | 'delete', filePath: string, fileIncarnationId: string, previousPath?: string): FileLifecycleEvent {
		const device = this.options.device();
		const localSequence = this.options.nextSequence();
		return {
			schemaVersion: 2, eventType: type, eventId: `${device.deviceId}-${localSequence}-${safeId(type).slice(-8)}`,
			deviceId: device.deviceId, deviceName: this.options.settings().privacyMode === 'full' ? device.deviceName : undefined,
			filePath, previousPath, fileIncarnationId, recordedAt: new Date().toISOString(), localSequence, hlc: this.clock.next(),
		};
	}

	private queueLifecycle(event: HistoryEvent): void {
		this.pendingLifecycle.push(event);
		this.scheduleFlush();
		this.updateDiagnostics();
		this.options.onStateChanged();
	}

	private eventTimestamp(event: HistoryEvent): string {
		return 'editedAt' in event ? event.editedAt : 'reviewedAt' in event ? event.reviewedAt :
			'resolvedAt' in event ? event.resolvedAt : event.recordedAt;
	}

	private async verifyCompactionManifest(manifest: CompactionManifest): Promise<boolean> {
		if (manifest.version !== 2 || !manifest.snapshotPath || !await this.adapter.exists(manifest.snapshotPath)) return false;
		try {
			const parsed = parseJsonLines(await this.adapter.read(manifest.snapshotPath), isHistoryEvent);
			return parsed.errors === 0 && new Set(parsed.values.map(event => event.eventId)).size === manifest.eventCount;
		} catch { return false; }
	}

	private pushIndexValue<K>(map: Map<K, LineEditEvent[]>, key: K, event: LineEditEvent): void {
		const values = map.get(key) ?? [];
		values.push(event);
		map.set(key, values);
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = normalizeVaultPath(path).split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!await this.adapter.exists(current)) await this.adapter.mkdir(current);
		}
	}

	private async listFilesRecursive(root: string): Promise<string[]> {
		if (!await this.adapter.exists(root)) return [];
		const result: string[] = [];
		const pending = [root];
		while (pending.length) {
			const folder = pending.pop();
			if (!folder) continue;
			const listed = await this.adapter.list(folder);
			result.push(...listed.files);
			pending.push(...listed.folders);
		}
		return result;
	}

	private updateDiagnostics(): void {
		this.diagnostics.rootPath = this.root;
		this.diagnostics.loadedEvents = this.persistedEvents.size;
		this.diagnostics.pendingEvents = this.pendingByLine.size + this.pendingLifecycle.length;
		this.diagnostics.parseErrors = Object.values(this.parseErrorsByFile).reduce((sum, value) => sum + value, 0);
	}
}
