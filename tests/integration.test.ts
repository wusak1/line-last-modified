import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyDisplayPolicy } from '../src/display-policy';
import { parseGitBlamePorcelain } from '../src/git-parser';
import { GitBlameService } from '../src/git-blame-service';
import { parseJsonLines, toJsonLines } from '../src/jsonl';
import { matchLineEvents } from '../src/line-identity';
import { SyncMetadataService } from '../src/metadata-service';
import type { DeviceInfo, GitBlameRecord, LineEditEvent, LineLastModifiedSettings } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/types';
import { hashLine, hashNormalizedLine } from '../src/utils';
import { DeviceTrustManager } from '../src/device-trust';
import type { EventVerificationStatus, HistoryEvent } from '../src/types';

test('real Git repository porcelain output resolves each committed line', { skip: !hasGit() }, () => {
	const directory = mkdtempSync(join(tmpdir(), 'llm-git-'));
	try {
		execFileSync('git', ['init'], { cwd: directory, stdio: 'ignore' });
		execFileSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: directory });
		execFileSync('git', ['config', 'user.name', 'Line Tests'], { cwd: directory });
		writeFileSync(join(directory, 'note.md'), 'first\nsecond\n', 'utf8');
		execFileSync('git', ['add', 'note.md'], { cwd: directory });
		execFileSync('git', ['commit', '-m', 'initial note'], { cwd: directory, stdio: 'ignore' });
		const output = execFileSync('git', ['blame', '--line-porcelain', '--', 'note.md'], { cwd: directory, encoding: 'utf8' });
		const records = parseGitBlamePorcelain(output, 'note.md');
		assert.equal(records.size, 2);
		assert.equal(records.get(2)?.authorName, 'Line Tests');
		assert.equal(records.get(2)?.summary, 'initial note');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('configured parent Git repository resolves Vault files without syncing absolute paths', { skip: !hasGit() }, async () => {
	const directory = mkdtempSync(join(tmpdir(), 'llm-parent-git-'));
	const vault = join(directory, 'vault');
	mkdirSync(vault);
	try {
		execFileSync('git', ['init'], { cwd: directory, stdio: 'ignore' });
		execFileSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: directory });
		execFileSync('git', ['config', 'user.name', 'Parent Repo'], { cwd: directory });
		writeFileSync(join(vault, 'note.md'), 'tracked from parent repo\n', 'utf8');
		execFileSync('git', ['add', 'vault/note.md'], { cwd: directory });
		execFileSync('git', ['commit', '-m', 'parent repository note'], { cwd: directory, stdio: 'ignore' });
		const settings = { ...DEFAULT_SETTINGS, gitRepositoryPath: directory };
		let syncedFilePath = '';
		const metadata = {
			writeBlameCache: async (filePath: string) => { syncedFilePath = filePath; },
		} as never;
		const service = new GitBlameService(vault, false, () => settings, metadata);
		const result = await service.getLineBlame('note.md', 1, 1);
		assert.equal(result.state, 'ok');
		assert.equal(result.record?.authorName, 'Parent Repo');
		assert.equal(syncedFilePath, 'note.md');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Git availability errors redact machine-specific executable paths', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'llm-private-path-'));
	try {
		const privateExecutable = join(directory, 'PrivateTools', 'missing-git.exe');
		const settings = { ...DEFAULT_SETTINGS, gitExecutablePath: privateExecutable };
		const service = new GitBlameService(directory, false, () => settings, { writeBlameCache: async () => undefined } as never);
		const result = await service.getLineBlame('note.md', 1, 1);
		assert.equal(result.state, 'unavailable');
		assert.doesNotMatch(result.detail ?? '', /PrivateTools|llm-private-path/i);
		assert.match(result.detail ?? '', /<Git executable>/);
		const status = await service.getOnboardingStatus();
		assert.equal(status.repositoryState, 'unavailable');
		assert.doesNotMatch(status.detail, /PrivateTools|llm-private-path/i);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('Git onboarding distinguishes a Vault repository, parent repository, and no repository', { skip: !hasGit() }, async () => {
	const directory = mkdtempSync(join(tmpdir(), 'llm-onboarding-'));
	const vault = join(directory, 'vault');
	mkdirSync(vault);
	try {
		const settings = { ...DEFAULT_SETTINGS };
		const metadata = { writeBlameCache: async () => undefined } as never;
		let service = new GitBlameService(vault, false, () => settings, metadata);
		assert.equal((await service.getOnboardingStatus()).repositoryState, 'none');
		execFileSync('git', ['init'], { cwd: directory, stdio: 'ignore' });
		service = new GitBlameService(vault, false, () => settings, metadata);
		assert.equal((await service.getOnboardingStatus()).repositoryState, 'parent');
		rmSync(join(directory, '.git'), { recursive: true, force: true });
		execFileSync('git', ['init'], { cwd: vault, stdio: 'ignore' });
		service = new GitBlameService(vault, false, () => settings, metadata);
		assert.equal((await service.getOnboardingStatus()).repositoryState, 'vault');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('mobile Git onboarding never attempts native Git', async () => {
	const service = new GitBlameService(null, true, () => ({ ...DEFAULT_SETTINGS }), { writeBlameCache: async () => undefined } as never);
	(service as unknown as { runExecutable: () => never }).runExecutable = () => { throw new Error('child_process must not run'); };
	const status = await service.getOnboardingStatus();
	assert.equal(status.repositoryState, 'mobile');
	assert.equal(status.nativeGitAvailable, false);
});

test('Git init is inert when cancelled and creates no commit, remote, or author config when confirmed', { skip: !hasGit() }, async () => {
	const directory = mkdtempSync(join(tmpdir(), 'llm-init-'));
	try {
		const service = new GitBlameService(directory, false, () => ({ ...DEFAULT_SETTINGS }), { writeBlameCache: async () => undefined } as never);
		assert.equal((await service.assessRepositoryInitialization()).state, 'none');
		assert.equal((await service.initializeRepository(false)).state, 'cancelled');
		assert.equal(existsSync(join(directory, '.git')), false);
		assert.equal((await service.initializeRepository(true)).state, 'initialized');
		assert.equal(existsSync(join(directory, '.git')), true);
		assert.equal(execFileSync('git', ['remote'], { cwd: directory, encoding: 'utf8' }).trim(), '');
		assert.throws(() => execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: directory, stdio: 'ignore' }));
		assert.throws(() => execFileSync('git', ['config', '--local', '--get', 'user.name'], { cwd: directory, stdio: 'ignore' }));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('parent repository blocks nested Git init unless advanced confirmation is supplied', { skip: !hasGit() }, async () => {
	const directory = mkdtempSync(join(tmpdir(), 'llm-parent-init-'));
	const vault = join(directory, 'vault');
	mkdirSync(vault);
	try {
		execFileSync('git', ['init'], { cwd: directory, stdio: 'ignore' });
		const service = new GitBlameService(vault, false, () => ({ ...DEFAULT_SETTINGS }), { writeBlameCache: async () => undefined } as never);
		const assessment = await service.assessRepositoryInitialization();
		assert.equal(assessment.state, 'parent');
		assert.equal(assessment.requiresNestedConfirmation, true);
		assert.equal((await service.initializeRepository(true)).state, 'blocked');
		assert.equal(existsSync(join(vault, '.git')), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('synced event survives insertion and a malformed neighboring JSONL record', () => {
	const synced: LineEditEvent = {
		eventId: 'phone-9', deviceId: 'phone', deviceName: 'Phone', filePath: 'note.md', lineNumber: 2,
		contentHash: hashLine('stable line'), normalizedContentHash: hashNormalizedLine('stable line'),
		beforeContextHash: hashNormalizedLine('before'), afterContextHash: hashNormalizedLine('after'),
		editedAt: '2026-06-18T12:00:00.000Z', localSequence: 9, source: 'local-edit', status: 'uncommitted',
	};
	const parsed = parseJsonLines<LineEditEvent>(`${toJsonLines([synced])}partial {`,
		(value): value is LineEditEvent => !!value && typeof value === 'object' && 'eventId' in value);
	const match = matchLineEvents(parsed.values, {
		filePath: 'note.md', lineNumber: 4, lineText: 'stable line', beforeLine: 'before', afterLine: 'after',
	});
	assert.equal(parsed.errors, 1);
	assert.equal(match?.event.deviceName, 'Phone');
	assert.equal(match?.reason, 'nearby-content');
});

test('mobile without synced history exposes a clear Git status through filesystem fallback', () => {
	const result = applyDisplayPolicy({
		memory: null, local: null, sync: null, git: { state: 'mobile', record: null },
		fileMtime: Date.parse('2026-06-18T11:00:00.000Z'), now: Date.parse('2026-06-18T12:00:00.000Z'),
	}, { ...DEFAULT_SETTINGS });
	assert.equal(result.source, 'filesystem');
	assert.match(result.text, /Git unavailable on mobile/);
});

test('device logs round-trip through the Vault and become synchronized history on another device', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	let firstSequence = 0;
	const firstSettings = { ...DEFAULT_SETTINGS, deviceId: 'laptop', deviceName: 'Laptop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const first = createMetadataService(adapter, firstSettings, () => ++firstSequence);
	await first.initialize();
	first.recordEdit({ filePath: 'notes/project.md', lineNumber: 3, lineText: 'shared line', beforeLine: 'before', afterLine: 'after' });
	const immediate = first.findLineHistory({ filePath: 'notes/project.md', lineNumber: 3, lineText: 'shared line', beforeLine: 'before', afterLine: 'after' });
	assert.equal(immediate.memory?.event.deviceId, 'laptop');
	await first.flush();
	const eventPath = [...adapter.files.keys()].find(path => path.startsWith('line-last-modified/events/laptop/') && path.endsWith('.jsonl'));
	assert.ok(eventPath);
	assert.match(adapter.readSync(eventPath), /"filePath":"notes\/project.md"/);

	await adapter.append(eventPath, '{partial sync record\n');
	let secondSequence = 0;
	const secondSettings = { ...DEFAULT_SETTINGS, deviceId: 'phone', deviceName: 'Phone', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const second = createMetadataService(adapter, secondSettings, () => ++secondSequence);
	await second.initialize();
	const history = second.findLineHistory({ filePath: 'notes/project.md', lineNumber: 3, lineText: 'shared line', beforeLine: 'before', afterLine: 'after' });
	assert.equal(history.sync?.event.deviceName, 'Laptop');
	assert.equal(history.sync?.reason, 'exact');
	assert.equal(second.getDiagnostics().parseErrors, 1);
	assert.equal([...adapter.files.keys()].some(path => path.endsWith('.md')), false);
	assert.equal(adapter.files.has('line-last-modified/index.json'), false);
	assert.equal(adapter.files.has('line-last-modified/devices.json'), false);
	assert.equal(adapter.files.has('line-last-modified/cache/phone/index.json'), true);
});

test('schema v2 rename lineage and review events synchronize without replacing edit time', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	let sequence = 0;
	const desktopSettings = { ...DEFAULT_SETTINGS, deviceId: 'desktop', deviceName: 'Desktop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const desktop = createMetadataService(adapter, desktopSettings, () => ++sequence);
	await desktop.initialize();
	desktop.recordEdit({ filePath: 'a.md', lineNumber: 1, lineText: 'stable' });
	desktop.recordRename('a.md', 'b.md');
	desktop.recordRename('b.md', 'c.md');
	desktop.recordRename('c.md', 'd.md');
	const originalEdit = desktop.getLatestEventForFile('d.md');
	const review = desktop.recordReview('d.md');
	await desktop.flush();
	assert.equal(desktop.getLatestEventForFile('d.md')?.eventId, originalEdit?.eventId);
	assert.equal(desktop.getLatestReviewForFile('d.md')?.eventId, review.eventId);

	const phoneSettings = { ...DEFAULT_SETTINGS, deviceId: 'phone', deviceName: 'Phone', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const phone = createMetadataService(adapter, phoneSettings, () => 1);
	await phone.initialize();
	assert.equal(phone.findLineHistory({ filePath: 'd.md', lineNumber: 1, lineText: 'stable' }).sync?.event.eventId, originalEdit?.eventId);
	assert.equal(phone.getLatestReviewForFile('d.md')?.eventId, review.eventId);

	phone.recordDelete('d.md');
	phone.recordEdit({ filePath: 'd.md', lineNumber: 1, lineText: 'replacement' });
	assert.notEqual(phone.getLatestEventForFile('d.md')?.fileIncarnationId, originalEdit?.fileIncarnationId);
});

test('deleting a v1-only file before its first v2 edit prevents same-path recreation from inheriting legacy history', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	await adapter.mkdir('line-last-modified'); await adapter.mkdir('line-last-modified/events'); await adapter.mkdir('line-last-modified/events/old');
	const legacy: LineEditEvent = {
		eventId: 'legacy-1', deviceId: 'old', filePath: 'legacy.md', lineNumber: 1,
		contentHash: hashLine('old content'), normalizedContentHash: hashNormalizedLine('old content'),
		editedAt: '2025-01-01T00:00:00.000Z', localSequence: 1, source: 'local-edit', status: 'synced',
	};
	await adapter.write('line-last-modified/events/old/2025-01.jsonl', toJsonLines([legacy]));
	let sequence = 0;
	const settings = { ...DEFAULT_SETTINGS, deviceId: 'desktop', deviceName: 'Desktop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const service = createMetadataService(adapter, settings, () => ++sequence);
	await service.initialize();
	assert.equal(service.getLatestEventForFile('legacy.md')?.eventId, 'legacy-1');
	service.recordDelete('legacy.md');
	service.recordEdit({ filePath: 'legacy.md', lineNumber: 1, lineText: 'new content' });
	const events = service.getEventsForFile('legacy.md');
	assert.equal(events.length, 1);
	assert.notEqual(events[0].eventId, 'legacy-1');
});

test('resolution events choose a candidate without deleting either conflicting source event', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	await adapter.mkdir('line-last-modified'); await adapter.mkdir('line-last-modified/events');
	await adapter.mkdir('line-last-modified/events/desktop'); await adapter.mkdir('line-last-modified/events/phone');
	const base = {
		filePath: 'conflict.md', lineNumber: 1, contentHash: hashLine('same'), normalizedContentHash: hashNormalizedLine('same'),
		source: 'local-edit' as const, status: 'synced' as const,
	};
	const desktopEvent: LineEditEvent = { ...base, eventId: 'desktop-conflict', deviceId: 'desktop', editedAt: '2026-06-18T10:00:00.000Z', localSequence: 1 };
	const phoneEvent: LineEditEvent = { ...base, eventId: 'phone-conflict', deviceId: 'phone', editedAt: '2026-06-18T10:00:20.000Z', localSequence: 1 };
	await adapter.write('line-last-modified/events/desktop/2026-06.jsonl', toJsonLines([desktopEvent]));
	await adapter.write('line-last-modified/events/phone/2026-06.jsonl', toJsonLines([phoneEvent]));
	let sequence = 1;
	const settings = { ...DEFAULT_SETTINGS, deviceId: 'desktop', deviceName: 'Desktop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const service = createMetadataService(adapter, settings, () => ++sequence);
	await service.initialize();
	const query = { filePath: 'conflict.md', lineNumber: 1, lineText: 'same' };
	assert.equal(service.findLineHistory(query).sync?.potentialConflict, true);
	service.recordResolution('conflict.md', ['desktop-conflict', 'phone-conflict'], 'choose', 'desktop-conflict');
	await service.flush();
	const resolved = service.findLineHistory(query);
	assert.equal(resolved.sync?.potentialConflict, false);
	assert.equal(resolved.sync?.event.eventId, 'desktop-conflict');
	assert.deepEqual(new Set(service.getEventsForFile('conflict.md').map(value => value.eventId)), new Set(['desktop-conflict', 'phone-conflict']));
	assert.equal(service.getResolutionsForFile('conflict.md').length, 1);
});

test('safe compaction verifies a snapshot, publishes a manifest, and preserves original shards', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	let sequence = 0;
	const settings = { ...DEFAULT_SETTINGS, deviceId: 'desktop', deviceName: 'Desktop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const service = createMetadataService(adapter, settings, () => ++sequence);
	await service.initialize();
	service.recordEdit({ filePath: 'note.md', lineNumber: 1, lineText: 'one' });
	await service.flush();
	const original = [...adapter.files.keys()].find(path => path.startsWith('line-last-modified/events/desktop/') && path.endsWith('.jsonl'));
	assert.ok(original);
	const result = await service.compactOwnLogs();
	assert.equal(result.before, 1);
	assert.equal(adapter.files.has(original), true);
	const snapshot = [...adapter.files.keys()].find(path => path.startsWith('line-last-modified/snapshots/desktop/') && path.endsWith('.jsonl'));
	assert.ok(snapshot);
	const manifest = adapter.readSync('line-last-modified/manifests/desktop.json');
	assert.match(manifest, /"version":2/);
	assert.match(manifest, /"eventCount":1/);

	const record: GitBlameRecord = {
		filePath: 'note.md', lineNumber: 1, commitHash: 'a'.repeat(40), authorName: 'Private Author',
		authorEmail: 'private@example.com', authorTime: '2026-06-18T10:00:00.000Z', summary: 'private summary', source: 'git',
	};
	await service.writeBlameCache('note.md', 'a'.repeat(40), new Map([[1, record]]));
	const audit = await service.auditOwnMetadataPrivacy();
	assert.ok(audit.deviceNames >= 1);
	assert.ok(audit.identityFields >= 3);
	const rewritten = await service.rewriteOwnMetadataPrivacy();
	assert.ok(rewritten.files >= 4);
	assert.doesNotMatch(adapter.readSync(original), /"deviceName"/);
	assert.doesNotMatch(adapter.readSync(snapshot), /"deviceName"/);
	const rewrittenCache = [...adapter.files.entries()].find(([path]) => path.startsWith('line-last-modified/blame-cache/desktop/'))?.[1].data ?? '';
	assert.doesNotMatch(rewrittenCache, /Private Author|private@example.com|private summary|Desktop/);
});

test('a later verified compaction generation retains cumulative eventIds and removes expired original logs', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	let sequence = 0;
	const settings = { ...DEFAULT_SETTINGS, deviceId: 'desktop', deviceName: 'Desktop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const service = createMetadataService(adapter, settings, () => ++sequence);
	await service.initialize();
	service.recordEdit({ filePath: 'note.md', lineNumber: 1, lineText: 'first' });
	await service.flush();
	const original = [...adapter.files.keys()].find(path => path.startsWith('line-last-modified/events/desktop/') && path.endsWith('.jsonl')) as string;
	await service.compactOwnLogs();
	const firstManifest = JSON.parse(adapter.readSync('line-last-modified/manifests/desktop.json')) as { createdAt: string };
	firstManifest.createdAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
	await adapter.write('line-last-modified/manifests/desktop.json', JSON.stringify(firstManifest));
	service.recordEdit({ filePath: 'note.md', lineNumber: 2, lineText: 'second' });
	await service.flush();
	await service.compactOwnLogs();
	assert.equal(adapter.files.has(original), false);
	const snapshots = [...adapter.files.entries()].filter(([path]) => path.startsWith('line-last-modified/snapshots/desktop/') && path.endsWith('.jsonl'));
	const newest = snapshots.sort((a, b) => b[1].mtime - a[1].mtime)[0]?.[1].data ?? '';
	const ids = newest.trim().split('\n').map(line => (JSON.parse(line) as LineEditEvent).eventId);
	assert.equal(new Set(ids).size, 2);
});

test('non-full privacy strips author, email, summary, and device name from synced blame cache', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	const settings = {
		...DEFAULT_SETTINGS,
		privacyMode: 'timestamp-only' as const,
		deviceId: 'private-device',
		deviceName: 'Sensitive Laptop',
		deviceCreatedAt: '2026-06-18T00:00:00.000Z',
	};
	const service = createMetadataService(adapter, settings, () => 1);
	await service.initialize();
	const record: GitBlameRecord = {
		filePath: 'secret.md', lineNumber: 1, commitHash: 'a'.repeat(40), authorName: 'Secret Author',
		authorEmail: 'secret@example.com', authorTime: '2026-06-18T10:00:00.000Z', summary: 'secret summary', source: 'git',
	};
	await service.writeBlameCache('secret.md', 'a'.repeat(40), new Map([[1, record]]));
	const cacheText = [...adapter.files.entries()].find(([path]) => path.startsWith('line-last-modified/blame-cache/private-device/'))?.[1].data ?? '';
	assert.doesNotMatch(cacheText, /Secret Author|secret@example.com|secret summary|Sensitive Laptop/);
	assert.match(cacheText, /"authorName":"Hidden"/);
});

test('HMAC mode without a local key never falls back to plain content hashes or blame caches', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	const settings = {
		...DEFAULT_SETTINGS,
		contentHashMode: 'hmac-sha256' as const,
		contentHashKey: '',
		deviceId: 'new-device',
		deviceName: 'New device',
		deviceCreatedAt: '2026-06-20T00:00:00.000Z',
	};
	const service = createMetadataService(adapter, settings, () => 1);
	await service.initialize();
	const event = service.recordEdit({ filePath: 'private.md', lineNumber: 1, lineText: 'sensitive equality' });
	assert.equal(event?.contentHash, undefined);
	assert.equal(event?.normalizedContentHash, undefined);
	assert.equal(event?.beforeContextHash, undefined);
	const record: GitBlameRecord = {
		filePath: 'private.md', lineNumber: 1, commitHash: 'b'.repeat(40), authorName: 'Author',
		authorTime: '2026-06-20T10:00:00.000Z', source: 'git', rawContent: 'sensitive equality',
	};
	await service.writeBlameCache('private.md', 'b'.repeat(40), new Map([[1, record]]));
	assert.equal([...adapter.files.keys()].some(path => path.includes('/blame-cache/')), false);
	assert.equal(service.getCachedBlame('private.md', 1, { filePath: 'private.md', lineNumber: 1, lineText: 'sensitive equality' }), null);
});

test('metadata flush signs events, verification detects tampering, and privacy rewrite re-signs owned events', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	const trust = new DeviceTrustManager();
	await trust.initialize('desktop');
	let sequence = 0;
	const settings = { ...DEFAULT_SETTINGS, enableDeviceTrust: true, deviceId: 'desktop', deviceName: 'Desktop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const service = createMetadataService(adapter, settings, () => ++sequence, {
		signingKeys: trust.signingKeys,
		signEvent: event => trust.sign(event),
		verifyEvent: (event, device) => trust.verify(event, device, new Set(), new Set(), 'desktop'),
	});
	await service.initialize();
	const recorded = service.recordEdit({ filePath: 'signed.md', lineNumber: 1, lineText: 'signed' }) as LineEditEvent;
	await service.flush();
	assert.equal(service.getEventVerification(recorded.eventId), 'verified-trusted');
	const path = [...adapter.files.keys()].find(value => value.startsWith('line-last-modified/events/desktop/') && value.endsWith('.jsonl')) as string;
	const signed = JSON.parse(adapter.readSync(path).trim()) as LineEditEvent;
	assert.ok(signed.signature?.value);
	await adapter.write(path, toJsonLines([{ ...signed, lineNumber: 9 }]));
	await service.reloadExternalData();
	assert.equal(service.getEventVerification(recorded.eventId), 'invalid');
	await service.rewriteOwnMetadataPrivacy();
	assert.equal(service.getEventVerification(recorded.eventId), 'verified-trusted');
});

test('metadata reload performs a trailing scan when a sync change arrives during scanning', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	const settings = { ...DEFAULT_SETTINGS, deviceId: 'laptop', deviceName: 'Laptop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const service = createMetadataService(adapter, settings, () => 1);
	await service.initialize();
	let releaseScan!: () => void;
	let scanStarted!: () => void;
	const started = new Promise<void>(resolve => { scanStarted = resolve; });
	const release = new Promise<void>(resolve => { releaseScan = resolve; });
	adapter.afterList = async (root) => {
		if (root !== 'line-last-modified/events') return;
		adapter.afterList = undefined;
		scanStarted();
		await release;
	};
	const scansBefore = adapter.listCalls.get('line-last-modified/events') ?? 0;
	const firstReload = service.reloadExternalData();
	await started;
	await adapter.mkdir('line-last-modified/events/phone');
	const synced: LineEditEvent = {
		eventId: 'phone-tail', deviceId: 'phone', filePath: 'tail.md', lineNumber: 1,
		contentHash: hashLine('tail'), normalizedContentHash: hashNormalizedLine('tail'),
		editedAt: '2026-06-18T12:00:00.000Z', localSequence: 1, source: 'local-edit', status: 'synced',
	};
	await adapter.write('line-last-modified/events/phone/2026-06.jsonl', toJsonLines([synced]));
	const trailingReloads = Array.from({ length: 100 }, () => service.reloadExternalData());
	releaseScan();
	await Promise.all([firstReload, ...trailingReloads]);
	assert.equal(service.findLineHistory({ filePath: 'tail.md', lineNumber: 1, lineText: 'tail' }).sync?.event.eventId, 'phone-tail');
	assert.equal((adapter.listCalls.get('line-last-modified/events') ?? 0) - scansBefore, 2);
});

test('concurrent flush calls append each event once and include edits made during the active flush', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	let sequence = 0;
	const settings = { ...DEFAULT_SETTINGS, deviceId: 'laptop', deviceName: 'Laptop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const service = createMetadataService(adapter, settings, () => ++sequence);
	await service.initialize();
	let releaseAppend!: () => void;
	let appendStarted!: () => void;
	const started = new Promise<void>(resolve => { appendStarted = resolve; });
	const release = new Promise<void>(resolve => { releaseAppend = resolve; });
	adapter.beforeAppend = async () => {
		adapter.beforeAppend = undefined;
		appendStarted();
		await release;
	};
	service.recordEdit({ filePath: 'note.md', lineNumber: 1, lineText: 'one' });
	const active = service.flush();
	await started;
	service.recordEdit({ filePath: 'note.md', lineNumber: 2, lineText: 'two' });
	const followers = Array.from({ length: 8 }, () => service.flush());
	releaseAppend();
	await Promise.all([active, ...followers]);
	const eventLines = [...adapter.files.entries()]
		.filter(([path]) => path.endsWith('.jsonl'))
		.flatMap(([, file]) => file.data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LineEditEvent));
	assert.equal(eventLines.length, 2);
	assert.equal(new Set(eventLines.map(event => event.eventId)).size, 2);
});

test('failed flush restores its snapshot and succeeds on retry without duplication', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	let sequence = 0;
	const settings = { ...DEFAULT_SETTINGS, deviceId: 'laptop', deviceName: 'Laptop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const service = createMetadataService(adapter, settings, () => ++sequence);
	await service.initialize();
	service.recordEdit({ filePath: 'retry.md', lineNumber: 1, lineText: 'retry' });
	adapter.failNextAppends = 1;
	await service.flush();
	assert.equal(service.getDiagnostics().pendingEvents, 1);
	await service.flush();
	assert.equal(service.getDiagnostics().pendingEvents, 0);
	const content = [...adapter.files.entries()].find(([path]) => path.endsWith('.jsonl'))?.[1].data ?? '';
	assert.equal(content.trim().split('\n').filter(Boolean).length, 1);
});

test('100k-event current-note lookup stays below the 5ms P95 target', async () => {
	(globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
	const adapter = new MemoryAdapter();
	await adapter.mkdir('line-last-modified');
	await adapter.mkdir('line-last-modified/events');
	await adapter.mkdir('line-last-modified/events/phone');
	const events: LineEditEvent[] = Array.from({ length: 100_000 }, (_, index) => ({
		eventId: `phone-${index}`, deviceId: 'phone', filePath: `notes/${index % 1000}.md`, lineNumber: index % 100,
		editedAt: new Date(1_700_000_000_000 + index).toISOString(), localSequence: index,
		source: 'local-edit' as const, status: 'synced' as const,
	}));
	await adapter.write('line-last-modified/events/phone/benchmark.jsonl', toJsonLines(events));
	const settings = { ...DEFAULT_SETTINGS, deviceId: 'laptop', deviceName: 'Laptop', deviceCreatedAt: '2026-06-18T00:00:00.000Z' };
	const service = createMetadataService(adapter, settings, () => 1);
	await service.initialize();
	const durations: number[] = [];
	for (let index = 0; index < 100; index++) {
		const started = performance.now();
		service.findLineHistory({ filePath: 'notes/999.md', lineNumber: 99, lineText: 'benchmark' });
		durations.push(performance.now() - started);
	}
	durations.sort((a, b) => a - b);
	assert.ok(durations[94] < 5, `P95 was ${durations[94].toFixed(2)}ms`);
});

function hasGit(): boolean {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

function createMetadataService(adapter: MemoryAdapter, settings: LineLastModifiedSettings, nextSequence: () => number, trust?: {
	signingKeys: DeviceInfo['signingKeys']; signEvent: (event: HistoryEvent) => Promise<HistoryEvent>;
	verifyEvent: (event: HistoryEvent, device: DeviceInfo | undefined) => Promise<EventVerificationStatus>;
}): SyncMetadataService {
	const device = (): DeviceInfo => ({
		deviceId: settings.deviceId,
		deviceName: settings.deviceName,
		platform: settings.devicePlatform,
		createdAt: settings.deviceCreatedAt,
		lastSeenAt: new Date().toISOString(), signingKeys: trust?.signingKeys,
	});
	return new SyncMetadataService({
		app: { vault: { adapter } } as never,
		settings: () => settings,
		device,
		nextSequence,
		onStateChanged: () => undefined,
		signEvent: trust?.signEvent,
		verifyEvent: trust?.verifyEvent,
	});
}

class MemoryAdapter {
	readonly files = new Map<string, { data: string; mtime: number }>();
	readonly listCalls = new Map<string, number>();
	afterList?: (root: string) => Promise<void>;
	beforeAppend?: (path: string, data: string) => Promise<void>;
	failNextAppends = 0;
	private readonly folders = new Set<string>(['']);
	private clock = Date.now();

	async exists(path: string): Promise<boolean> { return this.files.has(path) || this.folders.has(path); }
	async mkdir(path: string): Promise<void> { this.folders.add(path); }
	async stat(path: string): Promise<{ mtime: number; size: number } | null> {
		const file = this.files.get(path);
		if (file) return { mtime: file.mtime, size: new TextEncoder().encode(file.data).length };
		return this.folders.has(path) ? { mtime: 0, size: 0 } : null;
	}
	async read(path: string): Promise<string> {
		const file = this.files.get(path);
		if (!file) throw new Error(`Missing file: ${path}`);
		return file.data;
	}
	readSync(path: string): string { return this.files.get(path)?.data ?? ''; }
	async write(path: string, data: string): Promise<void> { this.files.set(path, { data, mtime: ++this.clock }); }
	async append(path: string, data: string): Promise<void> {
		if (this.failNextAppends > 0) {
			this.failNextAppends -= 1;
			throw new Error('Injected append failure');
		}
		await this.beforeAppend?.(path, data);
		await this.write(path, this.readSync(path) + data);
	}
	async remove(path: string): Promise<void> { this.files.delete(path); this.folders.delete(path); }
	async list(root: string): Promise<{ files: string[]; folders: string[] }> {
		this.listCalls.set(root, (this.listCalls.get(root) ?? 0) + 1);
		const prefix = root ? `${root}/` : '';
		const files = [...this.files.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'));
		const folders = [...this.folders].filter(path => path.startsWith(prefix) && path !== root && !path.slice(prefix.length).includes('/'));
		const result = { files, folders };
		await this.afterList?.(root);
		return result;
	}
}
