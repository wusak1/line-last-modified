import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { applyDisplayPolicy, gitStateGuidance } from '../src/display-policy';
import { parseGitBlamePorcelain } from '../src/git-parser';
import { deduplicateByEventId, parseJsonLines, toJsonLines } from '../src/jsonl';
import { findPotentialConflicts, matchLineEvents } from '../src/line-identity';
import { localDeviceStateFromSettings, mergeStoredSettings, settingsForVaultData } from '../src/settings-storage';
import type { EventMatch, LineEditEvent } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/types';
import { buildLineHashes, displayTime, hashLine, hmacSha256, relativeTime, sha256, timestampFontFamily, timestampFontSizePx, validateSyncMetadataDir } from '../src/utils';
import { mergeFontFamilies, parseWindowsFontRegistry } from '../src/font-options';
import { createTranslator, EN_TRANSLATIONS, resolveTimestampLanguage, ZH_CN_TRANSLATIONS } from '../src/i18n';
import { resolveDocumentContext } from '../src/document-context';
import { evaluateTimestamp } from '../src/time-semantics';
import { classifyJournalEdit, OldJournalNoticeTracker } from '../src/journal-policy';
import { evaluateKnowledgeFreshness } from '../src/knowledge-policy';
import { applyDocumentModeDisplay } from '../src/mode-display';
import { buildHistoryPanelModel } from '../src/history-model';
import { buildJournalReviewModel, journalReviewMarkdown, validateJournalExportPath } from '../src/journal-review-model';
import { buildKnowledgeDashboard, filterAndSortKnowledgeDashboard } from '../src/knowledge-dashboard-model';
import { nextTimestampRefreshDelay } from '../src/refresh-scheduler';
import { compactGutterLabel } from '../src/placement-display';
import { HybridClock, compareHistoryEvents } from '../src/hybrid-clock';
import { buildFileLineage, editEventsForPath } from '../src/file-lifecycle';
import type { FileLifecycleEvent, HistoryEvent } from '../src/types';
import { countTextCharacters, countTextCharactersByLine, heatIntensity } from '../src/text-metrics';
import { buildKnowledgeImpactTasks } from '../src/knowledge-impact-model';
import { buildJournalMigrationCandidates } from '../src/journal-migration-model';
import { safePublicVaultPath, sanitizePublicCandidate } from '../src/public-api';
import { JournalProtectionTracker } from '../src/journal-snapshot-store';
import { DeviceTrustManager, generateSigningIdentity, signHistoryEvent, verifyHistoryEvent } from '../src/device-trust';
import { buildLocalInsights } from '../src/local-insights-model';
import { MeaningfulEditGate, netChangedCharacters } from '../src/edit-threshold';

function event(overrides: Partial<LineEditEvent> = {}): LineEditEvent {
	return {
		eventId: 'desktop-1', deviceId: 'desktop', deviceName: 'Laptop', filePath: 'notes/a.md', lineNumber: 2,
		contentHash: hashLine('target'), normalizedContentHash: hashLine('target'), editedAt: '2026-06-18T10:00:00.000Z',
		localSequence: 1, source: 'local-edit', status: 'uncommitted', ...overrides,
	};
}

test('meaningful edit threshold ignores noise, accumulates edits, and preserves structural changes', () => {
	assert.equal(DEFAULT_SETTINGS.minimumChangedCharacters, 5);
	assert.equal(netChangedCharacters('日记 abc', '日记 abcd'), 1);
	assert.equal(netChangedCharacters('abcdef', 'abXYef'), 2);

	const gate = new MeaningfulEditGate();
	const query = (lineText: string, previousLineText: string) => ({
		filePath: 'Journal/2026-06-20.md', lineNumber: 1, lineText, previousLineText,
	});
	assert.equal(gate.accept(query('hellox', 'hello'), 5), null);
	assert.equal(gate.accept(query('helloxy', 'hellox'), 5), null);
	const accepted = gate.accept(query('helloxy123', 'helloxy'), 5);
	assert.equal(accepted?.previousLineText, 'hello');
	assert.equal(accepted?.lineText, 'helloxy123');

	assert.equal(gate.accept(query('helloxy123!', 'helloxy123'), 5), null);
	assert.equal(gate.accept(query('helloxy123', 'helloxy123!'), 5), null);
	assert.ok(gate.accept(query('helloxy123!', 'helloxy123'), 5, true));
	assert.ok(gate.accept(query('helloxy123!', 'helloxy123'), 1));
});

test('hybrid logical clock clamps fast remote clocks and orders ties deterministically', () => {
	const now = Date.parse('2026-06-20T00:00:00.000Z');
	const clock = new HybridClock('local', () => now);
	const first = clock.next({ wallTime: now + 30 * 24 * 60 * 60 * 1000, logical: 99, nodeId: 'fast' });
	assert.equal(first.wallTime, now + 24 * 60 * 60 * 1000);
	const second = clock.next();
	assert.equal(second.wallTime, first.wallTime);
	assert.ok(second.logical > first.logical);
	const left = event({ eventId: 'a', deviceId: 'a', hlc: { wallTime: now, logical: 1, nodeId: 'a' } });
	const right = event({ eventId: 'b', deviceId: 'b', hlc: { wallTime: now, logical: 2, nodeId: 'b' } });
	assert.ok(compareHistoryEvents(left, right, now) < 0);
	const fastWall = event({ eventId: 'fast', deviceId: 'fast', editedAt: new Date(now + 30 * 86_400_000).toISOString(), hlc: { wallTime: now + 30 * 86_400_000, logical: 0, nodeId: 'fast' } });
	const reliableLater = event({ eventId: 'reliable', deviceId: 'local', editedAt: new Date(now + 1_000).toISOString(), hlc: { wallTime: now + 24 * 60 * 60 * 1000, logical: 2, nodeId: 'local' } });
	const selected = matchLineEvents([fastWall, reliableLater], { filePath: 'notes/a.md', lineNumber: 2, lineText: 'target' }, now);
	assert.equal(selected?.event.eventId, 'reliable');
});

test('file lineage survives three renames and delete-recreate gets a new identity', () => {
	const at = (eventType: 'rename' | 'delete', filePath: string, previousPath: string | undefined, sequence: number, fileIncarnationId = 'file-old'): FileLifecycleEvent => ({
		schemaVersion: 2, eventType, eventId: `life-${sequence}`, deviceId: 'desktop', fileIncarnationId,
		filePath, previousPath, recordedAt: new Date(1_700_000_000_000 + sequence).toISOString(), localSequence: sequence,
		hlc: { wallTime: 1_700_000_000_000 + sequence, logical: 0, nodeId: 'desktop' },
	});
	const edit = event({ schemaVersion: 2, eventType: 'edit', filePath: 'a.md', fileIncarnationId: 'file-old' });
	const recreated = event({ schemaVersion: 2, eventType: 'edit', eventId: 'new-edit', filePath: 'd.md', fileIncarnationId: 'file-new' });
	const events: HistoryEvent[] = [edit, at('rename', 'b.md', 'a.md', 1), at('rename', 'c.md', 'b.md', 2), at('rename', 'd.md', 'c.md', 3), at('delete', 'd.md', undefined, 4), recreated];
	const lineage = buildFileLineage(events);
	assert.equal(lineage.activeByPath.get('d.md'), 'file-new');
	assert.deepEqual(editEventsForPath(events, 'd.md', lineage).map(value => value.eventId), ['new-edit']);
	assert.ok(lineage.pathsByIncarnation.get('file-old')?.has('a.md'));
	assert.ok(lineage.pathsByIncarnation.get('file-old')?.has('d.md'));
	assert.equal(lineage.renameConflicts.size, 0);
	const remoteRename = { ...at('rename', 'remote.md', 'c.md', 3), eventId: 'remote-rename', deviceId: 'phone', hlc: { wallTime: 1_700_000_000_003, logical: 0, nodeId: 'phone' } };
	assert.ok(buildFileLineage([...events, remoteRename]).renameConflicts.has('file-old'));
});

test('knowledge impact analysis prioritizes embeds and only suggests notes older than their targets', () => {
	const tasks = buildKnowledgeImpactTasks([
		{ path: 'Knowledge/source.md', lastChangedAt: '2026-06-01T00:00:00.000Z', backlinksCount: 2 },
		{ path: 'Knowledge/target.md', lastChangedAt: '2026-06-10T00:00:00.000Z', backlinksCount: 5 },
		{ path: 'Knowledge/fresh.md', lastChangedAt: '2026-06-11T00:00:00.000Z', backlinksCount: 0 },
	], [
		{ sourcePath: 'Knowledge/source.md', targetPath: 'Knowledge/target.md', kind: 'embed' },
		{ sourcePath: 'Knowledge/fresh.md', targetPath: 'Knowledge/target.md', kind: 'backlink' },
		{ sourcePath: 'Excluded/missing.md', targetPath: 'Knowledge/target.md', kind: 'embed' },
	]);
	assert.equal(tasks.length, 1);
	assert.equal(tasks[0].affectedPath, 'Knowledge/source.md');
	assert.equal(tasks[0].relation, 'embed');
	assert.equal(Math.floor(tasks[0].lagDays ?? 0), 9);
});

test('journal migration requires a unique copy-delete pair unless an explicit move transaction links it', () => {
	const deleted = event({ eventId: 'delete', filePath: 'Daily/2026-06-18.md', operation: 'delete', previousContentHash: hashLine('unique task'), editedAt: '2026-06-19T01:00:00.000Z', fileIncarnationId: 'source' });
	const inserted = event({ eventId: 'insert', filePath: 'Daily/2026-06-19.md', operation: 'insert', contentHash: hashLine('unique task'), editedAt: '2026-06-19T01:01:00.000Z', fileIncarnationId: 'target' });
	const notes = [
		{ path: 'Daily/2026-06-18.md', journalDate: '2026-06-18', events: [deleted] },
		{ path: 'Daily/2026-06-19.md', journalDate: '2026-06-19', events: [inserted] },
	];
	assert.equal(buildJournalMigrationCandidates(notes).length, 1);
	const repeated = { ...inserted, eventId: 'insert-2', lineNumber: 4 };
	assert.equal(buildJournalMigrationCandidates([{ ...notes[0] }, { ...notes[1], events: [inserted, repeated] }]).length, 0);
	const moveId = 'move-1';
	const explicit = buildJournalMigrationCandidates([
		{ ...notes[0], events: [{ ...deleted, moveTransactionId: moveId }] },
		{ ...notes[1], events: [{ ...inserted, moveTransactionId: moveId }, repeated] },
	]);
	assert.equal(explicit[0]?.confidence, 'confirmed-move');
});

test('public API candidate sanitizer applies privacy before returning plugin data', () => {
	const input = { timestamp: '2026-06-20T00:00:00.000Z', source: 'sync' as const, confidence: 'high' as const, conflict: true, deviceName: 'Private Laptop' };
	assert.deepEqual(sanitizePublicCandidate(input, false), { timestamp: input.timestamp, source: 'sync', confidence: 'high', conflict: true, deviceName: undefined });
	assert.equal(sanitizePublicCandidate(input, true).deviceName, 'Private Laptop');
	assert.equal('authorName' in sanitizePublicCandidate(input, true), false);
	assert.equal('eventId' in sanitizePublicCandidate(input, true), false);
	assert.equal(safePublicVaultPath('Notes/a.md'), 'Notes/a.md');
	for (const unsafe of ['C:\\Users\\secret.md', '/absolute.md', '../outside.md', 'Notes/../secret.md', '.']) assert.equal(safePublicVaultPath(unsafe), null);
});

test('journal history protection is opt-in and tracks only the first edit per session', () => {
	assert.equal(DEFAULT_SETTINGS.journalHistoryProtection, 'off');
	assert.equal(DEFAULT_SETTINGS.journalSnapshotRetentionDays, 30);
	const tracker = new JournalProtectionTracker();
	assert.equal(tracker.has('Daily/old.md'), false);
	tracker.mark('Daily/old.md');
	assert.equal(tracker.has('Daily/old.md'), true);
});

test('local insights are opt-in, deterministic, and explain their non-network evidence', () => {
	assert.equal(DEFAULT_SETTINGS.enableLocalInsights, false);
	const insightSource = readFileSync('src/local-insights-model.ts', 'utf8');
	assert.doesNotMatch(insightSource, /\b(?:fetch|XMLHttpRequest|requestUrl|WebSocket|EventSource)\b/);
	const insight = buildLocalInsights([
		{ path: 'Daily/2026-06-20.md', mode: 'journal', content: '# Work\n#project [[Alpha]]', lastChangedAt: '2026-06-20T00:00:00Z' },
		{ path: 'Notes/Alpha.md', mode: 'knowledge', content: '# Alpha\n#project', lastChangedAt: '2026-06-19T00:00:00Z', freshness: 'review-due' },
	], 7, Date.parse('2026-06-20T12:00:00Z'));
	assert.equal(insight.changedNotes, 2);
	assert.ok(insight.topTopics.some(value => value.topic === '#project' && value.count === 2));
	assert.equal(insight.knowledgeRisks[0]?.path, 'Notes/Alpha.md');
	assert.match(insight.explanation, /No model or network request/);
	const partial = buildLocalInsights([], 7, Date.parse('2026-06-20T12:00:00Z'), 2);
	assert.equal(partial.skippedNotes, 2);
	assert.match(partial.explanation, /2 unreadable note/);
});

test('P-256 event signatures verify and detect tampering', async () => {
	const identity = await generateSigningIdentity('desktop');
	const original = event({ schemaVersion: 2, eventType: 'edit', fileIncarnationId: 'file-1' });
	const signature = await signHistoryEvent(original, identity.privateKeyJwk, identity.currentKeyId);
	const signed = { ...original, signature };
	assert.equal(await verifyHistoryEvent(signed, identity.keys[0].publicKeyJwk), true);
	assert.equal(await verifyHistoryEvent({ ...signed, lineNumber: 99 }, identity.keys[0].publicKeyJwk), false);
});

test('device trust distinguishes trusted, untrusted, revoked, and invalid signatures', async () => {
	const manager = new DeviceTrustManager();
	await manager.initialize('desktop');
	const signed = await manager.sign(event({ schemaVersion: 2, eventType: 'edit', deviceId: 'desktop', fileIncarnationId: 'file-1' }));
	const device = { deviceId: 'desktop', platform: 'desktop' as const, createdAt: '2026-06-20T00:00:00Z', lastSeenAt: '2026-06-20T00:00:00Z', signingKeys: manager.signingKeys };
	const keyId = signed.signature?.keyId as string;
	assert.equal(await manager.verify(signed, device, new Set(), new Set(), 'other-device'), 'verified-untrusted');
	assert.equal(await manager.verify(signed, device, new Set([keyId]), new Set(), 'other-device'), 'verified-trusted');
	assert.equal(await manager.verify(signed, device, new Set([keyId]), new Set([keyId]), 'other-device'), 'revoked');
	assert.equal(await manager.verify({ ...signed, lineNumber: 9 }, device, new Set([keyId]), new Set(), 'other-device'), 'invalid');
});

test('HMAC-SHA-256 keyed hashes use the standard construction', () => {
	assert.equal(hmacSha256('key', 'The quick brown fox jumps over the lazy dog'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
	const query = { filePath: 'note.md', lineNumber: 1, lineText: 'same text' };
	const first = buildLineHashes({ ...query, hashKey: 'device-shared-secret' });
	const same = buildLineHashes({ ...query, hashKey: 'device-shared-secret' });
	const different = buildLineHashes({ ...query, hashKey: 'different-secret' });
	assert.equal(first.contentHash, same.contentHash);
	assert.notEqual(first.contentHash, different.contentHash);
	assert.notEqual(first.contentHash, buildLineHashes(query).contentHash);
});

test('SHA-256 and short line hash are stable', () => {
	assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	assert.equal(hashLine('abc'), 'ba7816bf8f01');
});

test('git line-porcelain parser extracts commit metadata', () => {
	const output = [
		'0123456789abcdef0123456789abcdef01234567 1 2 1',
		'author Ryker',
		'author-mail <ryker@example.com>',
		'author-time 1781776800',
		'author-tz +0800',
		'summary update note',
		'filename notes/a.md',
		'\ttarget',
	].join('\n');
	const record = parseGitBlamePorcelain(output, 'notes/a.md').get(2);
	assert.equal(record?.authorName, 'Ryker');
	assert.equal(record?.authorEmail, 'ryker@example.com');
	assert.equal(record?.summary, 'update note');
	assert.equal(record?.commitHash, '0123456789abcdef0123456789abcdef01234567');
});

test('JSONL parser skips only malformed lines and deduplicates events', () => {
	const valid = event();
	const parsed = parseJsonLines<LineEditEvent>(`${toJsonLines([valid])}{bad json}\n${JSON.stringify({ nope: true })}`,
		(value): value is LineEditEvent => !!value && typeof value === 'object' && 'eventId' in value);
	assert.equal(parsed.values.length, 1);
	assert.equal(parsed.errors, 2);
	assert.equal(deduplicateByEventId([valid, { ...valid, editedAt: '2026-06-18T10:01:00.000Z' }]).length, 1);
});

test('line identity follows content moved within twenty lines', () => {
	const match = matchLineEvents([event()], {
		filePath: 'notes/a.md', lineNumber: 7, lineText: 'target', beforeLine: 'before', afterLine: 'after',
	});
	assert.equal(match?.reason, 'nearby-content');
	assert.equal(match?.event.eventId, 'desktop-1');
});

test('line identity marks near-simultaneous cross-device edits as conflict', () => {
	const first = event({ editedAt: '2026-06-18T10:00:00.000Z' });
	const second = event({ eventId: 'phone-1', deviceId: 'phone', deviceName: 'Phone', editedAt: '2026-06-18T10:00:30.000Z' });
	const match = matchLineEvents([first, second], { filePath: 'notes/a.md', lineNumber: 2, lineText: 'target' });
	assert.equal(match?.event.eventId, 'phone-1');
	assert.equal(match?.potentialConflict, true);
});

test('conflict detection spans local and separately synchronized event sets', () => {
	const local = event({ editedAt: '2026-06-18T10:00:00.000Z' });
	const synced = event({ eventId: 'phone-2', deviceId: 'phone', editedAt: '2026-06-18T10:00:20.000Z' });
	const query = { filePath: 'notes/a.md', lineNumber: 2, lineText: 'target' };
	assert.equal(matchLineEvents([local], query)?.potentialConflict, false);
	assert.equal(findPotentialConflicts(local, [local, synced], query).map(value => value.eventId).join(','), 'phone-2');
});

test('display policy applies memory, local, sync, Git, filesystem priority', () => {
	const matched: EventMatch = {
		event: event(), confidence: 'high', reason: 'exact', nearbyEvents: [], potentialConflict: false, timeUncertain: false,
	};
	const settings = { ...DEFAULT_SETTINGS };
	const result = applyDisplayPolicy({
		memory: matched, local: null, sync: null,
		git: { state: 'ok', record: {
			filePath: 'notes/a.md', lineNumber: 2, commitHash: 'a'.repeat(40), authorName: 'Git Author',
			authorTime: '2026-06-17T10:00:00.000Z', source: 'git',
		} },
		fileMtime: Date.parse('2026-06-19T10:00:00.000Z'), now: Date.parse('2026-06-18T10:00:10.000Z'),
	}, settings);
	assert.equal(result.source, 'memory');
	assert.match(result.text, /^Edited just now · local$/);
});

test('display policy localizes visible text and detailed tooltips', () => {
	const match: EventMatch = { event: event(), confidence: 'high', reason: 'exact', nearbyEvents: [], potentialConflict: false, timeUncertain: false };
	const result = applyDisplayPolicy({ memory: match, local: null, sync: null, git: { state: 'disabled', record: null }, now: Date.parse('2026-06-18T10:02:00Z') }, DEFAULT_SETTINGS, createTranslator('zh-CN'));
	assert.match(result.text, /^编辑于 2 分钟前/);
	assert.match(result.tooltip, /来源：当前内存中的编辑/);
	assert.match(result.tooltip, /匹配依据：exact/);
	const yesterday = applyDisplayPolicy({ memory: { ...match, event: event({ editedAt: '2026-06-17T10:00:00Z' }) }, local: null, sync: null, git: { state: 'disabled', record: null }, now: Date.parse('2026-06-18T10:00:00Z') }, DEFAULT_SETTINGS, createTranslator('en'));
	assert.match(yesterday.text, /Yesterday/);
});

test('timestamp-only privacy omits device and author names', () => {
	const sync: EventMatch = {
		event: event({ deviceId: 'phone', deviceName: 'Secret Phone' }), confidence: 'high', reason: 'exact',
		nearbyEvents: [], potentialConflict: false, timeUncertain: false,
	};
	const result = applyDisplayPolicy({
		memory: null, local: null, sync, git: { state: 'mobile', record: null }, now: Date.parse('2026-06-18T10:01:00.000Z'),
	}, { ...DEFAULT_SETTINGS, privacyMode: 'timestamp-only' });
	assert.equal(result.source, 'sync');
	assert.doesNotMatch(result.text, /Secret Phone|synced|from/);
});

test('relative time formats boundary values', () => {
	const now = Date.parse('2026-06-18T12:00:00.000Z');
	assert.equal(relativeTime(now - 30_000, now), 'just now');
	assert.equal(relativeTime(now - 2 * 3_600_000, now), '2 hours ago');
});

test('relative mode switches to absolute time at the configured hour or day threshold', () => {
	const now = new Date(2026, 5, 18, 12, 0, 0).getTime();
	const timestamp = now - 48 * 3_600_000;
	assert.equal(displayTime(timestamp, { ...DEFAULT_SETTINGS, absoluteTimeAfter: 0 }, now), '2 days ago');
	assert.equal(displayTime(timestamp, {
		...DEFAULT_SETTINGS, absoluteTimeAfter: 49, absoluteTimeAfterUnit: 'hours',
	}, now), '2 days ago');
	assert.equal(displayTime(timestamp, {
		...DEFAULT_SETTINGS, absoluteTimeAfter: 48, absoluteTimeAfterUnit: 'hours',
	}, now), '2026-06-16 12:00');
	assert.equal(displayTime(timestamp, {
		...DEFAULT_SETTINGS, absoluteTimeAfter: 2, absoluteTimeAfterUnit: 'days',
	}, now), '2026-06-16 12:00');
});

test('absolute threshold does not override Absolute or Both display modes', () => {
	const now = new Date(2026, 5, 18, 12, 0, 0).getTime();
	const timestamp = now - 72 * 3_600_000;
	assert.equal(displayTime(timestamp, {
		...DEFAULT_SETTINGS, displayMode: 'absolute', absoluteTimeAfter: 999,
	}, now), '2026-06-15 12:00');
	assert.equal(displayTime(timestamp, {
		...DEFAULT_SETTINGS, displayMode: 'both', absoluteTimeAfter: 1,
	}, now), '3 days ago (2026-06-15 12:00)');
});

test('boundary scheduler refreshes relative labels, absolute thresholds, and mode day boundaries', () => {
	const now = Date.parse('2026-06-20T12:00:30Z');
	const info = { text: 'Edited just now', source: 'local' as const, confidence: 'high' as const, tooltip: '', timestamp: '2026-06-20T12:00:00Z' };
	assert.equal(nextTimestampRefreshDelay(info, DEFAULT_SETTINGS, now), 30_025);
	const tenMinutes = { ...info, timestamp: '2026-06-20T11:50:10Z' };
	assert.equal(nextTimestampRefreshDelay(tenMinutes, DEFAULT_SETTINGS, now), 40_025);
	assert.equal(nextTimestampRefreshDelay(info, { ...DEFAULT_SETTINGS, displayMode: 'absolute' }, now), null);
	const knowledgeDelay = nextTimestampRefreshDelay({ ...info, documentMode: 'knowledge' }, { ...DEFAULT_SETTINGS, displayMode: 'absolute', journalTimezoneOffsetMinutes: 0 }, now);
	assert.equal(knowledgeDelay, Date.parse('2026-06-21T00:00:00Z') - now + 25);
	const threshold = nextTimestampRefreshDelay({ ...info, timestamp: '2026-06-20T11:01:00Z' }, {
		...DEFAULT_SETTINGS, absoluteTimeAfter: 1, absoluteTimeAfterUnit: 'hours',
	}, now);
	assert.equal(threshold, 30_025);
});

test('gutter labels expose useful compact time text instead of an icon-only marker', () => {
	const base = { source: 'local' as const, confidence: 'high' as const, tooltip: '' };
	assert.equal(compactGutterLabel({ ...base, text: 'Edited 2 hours ago · local' }), '2 hours ago');
	assert.equal(compactGutterLabel({ ...base, text: '编辑于 2 小时前 · 本机' }), '2 小时前');
	assert.equal(compactGutterLabel({ ...base, text: '补记 +2天' }), '补记 +2天');
});

test('timestamp font settings use defaults and clamp unsafe sizes', () => {
	assert.equal(timestampFontFamily({ ...DEFAULT_SETTINGS, timestampFontFamily: '  Microsoft YaHei  ' }), 'Microsoft YaHei');
	assert.equal(timestampFontFamily({ ...DEFAULT_SETTINGS, timestampFontFamily: '   ' }), 'var(--font-monospace)');
	assert.equal(timestampFontSizePx({ ...DEFAULT_SETTINGS, timestampFontSizePx: 4 }), 8);
	assert.equal(timestampFontSizePx({ ...DEFAULT_SETTINGS, timestampFontSizePx: 100 }), 32);
});

test('journal metadata keeps line previews disabled by default', () => {
	assert.equal(DEFAULT_SETTINGS.storeLinePreview, false);
});

test('font choices are trimmed, deduplicated case-insensitively, and sorted', () => {
	assert.deepEqual(
		mergeFontFamilies([' Segoe UI ', 'Microsoft YaHei'], ['segoe ui', '', 'Arial']),
		['Arial', 'Microsoft YaHei', 'Segoe UI'],
	);
});

test('Windows font registry output yields installed display names', () => {
	const output = [
		'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
		'    Arial (TrueType)    REG_SZ    arial.ttf',
		'    Microsoft YaHei & Microsoft YaHei UI (TrueType)    REG_SZ    msyh.ttc',
	].join('\r\n');
	assert.deepEqual(parseWindowsFontRegistry(output), ['Arial', 'Microsoft YaHei & Microsoft YaHei UI']);
});

test('settings translations keep English and Simplified Chinese key sets aligned', () => {
	assert.deepEqual(Object.keys(ZH_CN_TRANSLATIONS).sort(), Object.keys(EN_TRANSLATIONS).sort());
	assert.equal(createTranslator('zh-CN')('enableTimestamp'), '显示当前行时间戳');
	assert.equal(createTranslator('zh')('fontsFound', { count: 3 }), '找到 3 个本地字体。重新打开此设置后会刷新列表。');
	assert.equal(createTranslator('fr')('enableTimestamp'), 'Show the current-line timestamp');
	assert.equal(resolveTimestampLanguage('zh-CN', 'en'), 'zh-CN');
	assert.equal(resolveTimestampLanguage('auto', 'zh-CN'), 'zh-CN');
});

test('settings use progressive disclosure and retain narrow-pane layout rules', () => {
	const settingsSource = readFileSync('src/settings.ts', 'utf8');
	const styles = readFileSync('styles.css', 'utf8');
	assert.match(settingsSource, /createSettingsCard\(containerEl, t\('startHere'\)/);
	assert.match(settingsSource, /createSettingsCard\(containerEl, t\('documentModes'\)/);
	for (const section of ['detectionRules', 'journalFeatures', 'knowledgeFeatures', 'gitAdvanced', 'syncAdvanced', 'privacySettings', 'securitySettings']) {
		assert.match(settingsSource, new RegExp(`createNestedSection\\([^\\n]+t\\('${section}'\\)`));
	}
	assert.match(EN_TRANSLATIONS.writeSyncDesc, /FastNoteSync/);
	assert.match(ZH_CN_TRANSLATIONS.writeSyncDesc, /FastNoteSync/);
	assert.match(styles, /\.line-last-modified-settings-card/);
	assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.line-last-modified-nested-section/);
});

test('document mode follows frontmatter, longest folder rule, journal date, then default priority', () => {
	const settings = {
		...DEFAULT_SETTINGS,
		knowledgeModeFolders: ['Notes'], journalModeFolders: ['Notes/Journal'], offModeFolders: ['Templates'],
	};
	const frontmatterKnowledge = resolveDocumentContext({ filePath: 'Templates/a.md', frontmatter: { line_history_mode: 'knowledge' }, settings });
	assert.equal(frontmatterKnowledge.mode, 'knowledge');
	assert.equal(frontmatterKnowledge.modeReason, 'frontmatter');
	assert.equal(resolveDocumentContext({ filePath: 'Notes/Journal/a.md', settings }).mode, 'journal');
	assert.equal(resolveDocumentContext({ filePath: 'Journal/2026-06-19.md', settings }).journalDate, '2026-06-19');
	assert.equal(resolveDocumentContext({ filePath: 'Journal/19.06.2026.md', settings: { ...settings, journalFilenameFormat: 'DD.MM.YYYY' } }).journalDate, '2026-06-19');
	assert.equal(resolveDocumentContext({ filePath: 'Notes/a.md', settings: { ...settings, defaultDocumentMode: 'off' } }).mode, 'knowledge');
	assert.equal(resolveDocumentContext({ filePath: 'Other/a.md', settings: { ...settings, defaultDocumentMode: 'off' } }).mode, 'off');
	const knowledge = resolveDocumentContext({
		filePath: 'Notes/a.md', settings,
		frontmatter: { review_after: '30d', expires_after: '120d', freshness_ignore: true },
	});
	assert.deepEqual(knowledge.reviewPolicy, { reviewAfterDays: 30, expiresAfterDays: 120, ignore: true, source: 'frontmatter' });
});

test('normal timestamps only preset disables all document classification', () => {
	const settings = {
		...DEFAULT_SETTINGS,
		enableDocumentModes: false,
		journalModeFolders: ['Journal'],
		knowledgeModeFolders: ['Notes'],
	};
	assert.deepEqual(resolveDocumentContext({
		filePath: 'Journal/2026-06-19.md',
		frontmatter: { line_history_mode: 'knowledge' },
		settings,
	}), { mode: 'normal', modeReason: 'default' });
});

test('history explanation deduplicates candidates and enforces privacy before rendering', () => {
	const selected = event({ eventId: 'selected', editedAt: '2026-06-19T10:00:00Z' });
	const nearby = event({ eventId: 'nearby', deviceId: 'phone', deviceName: 'Phone', editedAt: '2026-06-19T10:00:30Z' });
	const match: EventMatch = {
		event: selected, nearbyEvents: [nearby], confidence: 'high', reason: 'exact',
		potentialConflict: true, timeUncertain: false,
	};
	const snapshot = {
		selected: { text: 'Edited just now', source: 'local' as const, confidence: 'high' as const, tooltip: '' },
		memory: match, local: match, sync: null,
		git: { state: 'ok' as const, record: {
			filePath: 'notes/a.md', lineNumber: 2, commitHash: 'abcdef123456', authorName: 'Alice',
			authorTime: '2026-06-18T08:00:00Z', source: 'git' as const,
		}},
		fileMtime: Date.parse('2026-06-17T00:00:00Z'),
		metadata: { rootPath: 'line-last-modified', loadedEvents: 2, pendingEvents: 0, parseErrors: 0, lastScanAt: '2026-06-19T09:00:00Z' },
	};
	const full = buildHistoryPanelModel(snapshot, { ...DEFAULT_SETTINGS, showCommitHash: true });
	assert.equal(full.candidates.length, 2);
	assert.equal(full.candidates[1].deviceName, 'Laptop');
	assert.equal(full.git?.author, 'Alice');
	assert.equal(full.git?.commit, 'abcdef123456');
	const privateModel = buildHistoryPanelModel(snapshot, { ...DEFAULT_SETTINGS, showCommitHash: true, privacyMode: 'timestamp-only' });
	assert.equal(privateModel.candidates.every(item => item.deviceName === undefined), true);
	assert.equal(privateModel.git?.author, undefined);
});

test('invalid or ambiguous journal dates are never guessed', () => {
	assert.equal(resolveDocumentContext({ filePath: 'Journal/2026-02-30.md', settings: DEFAULT_SETTINGS }).journalDate, undefined);
	assert.equal(resolveDocumentContext({ filePath: 'Journal/06-07-2026.md', settings: DEFAULT_SETTINGS }).mode, 'normal');
});

test('unified timestamp semantics distinguish reliable, future, and invalid clocks', () => {
	const now = Date.parse('2026-06-19T00:00:00Z');
	assert.equal(evaluateTimestamp('2026-06-19T00:00:00Z', now).clockStatus, 'reliable');
	assert.equal(evaluateTimestamp('2026-06-20T00:00:01Z', now).clockStatus, 'future');
	assert.equal(evaluateTimestamp('not-a-date', now).clockStatus, 'invalid');
});

test('journal classification handles same day, next day, month/year boundaries, prewrite, and future clocks', () => {
	const now = Date.parse('2027-02-01T00:00:00Z');
	assert.equal(classifyJournalEdit('2026-12-31', '2026-12-31T20:00:00Z', 7, 0, now).kind, 'same-day');
	assert.equal(classifyJournalEdit('2026-12-31', '2027-01-01T00:01:00Z', 7, 0, now).kind, 'next-day');
	assert.deepEqual(classifyJournalEdit('2026-01-31', '2026-02-03T08:00:00Z', 7, 0, now), { kind: 'delayed', differenceDays: 3 });
	assert.equal(classifyJournalEdit('2026-01-01', '2026-01-10T00:00:00Z', 7, 0, now).kind, 'retrospective');
	assert.equal(classifyJournalEdit('2026-01-02', '2026-01-01T23:00:00Z', 7, 0, now).kind, 'prewrite');
	assert.equal(classifyJournalEdit('2027-02-01', '2027-02-03T00:00:01Z', 7, 0, now).kind, 'uncertain');
});

test('journal timezone offset controls the calendar day across midnight', () => {
	const now = Date.parse('2026-07-01T00:00:00Z');
	assert.equal(classifyJournalEdit('2026-06-19', '2026-06-18T16:30:00Z', 7, 480, now).kind, 'same-day');
	assert.equal(classifyJournalEdit('2026-06-18', '2026-06-18T16:30:00Z', 7, 480, now).kind, 'next-day');
});

test('journal review builds week/month heatmaps and filters device sources', () => {
	const now = Date.parse('2026-06-20T12:00:00Z');
	const notes = [
		{ path: 'Journal/2026-06-19.md', journalDate: '2026-06-19', characterCount: 501, events: [event({ eventId: 'phone-next', deviceId: 'phone', deviceName: 'Phone', filePath: 'Journal/2026-06-19.md', editedAt: '2026-06-20T08:00:00Z' })] },
		{ path: 'Journal/2026-06-01.md', journalDate: '2026-06-01', characterCount: 5001, events: [event({ eventId: 'desktop-late', filePath: 'Journal/2026-06-01.md', editedAt: '2026-06-20T08:00:00Z' })] },
	];
	const settings = { ...DEFAULT_SETTINGS, journalTimezoneOffsetMinutes: 480 };
	const week = buildJournalReviewModel(notes, settings, { range: 'week', now });
	assert.equal(week.delayedCount, 1);
	assert.equal(week.retrospectiveCount, 0);
	assert.equal(week.heatmap.length, 7);
	assert.equal(week.heatmap.find(cell => cell.date === '2026-06-19')?.delayed, 1);
	assert.equal(week.heatmap.find(cell => cell.date === '2026-06-19')?.intensityLevel, 2);
	const month = buildJournalReviewModel(notes, settings, { range: 'month', now });
	assert.equal(month.retrospectiveCount, 1);
	assert.equal(month.heatmap.length, 30);
	assert.equal(month.heatmap.find(cell => cell.date === '2026-06-01')?.emphasized, true);
	const phone = buildJournalReviewModel(notes, settings, { range: 'month', now, deviceKey: 'phone' });
	assert.equal(phone.edits.length, 1);
	const privateModel = buildJournalReviewModel(notes, { ...settings, privacyMode: 'timestamp-only' }, { range: 'month', now });
	assert.equal(privateModel.devices.some(device => device.label === 'Phone' || device.label === 'Laptop'), false);
});

test('journal review export requires a safe explicit Markdown path', () => {
	assert.equal(validateJournalExportPath('Reviews/June.md'), 'Reviews/June.md');
	for (const path of ['', '../outside.md', '/absolute.md', 'C:\\outside.md', '.obsidian/private.md', 'review.txt']) assert.equal(validateJournalExportPath(path), null);
	const output = journalReviewMarkdown({
		startDate: '2026-06-14', endDate: '2026-06-20', noteCount: 1, delayedCount: 1, retrospectiveCount: 0, devices: [], heatmap: [],
		edits: [{ eventId: 'a', path: 'Journal/2026-06-19.md', journalDate: '2026-06-19', editedAt: '2026-06-20T08:00:00Z', kind: 'next-day', differenceDays: 1, deviceKey: 'phone', deviceLabel: 'Device 1' }],
	}, 'Journal review');
	assert.match(output, /\[\[Journal\/2026-06-19\]\]/);
	assert.match(output, /next-day \(\+1d\)/);
});

test('old journal reminder appears once per file per session and zero disables it', () => {
	const tracker = new OldJournalNoticeTracker();
	assert.equal(tracker.shouldNotify('journal.md', 30, 30), true);
	assert.equal(tracker.shouldNotify('journal.md', 40, 30), false);
	assert.equal(tracker.shouldNotify('other.md', 100, 0), false);
});

test('knowledge freshness is transparent at review and expiry boundaries', () => {
	const now = Date.parse('2026-06-19T00:00:00Z');
	const atAge = (days: number) => new Date(now - days * 86_400_000).toISOString();
	assert.equal(evaluateKnowledgeFreshness({ timestamp: atAge(71), now, reviewAfterDays: 90, expiresAfterDays: 365 }).status, 'fresh');
	assert.equal(evaluateKnowledgeFreshness({ timestamp: atAge(72), now, reviewAfterDays: 90, expiresAfterDays: 365 }).status, 'review-soon');
	assert.equal(evaluateKnowledgeFreshness({ timestamp: atAge(90), now, reviewAfterDays: 90, expiresAfterDays: 365 }).status, 'review-due');
	assert.equal(evaluateKnowledgeFreshness({ timestamp: atAge(365), now, reviewAfterDays: 90, expiresAfterDays: 365 }).status, 'possibly-stale');
	assert.equal(evaluateKnowledgeFreshness({ reviewAfterDays: 90, expiresAfterDays: 365 }).status, 'uncertain');
	assert.equal(evaluateKnowledgeFreshness({ conflict: true, reviewAfterDays: 90, expiresAfterDays: 365 }).status, 'conflict');
});

test('knowledge dashboard builds line heatmaps, conflicts, filters, and deterministic sorts', () => {
	const now = Date.parse('2026-06-20T00:00:00Z');
	const policy = { reviewAfterDays: 30, expiresAfterDays: 365, ignore: false, source: 'settings' as const };
	const items = buildKnowledgeDashboard([
		{ path: 'Notes/conflict.md', backlinksCount: 1, policy, lineCharacterCounts: { 4: 1001 }, events: [
			event({ eventId: 'c1', deviceId: 'desktop', lineNumber: 4, editedAt: '2026-06-19T10:00:00Z' }),
			event({ eventId: 'c2', deviceId: 'phone', lineNumber: 4, editedAt: '2026-06-19T10:00:30Z' }),
		] },
		{ path: 'Notes/stale.md', backlinksCount: 2, policy, lineCharacterCounts: { 8: 5001 }, events: [event({ eventId: 's1', lineNumber: 8, editedAt: '2026-03-01T00:00:00Z', contentHash: undefined, normalizedContentHash: undefined })] },
		{ path: 'Notes/linked.md', backlinksCount: 10, policy, lineCharacterCounts: { 2: 20 }, events: [event({ eventId: 'l1', editedAt: '2026-06-19T00:00:00Z' })] },
	], now);
	const conflict = items.find(item => item.path.endsWith('conflict.md'))!;
	assert.equal(conflict.status, 'conflict');
	assert.equal(conflict.lines[0].conflict, true);
	assert.equal(conflict.lines[0].intensityLevel, 3);
	const stale = items.find(item => item.path.endsWith('stale.md'))!;
	assert.equal(stale.status, 'review-due');
	assert.equal(stale.lowConfidence, true);
	assert.equal(stale.lines[0].emphasized, true);
	assert.deepEqual(filterAndSortKnowledgeDashboard(items, 'conflict', 'overdue').map(item => item.path), ['Notes/conflict.md']);
	assert.deepEqual(filterAndSortKnowledgeDashboard(items, 'low-confidence', 'overdue').map(item => item.path), ['Notes/stale.md']);
	assert.equal(filterAndSortKnowledgeDashboard(items, 'all', 'backlinks')[0].path, 'Notes/linked.md');
});

test('text heat metrics ignore Markdown formatting and use ten 500-character levels', () => {
	const markdown = ['---', 'date: 2026-06-20', '---', '# Heading', '**bold** [label](https://example.com)', '![[image.png]]', '<span>文字</span>', '`code` ^block-id'].join('\n');
	assert.equal(countTextCharacters(markdown), 22);
	assert.deepEqual(countTextCharactersByLine('abc\n中文'), { 1: 3, 2: 2 });
	assert.deepEqual(heatIntensity(0), { level: 0, emphasized: false });
	assert.deepEqual(heatIntensity(500), { level: 1, emphasized: false });
	assert.deepEqual(heatIntensity(501), { level: 2, emphasized: false });
	assert.deepEqual(heatIntensity(5000), { level: 10, emphasized: false });
	assert.deepEqual(heatIntensity(5001), { level: 10, emphasized: true });
});

test('normal mode preserves 1.3 display while journal and knowledge modes add transparent labels', () => {
	const t = createTranslator('en');
	const info = { text: 'Edited 2 days ago', source: 'local' as const, confidence: 'high' as const, tooltip: 'base', timestamp: '2026-06-17T08:00:00Z' };
	assert.deepEqual(applyDocumentModeDisplay(info, { mode: 'normal', modeReason: 'default' }, DEFAULT_SETTINGS, t), { ...info, documentMode: 'normal' });
	const journal = applyDocumentModeDisplay(info, { mode: 'journal', modeReason: 'journal-date', journalDate: '2026-06-17' }, { ...DEFAULT_SETTINGS, journalTimezoneOffsetMinutes: 0 }, t, Date.parse('2026-06-19T00:00:00Z'));
	assert.equal(journal.text, 'Edited 2 days ago');
	assert.equal(journal.modeLabel, 'Same-day entry');
	const nextDay = applyDocumentModeDisplay({ ...info, timestamp: '2026-06-18T08:00:00Z' }, { mode: 'journal', modeReason: 'journal-date', journalDate: '2026-06-17' }, { ...DEFAULT_SETTINGS, journalTimezoneOffsetMinutes: 0 }, t, Date.parse('2026-06-19T00:00:00Z'));
	assert.equal(nextDay.modeLabel, 'Added the next day');
	assert.equal(nextDay.text, 'Edited 2 days ago');
	assert.equal(applyDocumentModeDisplay(info, {
		mode: 'knowledge', modeReason: 'folder', reviewPolicy: { reviewAfterDays: 1, expiresAfterDays: 365, ignore: false, source: 'settings' },
	}, DEFAULT_SETTINGS, t, Date.parse('2026-06-19T08:00:00Z')).modeLabel, 'Review due');
});

test('Obsidian Git weak integration imports no private module or isomorphic-git bundle', () => {
	const source = ['src/main.ts', 'src/settings.ts', 'src/git-blame-service.ts']
		.map(path => readFileSync(path, 'utf8')).join('\n');
	assert.doesNotMatch(source, /from\s+['"](?:obsidian-git|isomorphic-git)|require\(['"](?:obsidian-git|isomorphic-git)/);
	assert.doesNotMatch(readFileSync('src/main.ts', 'utf8'), /\bapp\.plugins\b|\.plugins\?\./);
});

test('sync metadata directory rejects absolute, traversal, empty, and Obsidian config paths', () => {
	for (const path of ['', '.', '..', '../outside', 'safe/../outside', '/absolute', 'C:', 'C:\\absolute', '.obsidian/plugins/data']) {
		assert.equal(validateSyncMetadataDir(path).valid, false, `${path} should be rejected`);
	}
	assert.deepEqual(validateSyncMetadataDir('sync\\line-history'), {
		valid: true,
		normalized: 'sync/line-history',
	});
});

test('non-repository fallback includes actionable Git guidance', () => {
	const git = { state: 'not-repository' as const, record: null };
	assert.match(gitStateGuidance(git) ?? '', /initialize Git in the Vault folder/);
	const result = applyDisplayPolicy({
		memory: null, local: null, sync: null, git,
		fileMtime: Date.parse('2026-06-18T11:00:00.000Z'), now: Date.parse('2026-06-18T12:00:00.000Z'),
	}, { ...DEFAULT_SETTINGS });
	assert.doesNotMatch(result.text, /hover for setup/);
	assert.match(result.tooltip, /Local and synchronized edit tracking continues to work without Git/);
});

test('machine-specific Git and device settings never enter Vault plugin data', () => {
	const runtime = {
		...DEFAULT_SETTINGS,
		gitExecutablePath: 'C:\\Tools\\Git\\git.exe',
		gitRepositoryPath: 'D:\\Private\\KnowledgeRepo',
		deviceId: 'desktop-private',
		deviceName: 'Private Laptop',
		devicePlatform: 'desktop' as const,
		deviceCreatedAt: '2026-06-18T00:00:00.000Z',
		localSequence: 42,
		timestampFontFamily: 'Microsoft YaHei',
		timestampPlacement: 'status-bar' as const,
		timestampLanguage: 'zh-CN' as const,
		hideMetadataFolder: false,
		defaultDocumentMode: 'journal' as const,
		journalModeFolders: ['Daily'],
		knowledgeModeFolders: ['Notes'],
		enableDocumentModes: false,
		trustedSigningKeyIds: ['private-key-id'],
		revokedSigningKeyIds: ['revoked-key-id'],
		contentHashKey: 'local-secret-key',
	};
	const vaultData = settingsForVaultData(runtime);
	const serialized = JSON.stringify(vaultData);
	assert.doesNotMatch(serialized, /Private|KnowledgeRepo|Tools/);
	for (const localKey of [
		'gitExecutablePath', 'gitRepositoryPath', 'deviceId', 'deviceName',
		'devicePlatform', 'deviceCreatedAt', 'localSequence', 'trustedSigningKeyIds', 'revokedSigningKeyIds', 'contentHashKey',
	]) assert.equal(Object.hasOwn(vaultData, localKey), false, `${localKey} must be absent from Vault data`);
	assert.equal(vaultData.timestampFontFamily, 'Microsoft YaHei');
	assert.equal(vaultData.timestampPlacement, 'status-bar');
	assert.equal(vaultData.timestampLanguage, 'zh-CN');
	assert.equal(vaultData.hideMetadataFolder, false);
	assert.equal(vaultData.defaultDocumentMode, 'journal');
	assert.deepEqual(vaultData.journalModeFolders, ['Daily']);
	assert.equal(vaultData.enableDocumentModes, false);
	const local = localDeviceStateFromSettings(runtime);
	const restored = mergeStoredSettings(vaultData, local);
	assert.equal(restored.gitRepositoryPath, runtime.gitRepositoryPath);
	assert.equal(restored.deviceId, runtime.deviceId);
	assert.equal(restored.localSequence, 42);
	assert.deepEqual(restored.trustedSigningKeyIds, ['private-key-id']);
	assert.equal(restored.contentHashKey, 'local-secret-key');
	assert.equal(restored.hideMetadataFolder, false);
	assert.deepEqual(restored.knowledgeModeFolders, ['Notes']);
});
