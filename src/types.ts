export type DisplayMode = 'relative' | 'absolute' | 'both';
export type AbsoluteTimeAfterUnit = 'hours' | 'days';
export type TimestampPlacement = 'inline' | 'gutter' | 'status-bar';
export type TimestampLanguage = 'auto' | 'en' | 'zh-CN';
export type JournalHistoryProtection = 'off' | 'notice' | 'confirm' | 'local-snapshot';
export type PrivacyMode = 'full' | 'hide-author-device' | 'timestamp-only';
export type GitBlameMode = 'current-line' | 'whole-file-cache';
export type DevicePlatform = 'desktop' | 'mobile' | 'tablet' | 'unknown';
export type DocumentMode = 'auto' | 'knowledge' | 'journal' | 'off';
export type ResolvedDocumentMode = Exclude<DocumentMode, 'auto'> | 'normal';

export interface DocumentContext {
	mode: ResolvedDocumentMode;
	modeReason: 'frontmatter' | 'folder' | 'journal-date' | 'default';
	journalDate?: string;
	journalDateSource?: 'frontmatter' | 'filename' | 'daily-notes';
	reviewPolicy?: ReviewPolicy;
}

export interface ReviewPolicy {
	reviewAfterDays: number;
	expiresAfterDays: number;
	ignore: boolean;
	source: 'frontmatter' | 'settings';
}

export interface LineLastModifiedSettings {
	enabled: boolean;
	displayMode: DisplayMode;
	absoluteTimeAfter: number;
	absoluteTimeAfterUnit: AbsoluteTimeAfterUnit;
	timestampFontFamily: string;
	timestampFontSizePx: number;
	timestampPlacement: TimestampPlacement;
	timestampLanguage: TimestampLanguage;
	showAuthor: boolean;
	showDeviceName: boolean;
	showCommitHash: boolean;
	showUncommittedLabel: boolean;
	showTooltipDetails: boolean;
	enableGitBlame: boolean;
	gitExecutablePath: string;
	gitRepositoryPath: string;
	gitBlameMode: GitBlameMode;
	ignoreWhitespaceInBlame: boolean;
	enableLocalEditTracking: boolean;
	minimumChangedCharacters: number;
	enableSyncMetadata: boolean;
	syncMetadataDir: string;
	hideMetadataFolder: boolean;
	enableDocumentModes: boolean;
	defaultDocumentMode: DocumentMode;
	knowledgeModeFolders: string[];
	journalModeFolders: string[];
	offModeFolders: string[];
	journalDateFields: string[];
	journalFilenameFormat: string;
	journalRetrospectiveAfterDays: number;
	oldJournalNoticeAfterDays: number;
	journalTimezoneOffsetMinutes: number;
	journalHistoryProtection: JournalHistoryProtection;
	journalSnapshotRetentionDays: number;
	enableLocalInsights: boolean;
	enableDeviceTrust: boolean;
	trustedSigningKeyIds: string[];
	revokedSigningKeyIds: string[];
	contentHashMode: 'sha256' | 'hmac-sha256';
	contentHashKey: string;
	knowledgeReviewAfterDays: number;
	knowledgeExpiresAfterDays: number;
	privacyMode: PrivacyMode;
	storeLinePreview: boolean;
	storeContentHash: boolean;
	cursorDebounceMs: number;
	editFlushDebounceMs: number;
	maxFileLinesForAutoBlame: number;
	maxEventLogSizeMB: number;
	excludedFolders: string[];
	excludedFiles: string[];
	deviceId: string;
	deviceName: string;
	devicePlatform: DevicePlatform;
	deviceCreatedAt: string;
	localSequence: number;
}

export type DeviceLocalSettingKey =
	| 'gitExecutablePath'
	| 'gitRepositoryPath'
	| 'deviceId'
	| 'deviceName'
	| 'devicePlatform'
	| 'deviceCreatedAt'
	| 'localSequence'
	| 'trustedSigningKeyIds'
	| 'revokedSigningKeyIds'
	| 'contentHashKey';

export type VaultSettings = Omit<LineLastModifiedSettings, DeviceLocalSettingKey>;

export interface PluginData {
	version: number;
	settings: VaultSettings;
}

export interface DeviceInfo {
	deviceId: string;
	deviceName?: string;
	platform: DevicePlatform;
	createdAt: string;
	lastSeenAt: string;
	signingKeys?: DeviceSigningKey[];
}

export interface DeviceSigningKey {
	keyId: string;
	algorithm: 'ECDSA-P256-SHA256';
	publicKeyJwk: JsonWebKey;
	createdAt: string;
	retiredAt?: string;
}

export interface EventSignature {
	keyId: string;
	algorithm: 'ECDSA-P256-SHA256';
	value: string;
}

export type EventVerificationStatus = 'unsigned' | 'invalid' | 'revoked' | 'verified-untrusted' | 'verified-trusted';

export interface LineEditEvent {
	schemaVersion?: 1 | 2;
	eventType?: 'edit';
	eventId: string;
	deviceId: string;
	deviceName?: string;
	filePath: string;
	lineNumber: number;
	contentHash?: string;
	normalizedContentHash?: string;
	beforeContextHash?: string;
	afterContextHash?: string;
	preview?: string;
	editedAt: string;
	localSequence: number;
	source: 'local-edit';
	status: 'uncommitted' | 'synced' | 'unknown';
	fileIncarnationId?: string;
	hlc?: HybridLogicalClock;
	operation?: 'edit' | 'insert' | 'delete' | 'move';
	previousContentHash?: string;
	moveTransactionId?: string;
	signature?: EventSignature;
}

export interface HybridLogicalClock {
	wallTime: number;
	logical: number;
	nodeId: string;
}

export interface FileLifecycleEvent {
	schemaVersion: 2;
	eventType: 'rename' | 'delete';
	eventId: string;
	deviceId: string;
	deviceName?: string;
	fileIncarnationId: string;
	filePath: string;
	previousPath?: string;
	recordedAt: string;
	localSequence: number;
	hlc: HybridLogicalClock;
	signature?: EventSignature;
}

export interface ReviewEvent {
	schemaVersion: 2;
	eventType: 'review';
	eventId: string;
	deviceId: string;
	deviceName?: string;
	fileIncarnationId: string;
	filePath: string;
	reviewedAt: string;
	localSequence: number;
	hlc: HybridLogicalClock;
	signature?: EventSignature;
}

export interface ResolutionEvent {
	schemaVersion: 2;
	eventType: 'resolution';
	eventId: string;
	deviceId: string;
	deviceName?: string;
	fileIncarnationId: string;
	filePath: string;
	resolvedEventIds: string[];
	strategy: 'choose' | 'merge' | 'dismiss';
	chosenEventId?: string;
	resolvedAt: string;
	localSequence: number;
	hlc: HybridLogicalClock;
	signature?: EventSignature;
}

export type HistoryEvent = LineEditEvent | FileLifecycleEvent | ReviewEvent | ResolutionEvent;

export interface LineQuery {
	filePath: string;
	lineNumber: number;
	lineText: string;
	beforeLine?: string;
	afterLine?: string;
	operation?: LineEditEvent['operation'];
	previousLineText?: string;
	moveTransactionId?: string;
	hashKey?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface EventMatch {
	event: LineEditEvent;
	confidence: Confidence;
	reason: 'exact' | 'nearby-content' | 'normalized-context' | 'line-number-only';
	nearbyEvents: LineEditEvent[];
	potentialConflict: boolean;
	timeUncertain: boolean;
	verificationStatus?: EventVerificationStatus;
}

export interface GitBlameRecord {
	filePath: string;
	lineNumber: number;
	commitHash: string;
	authorName: string;
	authorEmail?: string;
	authorTime: string;
	authorTimezone?: string;
	summary?: string;
	source: 'git';
	uncommitted?: boolean;
	contentHash?: string;
	normalizedContentHash?: string;
	beforeContextHash?: string;
	afterContextHash?: string;
	rawContent?: string;
}

export type GitState =
	| 'ok'
	| 'disabled'
	| 'mobile'
	| 'unavailable'
	| 'not-repository'
	| 'untracked'
	| 'error';

export interface GitLineResult {
	state: GitState;
	record: GitBlameRecord | null;
	detail?: string;
	fromSyncedCache?: boolean;
	cacheGeneratedAt?: string;
	cacheDeviceName?: string;
}

export type GitRepositoryState = 'mobile' | 'unavailable' | 'none' | 'vault' | 'parent' | 'configured' | 'error';

export interface GitOnboardingStatus {
	platform: 'desktop' | 'mobile';
	nativeGitAvailable: boolean;
	repositoryState: GitRepositoryState;
	hasRemote: boolean;
	obsidianGitInstalled: boolean;
	obsidianGitEnabled: boolean;
	detail: string;
	recommendation: string;
}

export interface GitInitAssessment {
	state: 'mobile' | 'unavailable' | 'ready' | 'parent' | 'none' | 'error';
	targetPath?: string;
	canInitialize: boolean;
	requiresNestedConfirmation: boolean;
	detail: string;
}

export interface GitInitResult {
	state: 'initialized' | 'cancelled' | 'blocked' | 'error';
	detail: string;
}

export interface GitBlameCacheFile {
	version: 1 | 2;
	filePath: string;
	fileIncarnationId?: string;
	generatedAt: string;
	generatedByDeviceId: string;
	generatedByDeviceName?: string;
	headCommit: string;
	lines: Record<string, GitBlameRecord | GitBlameCacheLineV2>;
}

export interface GitBlameCacheLineV2 {
	record: GitBlameRecord;
	contentHash: string;
	normalizedContentHash: string;
	beforeContextHash?: string;
	afterContextHash?: string;
}

export type DisplaySource =
	| 'memory'
	| 'local'
	| 'sync'
	| 'git'
	| 'filesystem'
	| 'none'
	| 'error';

export interface DisplayInfo {
	text: string;
	source: DisplaySource;
	timestamp?: string;
	authorName?: string;
	deviceName?: string;
	commitHash?: string;
	summary?: string;
	confidence: Confidence;
	tooltip: string;
	potentialConflict?: boolean;
	timeUncertain?: boolean;
	modeLabel?: string;
	modeState?: string;
	documentMode?: ResolvedDocumentMode;
	verificationStatus?: EventVerificationStatus;
}

export interface LineHistorySnapshot {
	selected: DisplayInfo;
	memory: EventMatch | null;
	local: EventMatch | null;
	sync: EventMatch | null;
	git: GitLineResult;
	fileMtime?: number;
	metadata: MetadataDiagnostics;
}

export interface MetadataDiagnostics {
	rootPath: string;
	loadedEvents: number;
	pendingEvents: number;
	parseErrors: number;
	lastScanAt?: string;
	lastFlushAt?: string;
	lastError?: string;
}

export const DEFAULT_SETTINGS: LineLastModifiedSettings = {
	enabled: true,
	displayMode: 'relative',
	absoluteTimeAfter: 0,
	absoluteTimeAfterUnit: 'days',
	timestampFontFamily: 'var(--font-monospace)',
	timestampFontSizePx: 11,
	timestampPlacement: 'inline',
	timestampLanguage: 'auto',
	showAuthor: true,
	showDeviceName: true,
	showCommitHash: false,
	showUncommittedLabel: true,
	showTooltipDetails: true,
	enableGitBlame: true,
	gitExecutablePath: 'git',
	gitRepositoryPath: '',
	gitBlameMode: 'whole-file-cache',
	ignoreWhitespaceInBlame: true,
	enableLocalEditTracking: true,
	minimumChangedCharacters: 5,
	enableSyncMetadata: true,
	syncMetadataDir: 'line-last-modified',
	hideMetadataFolder: true,
	enableDocumentModes: true,
	defaultDocumentMode: 'auto',
	knowledgeModeFolders: [],
	journalModeFolders: [],
	offModeFolders: ['Templates'],
	journalDateFields: ['date', 'journal_date'],
	journalFilenameFormat: 'YYYY-MM-DD',
	journalRetrospectiveAfterDays: 7,
	oldJournalNoticeAfterDays: 30,
	journalTimezoneOffsetMinutes: 9999,
	journalHistoryProtection: 'off',
	journalSnapshotRetentionDays: 30,
	enableLocalInsights: false,
	enableDeviceTrust: false,
	trustedSigningKeyIds: [],
	revokedSigningKeyIds: [],
	contentHashMode: 'sha256',
	contentHashKey: '',
	knowledgeReviewAfterDays: 90,
	knowledgeExpiresAfterDays: 365,
	privacyMode: 'full',
	storeLinePreview: false,
	storeContentHash: true,
	cursorDebounceMs: 150,
	editFlushDebounceMs: 1500,
	maxFileLinesForAutoBlame: 5000,
	maxEventLogSizeMB: 5,
	excludedFolders: ['line-last-modified'],
	excludedFiles: [],
	deviceId: '',
	deviceName: '',
	devicePlatform: 'unknown',
	deviceCreatedAt: '',
	localSequence: 0,
};
