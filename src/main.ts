import { Transaction } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import {
	MarkdownView,
	getLanguage,
	Notice,
	Platform,
	Plugin,
	TAbstractFile,
	TFile,
} from 'obsidian';
import { DisplayResolver } from './display-resolver';
import { resolveDocumentContext } from './document-context';
import { createLineTimestampExtension, refreshLineTimestampEffect } from './editor-extension';
import { GitBlameService } from './git-blame-service';
import { GitInitModal } from './git-init-modal';
import { SyncMetadataService } from './metadata-service';
import { LineLastModifiedSettingTab } from './settings';
import {
	LOCAL_DEVICE_STATE_KEY,
	localDeviceStateFromSettings,
	mergeStoredSettings,
	settingsForVaultData,
} from './settings-storage';
import type {
	DeviceInfo,
	DevicePlatform,
	DisplayInfo,
	DocumentContext,
	GitOnboardingStatus,
	LineLastModifiedSettings,
	LineQuery,
	PluginData,
} from './types';
import { DEFAULT_SETTINGS } from './types';
import { createTranslator, resolveTimestampLanguage } from './i18n';
import { applyDocumentModeDisplay } from './mode-display';
import { classifyJournalEdit, journalAgeDays, OldJournalNoticeTracker } from './journal-policy';
import { evaluateKnowledgeFreshness } from './knowledge-policy';
import { safePublicVaultPath, sanitizePublicCandidate, type LineLastModifiedPublicApi, type PublicFileFreshness, type PublicJournalClassification, type PublicLineHistory } from './public-api';
import { buildKnowledgeDashboard, type KnowledgeDashboardNoteInput } from './knowledge-dashboard-model';
import { KnowledgeDashboardModal } from './knowledge-dashboard-modal';
import { HistoryPanelModal } from './history-panel';
import { buildHistoryPanelModel } from './history-model';
import { JournalReviewModal } from './journal-review-modal';
import { PrivacyAuditModal } from './privacy-audit-modal';
import { KnowledgeImpactModal } from './knowledge-impact-modal';
import { buildKnowledgeImpactTasks, type KnowledgeImpactNote, type KnowledgeRelation, type KnowledgeRelationKind } from './knowledge-impact-model';
import { JournalMigrationModal } from './journal-migration-modal';
import { buildJournalMigrationCandidates, type JournalMigrationNote } from './journal-migration-model';
import { JournalProtectionTracker, LocalJournalSnapshotStore } from './journal-snapshot-store';
import { JournalSnapshotModal } from './journal-snapshot-modal';
import { buildLocalInsights, type LocalInsightNote } from './local-insights-model';
import { LocalInsightsModal } from './local-insights-modal';
import { DeviceTrustManager } from './device-trust';
import { DeviceTrustModal } from './device-trust-modal';
import { MeaningfulEditGate } from './edit-threshold';
import type { JournalReviewNoteInput } from './journal-review-model';
import { countTextCharacters, countTextCharactersByLine } from './text-metrics';
import {
	defaultDeviceName,
	isPathExcluded,
	normalizeVaultPath,
	safeId,
	timestampFontFamily,
	timestampFontSizePx,
	validateSyncMetadataDir,
} from './utils';

const DATA_VERSION = 5;
const GIT_INIT_CONFIRMATION_KEY = 'line-last-modified-git-init-confirmation-v1';
export type SettingsChangeScope = 'display' | 'git' | 'metadata';

export default class LineLastModifiedPlugin extends Plugin {
	api!: LineLastModifiedPublicApi;
	settings: LineLastModifiedSettings = { ...DEFAULT_SETTINGS };
	private metadata!: SyncMetadataService;
	private git!: GitBlameService;
	private resolver!: DisplayResolver;
	private saveTimer: number | undefined;
	private reloadTimer: number | undefined;
	private editorRefreshTimer: number | undefined;
	private metadataFolderStyle: HTMLStyleElement | null = null;
	private statusBarItem!: HTMLElement;
	private oldJournalNotices = new OldJournalNoticeTracker();
	private journalProtection = new JournalProtectionTracker();
	private journalSnapshots = new LocalJournalSnapshotStore();
	private deviceTrust = new DeviceTrustManager();
	private meaningfulEdits = new MeaningfulEditGate();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.ensureDeviceIdentity();
		if (this.settings.enableDeviceTrust) await this.deviceTrust.initialize(this.settings.deviceId);
		this.metadata = new SyncMetadataService({
			app: this.app,
			settings: () => this.settings,
			device: () => this.deviceInfo(),
			nextSequence: () => this.nextSequence(),
			onStateChanged: () => this.scheduleEditorRefresh(),
			signEvent: event => this.settings.enableDeviceTrust ? this.deviceTrust.sign(event) : Promise.resolve(event),
			verifyEvent: (event, device) => this.settings.enableDeviceTrust
				? this.deviceTrust.verify(event, device, new Set(this.settings.trustedSigningKeyIds), new Set(this.settings.revokedSigningKeyIds), this.settings.deviceId)
				: Promise.resolve('unsigned'),
		});
		this.api = this.createPublicApi();
		this.git = new GitBlameService(this.getVaultRoot(), Platform.isMobile, () => this.settings, this.metadata);
		this.resolver = new DisplayResolver(() => this.settings, this.metadata, this.git);
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass('llm-status-bar-item');
		this.statusBarItem.setAttribute('role', 'button');
		this.statusBarItem.tabIndex = 0;
		this.statusBarItem.hide();
		const openStatusHistory = () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file) void this.openCurrentLineHistory(view);
		};
		this.registerDomEvent(this.statusBarItem, 'click', openStatusHistory);
		this.registerDomEvent(this.statusBarItem, 'keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			openStatusHistory();
		});
		await this.metadata.initialize();
		this.updateMetadataFolderVisibility();

		this.registerEditorExtension(createLineTimestampExtension({
			settings: () => this.settings,
			getFilePath: view => this.getFilePathForEditorView(view),
			resolve: (query, lineCount) => this.resolveLine(query, lineCount),
			onDocumentChanged: (update, filePath) => this.trackDocumentChange(update, filePath),
			beforeDocumentChange: (filePath, previousContent) => this.beforeJournalDocumentChange(filePath, previousContent),
			onDisplay: (view, info) => this.updateStatusBar(view, info),
			onOpenHistory: editorView => {
				const markdownView = this.getMarkdownViewForEditorView(editorView);
				if (markdownView?.file) void this.openCurrentLineHistory(markdownView);
			},
		}));
		this.addSettingTab(new LineLastModifiedSettingTab(this.app, this));
		this.registerCommands();
		this.registerEvents();
		this.app.workspace.onLayoutReady(() => this.refreshAllEditorViews());
		console.log('Line Last Modified: loaded');
	}

	async onunload(): Promise<void> {
		if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
		if (this.reloadTimer !== undefined) window.clearTimeout(this.reloadTimer);
		if (this.editorRefreshTimer !== undefined) window.clearTimeout(this.editorRefreshTimer);
		this.metadataFolderStyle?.remove();
		await this.metadata?.flush();
		await this.persistSettings();
		console.log('Line Last Modified: unloaded');
	}

	async saveSettings(scope: SettingsChangeScope = 'display'): Promise<void> {
		const metadataPath = validateSyncMetadataDir(this.settings.syncMetadataDir);
		if (!metadataPath.valid) throw new Error(metadataPath.error);
		this.settings.syncMetadataDir = metadataPath.normalized;
		this.settings.timestampFontFamily = timestampFontFamily(this.settings);
		this.settings.timestampFontSizePx = timestampFontSizePx(this.settings);
		this.settings.absoluteTimeAfter = Number.isFinite(Number(this.settings.absoluteTimeAfter))
			? Math.max(0, Number(this.settings.absoluteTimeAfter))
			: 0;
		if (this.settings.absoluteTimeAfterUnit !== 'hours' && this.settings.absoluteTimeAfterUnit !== 'days') {
			this.settings.absoluteTimeAfterUnit = 'days';
		}
		if (!['inline', 'gutter', 'status-bar'].includes(this.settings.timestampPlacement)) this.settings.timestampPlacement = 'inline';
		if (!['auto', 'en', 'zh-CN'].includes(this.settings.timestampLanguage)) this.settings.timestampLanguage = 'auto';
		this.settings.cursorDebounceMs = Math.max(0, this.settings.cursorDebounceMs);
		this.settings.editFlushDebounceMs = Math.max(100, this.settings.editFlushDebounceMs);
		this.settings.minimumChangedCharacters = Math.max(1, Math.floor(this.settings.minimumChangedCharacters));
		this.settings.maxFileLinesForAutoBlame = Math.max(1, this.settings.maxFileLinesForAutoBlame);
		this.settings.maxEventLogSizeMB = Math.max(0.1, this.settings.maxEventLogSizeMB);
		this.settings.journalRetrospectiveAfterDays = Math.max(1, this.settings.journalRetrospectiveAfterDays);
		this.settings.oldJournalNoticeAfterDays = Math.max(0, this.settings.oldJournalNoticeAfterDays);
		this.settings.journalTimezoneOffsetMinutes = Math.max(-840, Math.min(840, this.settings.journalTimezoneOffsetMinutes));
		if (!['off', 'notice', 'confirm', 'local-snapshot'].includes(this.settings.journalHistoryProtection)) this.settings.journalHistoryProtection = 'off';
		this.settings.journalSnapshotRetentionDays = Math.max(1, this.settings.journalSnapshotRetentionDays);
		this.settings.knowledgeReviewAfterDays = Math.max(0, this.settings.knowledgeReviewAfterDays);
		this.settings.knowledgeExpiresAfterDays = Math.max(this.settings.knowledgeReviewAfterDays, this.settings.knowledgeExpiresAfterDays);
		this.settings.trustedSigningKeyIds = [...new Set(this.settings.trustedSigningKeyIds.filter(Boolean))];
		this.settings.revokedSigningKeyIds = [...new Set(this.settings.revokedSigningKeyIds.filter(Boolean))];
		if (this.settings.contentHashMode !== 'hmac-sha256') this.settings.contentHashMode = 'sha256';
		if (this.settings.enableDeviceTrust && !this.deviceTrust.currentKeyId) await this.deviceTrust.initialize(this.settings.deviceId);
		await this.persistSettings();
		if (scope === 'git' || scope === 'metadata') this.git.invalidate();
		if (scope === 'metadata') await this.metadata.initialize();
		this.updateMetadataFolderVisibility();
		this.refreshAllEditorViews();
	}

	getDiagnostics() {
		return this.metadata.getDiagnostics();
	}

	getDocumentContext(filePath: string): DocumentContext {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		const frontmatter = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
		const dailyNotes = (this.app as unknown as {
			internalPlugins?: { getPluginById?: (id: string) => { instance?: { options?: { folder?: string; format?: string } } } };
		}).internalPlugins?.getPluginById?.('daily-notes')?.instance?.options;
		return resolveDocumentContext({
			filePath,
			frontmatter,
			settings: this.settings,
			dailyNotesFolder: dailyNotes?.folder,
			dailyNotesFormat: dailyNotes?.format,
		});
	}

	async getGitOnboardingStatus(): Promise<GitOnboardingStatus> {
		const status = await this.git.getOnboardingStatus();
		const configDir = normalizeVaultPath(this.app.vault.configDir);
		const adapter = this.app.vault.adapter;
		const obsidianGitInstalled = await adapter.exists(`${configDir}/plugins/obsidian-git/manifest.json`);
		let obsidianGitEnabled = false;
		try {
			const enabled = JSON.parse(await adapter.read(`${configDir}/community-plugins.json`)) as unknown;
			obsidianGitEnabled = Array.isArray(enabled) && enabled.includes('obsidian-git');
		} catch {
			// Missing or partially written configuration means "not detected", never a plugin failure.
		}
		return { ...status, obsidianGitInstalled, obsidianGitEnabled };
	}

	async openGitInitConfirmation(): Promise<void> {
		const t = createTranslator(getLanguage());
		const assessment = await this.git.assessRepositoryInitialization();
		new GitInitModal(this.app, assessment, {
			title: t('gitInitTitle'), target: t('gitInitTarget'), safety: t('gitInitSafety'),
			nested: t('gitInitNestedWarning'), confirmNested: t('gitInitNestedConfirm'),
			cancel: t('cancel'), initialize: t('initialize'), close: t('close'),
		}, async allowNested => {
			this.app.saveLocalStorage(GIT_INIT_CONFIRMATION_KEY, {
				confirmedAt: new Date().toISOString(), targetPath: assessment.targetPath, allowNested,
			});
			const result = await this.git.initializeRepository(true, allowNested);
			new Notice(result.detail);
			this.refreshAllEditorViews();
		}).open();
	}

	async openDeviceTrust(): Promise<void> {
		const t = createTranslator(getLanguage());
		if (this.settings.enableDeviceTrust && !this.deviceTrust.currentKeyId) await this.deviceTrust.initialize(this.settings.deviceId);
		if (this.settings.enableDeviceTrust && !this.deviceTrust.currentKeyId) { new Notice(t('deviceTrustUnavailable')); return; }
		const trusted = new Set(this.settings.trustedSigningKeyIds);
		if (this.deviceTrust.currentKeyId) trusted.add(this.deviceTrust.currentKeyId);
		new DeviceTrustModal(this.app, {
			title: t('deviceTrustTitle'), threat: t('deviceTrustThreat'), empty: t('deviceTrustEmpty'), trusted: t('deviceTrusted'),
			untrusted: t('deviceUntrusted'), revoked: t('deviceRevoked'), trust: t('deviceTrustAction'), revoke: t('deviceRevokeAction'),
			rotate: t('deviceRotateKey'), rotateConfirm: t('deviceRotateConfirm'), fingerprint: t('deviceFingerprint'),
		}, this.metadata.getKnownDevices(), trusted, new Set(this.settings.revokedSigningKeyIds), async keyId => {
			this.settings.revokedSigningKeyIds = this.settings.revokedSigningKeyIds.filter(value => value !== keyId);
			this.settings.trustedSigningKeyIds = [...new Set([...this.settings.trustedSigningKeyIds, keyId])];
			await this.saveSettings('metadata');
		}, async keyId => {
			this.settings.trustedSigningKeyIds = this.settings.trustedSigningKeyIds.filter(value => value !== keyId);
			this.settings.revokedSigningKeyIds = [...new Set([...this.settings.revokedSigningKeyIds, keyId])];
			await this.saveSettings('metadata');
		}, async () => {
			try {
				await this.deviceTrust.rotate();
				await this.saveSettings('metadata');
				new Notice(t('deviceKeyRotated'));
			} catch { new Notice(t('deviceKeyRotationFailed')); }
		}).open();
	}

	generateContentHashKey(): string {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
	}

	private updateMetadataFolderVisibility(): void {
		this.metadataFolderStyle?.remove();
		this.metadataFolderStyle = null;
		if (!this.settings.hideMetadataFolder) return;
		const escapedPath = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
			? CSS.escape(normalizeVaultPath(this.settings.syncMetadataDir))
			: normalizeVaultPath(this.settings.syncMetadataDir).replace(/["\\]/g, '\\$&');
		const style = document.createElement('style');
		style.dataset.lineLastModified = 'metadata-folder-visibility';
		style.textContent = `.nav-folder[data-path="${escapedPath}"] { display: none !important; }`;
		document.head.appendChild(style);
		this.metadataFolderStyle = style;
	}

	private async loadSettings(): Promise<void> {
		const raw = await this.loadData() as Partial<PluginData> | null;
		const localState = this.app.loadLocalStorage(LOCAL_DEVICE_STATE_KEY);
		this.settings = mergeStoredSettings(raw?.settings, localState);
		if (!Number.isFinite(this.settings.journalTimezoneOffsetMinutes) || Math.abs(this.settings.journalTimezoneOffsetMinutes) > 840) {
			this.settings.journalTimezoneOffsetMinutes = -new Date().getTimezoneOffset();
		}
		const metadataPath = validateSyncMetadataDir(this.settings.syncMetadataDir);
		this.settings.syncMetadataDir = metadataPath.valid ? metadataPath.normalized : DEFAULT_SETTINGS.syncMetadataDir;
	}

	private async persistSettings(): Promise<void> {
		this.app.saveLocalStorage(LOCAL_DEVICE_STATE_KEY, localDeviceStateFromSettings(this.settings));
		const data: PluginData = { version: DATA_VERSION, settings: settingsForVaultData(this.settings) };
		await this.saveData(data);
	}

	private scheduleSettingsSave(): void {
		if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = undefined;
			void this.persistSettings();
		}, 1000);
	}

	private ensureDeviceIdentity(): void {
		const platform = this.detectPlatform();
		if (!this.settings.deviceId) this.settings.deviceId = safeId(platform === 'desktop' ? 'desktop' : 'mobile');
		if (!this.settings.deviceName) this.settings.deviceName = defaultDeviceName(platform);
		if (!this.settings.deviceCreatedAt) this.settings.deviceCreatedAt = new Date().toISOString();
		this.settings.devicePlatform = platform;
		this.scheduleSettingsSave();
	}

	private detectPlatform(): DevicePlatform {
		if (!Platform.isMobile) return 'desktop';
		return window.innerWidth >= 768 ? 'tablet' : 'mobile';
	}

	private deviceInfo(): DeviceInfo {
		return {
			deviceId: this.settings.deviceId,
			deviceName: this.settings.deviceName,
			platform: this.settings.devicePlatform,
			createdAt: this.settings.deviceCreatedAt,
			lastSeenAt: new Date().toISOString(),
			signingKeys: this.settings.enableDeviceTrust ? this.deviceTrust.signingKeys : undefined,
		};
	}

	private nextSequence(): number {
		this.settings.localSequence += 1;
		this.scheduleSettingsSave();
		return this.settings.localSequence;
	}

	private getVaultRoot(): string | null {
		const adapter = this.app.vault.adapter as typeof this.app.vault.adapter & { getBasePath?: () => string };
		return typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : null;
	}

	private createPublicApi(): LineLastModifiedPublicApi {
		return {
			version: 1,
			getLineHistory: async (path, lineNumber) => this.publicLineHistory(path, lineNumber),
			getFileFreshness: path => this.publicFileFreshness(path),
			getJournalClassification: path => this.publicJournalClassification(path),
			getReviewDue: () => this.app.vault.getMarkdownFiles().map(file => this.publicFileFreshness(file.path))
				.filter(value => value.status === 'review-due' || value.status === 'possibly-stale' || value.status === 'conflict'),
			getConflictState: async (path, lineNumber) => {
				const history = await this.publicLineHistory(path, lineNumber);
				if (!history) return null;
				return { conflict: history.selected.conflict, resolved: !history.selected.conflict && this.metadata.getResolutionsForFile(path).length > 0 };
			},
		};
	}

	private async publicLineHistory(path: string, lineNumber: number): Promise<PublicLineHistory | null> {
		const safePath = safePublicVaultPath(path);
		if (!safePath) return null;
		const file = this.app.vault.getAbstractFileByPath(normalizeVaultPath(safePath));
		if (!(file instanceof TFile) || file.extension !== 'md' || isPathExcluded(file.path, this.settings)) return null;
		const lines = (await this.app.vault.cachedRead(file)).split(/\r?\n/);
		if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > lines.length) return null;
		const query: LineQuery = { filePath: file.path, lineNumber, lineText: lines[lineNumber - 1] ?? '', beforeLine: lines[lineNumber - 2], afterLine: lines[lineNumber] };
		const snapshot = await this.resolver.explain(query, file, lines.length, this.getTimestampTranslator());
		const model = buildHistoryPanelModel(snapshot, this.settings, this.metadata.getResolutionsForFile(file.path));
		return {
			path: file.path, lineNumber,
			selected: { timestamp: snapshot.selected.timestamp, source: snapshot.selected.source, confidence: snapshot.selected.confidence,
				conflict: !!snapshot.selected.potentialConflict, timeUncertain: !!snapshot.selected.timeUncertain },
			candidates: model.candidates.map(candidate => sanitizePublicCandidate(candidate,
				this.settings.privacyMode === 'full' && this.settings.showDeviceName)),
		};
	}

	private publicFileFreshness(path: string): PublicFileFreshness {
		const safePath = safePublicVaultPath(path);
		if (!safePath) return { path: '', status: 'not-knowledge', ageDays: null };
		const normalized = normalizeVaultPath(safePath);
		const context = this.getDocumentContext(normalized);
		if (context.mode !== 'knowledge' || isPathExcluded(normalized, this.settings)) return { path: normalized, status: 'not-knowledge', ageDays: null };
		const edit = this.metadata.getLatestEventForFile(normalized);
		const review = this.metadata.getLatestReviewForFile(normalized);
		const timestamp = review && (!edit || Date.parse(review.reviewedAt) > Date.parse(edit.editedAt)) ? review.reviewedAt : edit?.editedAt;
		const policy = context.reviewPolicy ?? { reviewAfterDays: this.settings.knowledgeReviewAfterDays, expiresAfterDays: this.settings.knowledgeExpiresAfterDays };
		const result = evaluateKnowledgeFreshness({ timestamp, reviewAfterDays: policy.reviewAfterDays, expiresAfterDays: policy.expiresAfterDays });
		return { path: normalized, status: result.status, ageDays: result.ageDays, lastEditedAt: edit?.editedAt, lastReviewedAt: review?.reviewedAt };
	}

	private publicJournalClassification(path: string): PublicJournalClassification {
		const safePath = safePublicVaultPath(path);
		if (!safePath) return { path: '', state: 'not-journal', daysFromJournal: null };
		const normalized = normalizeVaultPath(safePath);
		const context = this.getDocumentContext(normalized);
		if (context.mode !== 'journal' || !context.journalDate || isPathExcluded(normalized, this.settings)) return { path: normalized, state: 'not-journal', daysFromJournal: null };
		const edit = this.metadata.getLatestEventForFile(normalized);
		if (!edit) return { path: normalized, state: 'uncertain', daysFromJournal: null };
		const result = classifyJournalEdit(context.journalDate, edit.editedAt, this.settings.journalRetrospectiveAfterDays, this.settings.journalTimezoneOffsetMinutes);
		return { path: normalized, state: result.kind, daysFromJournal: result.differenceDays };
	}

	private registerCommands(): void {
		const t = createTranslator(getLanguage());
		this.addCommand({
			id: 'toggle-line-last-modified',
			name: t('commandToggle'),
			callback: () => {
				this.settings.enabled = !this.settings.enabled;
				void this.persistSettings();
				this.refreshAllEditorViews();
				new Notice(t(this.settings.enabled ? 'noticeEnabled' : 'noticeDisabled'));
			},
		});
		this.addCommand({
			id: 'open-knowledge-review-list',
			name: t('commandKnowledgeReview'),
			callback: () => { void this.openKnowledgeReviewList(); },
		});
		this.addCommand({
			id: 'open-knowledge-impact-analysis',
			name: t('commandKnowledgeImpact'),
			callback: () => { void this.openKnowledgeImpactAnalysis(); },
		});
		this.addCommand({
			id: 'open-journal-review',
			name: t('commandJournalReview'),
			callback: () => { void this.openJournalReview(); },
		});
		this.addCommand({
			id: 'open-cross-day-journal-migrations',
			name: t('commandJournalMigrations'),
			callback: () => this.openJournalMigrations(),
		});
		this.addCommand({
			id: 'open-local-journal-snapshots',
			name: t('commandJournalSnapshots'),
			checkCallback: checking => {
				const file = this.app.workspace.getActiveFile();
				if (!file || this.getDocumentContext(file.path).mode !== 'journal') return false;
				if (!checking) void this.openLocalJournalSnapshots(file.path);
				return true;
			},
		});
		this.addCommand({ id: 'open-local-weekly-insights', name: t('commandWeeklyInsights'), callback: () => { void this.openLocalInsights(7); } });
		this.addCommand({ id: 'open-local-monthly-insights', name: t('commandMonthlyInsights'), callback: () => { void this.openLocalInsights(30); } });
		this.addCommand({
			id: 'open-current-line-history',
			name: t('commandLineHistory'),
			checkCallback: checking => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) void this.openCurrentLineHistory(view);
				return true;
			},
		});
		this.addCommand({
			id: 'mark-current-knowledge-note-reviewed',
			name: t('commandMarkReviewed'),
			checkCallback: checking => {
				const file = this.app.workspace.getActiveFile();
				if (!file || this.getDocumentContext(file.path).mode !== 'knowledge') return false;
				if (!checking) {
					this.metadata.recordReview(file.path);
					void this.metadata.flush();
					this.refreshAllEditorViews();
					new Notice(t('noticeReviewed'));
				}
				return true;
			},
		});
		this.addCommand({
			id: 'refresh-line-history',
			name: t('commandRefresh'),
			callback: async () => {
				this.git.invalidate();
				await this.metadata.reloadExternalData();
				this.refreshAllEditorViews();
				new Notice(t('noticeRefreshed'));
			},
		});
		this.addCommand({
			id: 'flush-line-history',
			name: t('commandFlush'),
			callback: async () => {
				await this.metadata.flush();
				new Notice(t('noticeFlushed'));
			},
		});
		this.addCommand({
			id: 'compact-line-history',
			name: t('commandCompact'),
			callback: async () => {
				const result = await this.metadata.compactOwnLogs();
				new Notice(t('noticeCompacted', { before: result.before, after: result.after }));
			},
		});
		this.addCommand({
			id: 'audit-synchronized-metadata-privacy',
			name: t('commandPrivacyAudit'),
			callback: async () => {
				const summary = await this.metadata.auditOwnMetadataPrivacy();
				new PrivacyAuditModal(this.app, {
					title: t('privacyAuditTitle'), summary: t('privacyAuditSummary'), warning: t('privacyAuditWarning'),
					rewrite: t('privacyAuditRewrite'), cancel: t('cancel'),
				}, summary, async () => {
					const result = await this.metadata.rewriteOwnMetadataPrivacy();
					new Notice(t('privacyAuditDone', { files: result.files, events: result.events }));
				}).open();
			},
		});
	}

	private async openCurrentLineHistory(view: MarkdownView): Promise<void> {
		if (!view.file) return;
		const cursor = view.editor.getCursor();
		const query: LineQuery = {
			filePath: view.file.path,
			lineNumber: cursor.line + 1,
			lineText: view.editor.getLine(cursor.line),
			beforeLine: cursor.line > 0 ? view.editor.getLine(cursor.line - 1) : undefined,
			afterLine: cursor.line + 1 < view.editor.lineCount() ? view.editor.getLine(cursor.line + 1) : undefined,
		};
		const timestampTranslator = this.getTimestampTranslator();
		const snapshot = await this.resolver.explain(query, view.file, view.editor.lineCount(), timestampTranslator);
		snapshot.selected = applyDocumentModeDisplay(snapshot.selected, this.getDocumentContext(view.file.path), this.settings, timestampTranslator);
		const t = createTranslator(getLanguage());
		new HistoryPanelModal(this.app, {
			title: t('historyTitle'), selected: t('historySelected'), candidates: t('historyCandidates'),
			noCandidates: t('historyNoCandidates'), git: t('historyGit'), fileFallback: t('historyFileFallback'),
			metadata: t('historyMetadata'), source: t('historySource'), match: t('historyMatch'),
			confidence: t('historyConfidence'), device: t('historyDevice'), commit: t('historyCommit'),
			lastScan: t('historyLastScan'), cacheGenerated: t('historyCacheGenerated'), conflict: t('historyConflict'),
			clockWarning: t('historyClockWarning'), resolution: t('resolutionTitle'), choose: t('resolutionChoose'),
			merge: t('resolutionMerge'), dismiss: t('resolutionDismiss'), resolved: t('resolutionResolved'), verification: t('displayVerificationDetail', { status: '' }).replace(/[:：]\s*$/, ''),
		}, buildHistoryPanelModel(snapshot, this.settings, this.metadata.getResolutionsForFile(view.file.path)), async (eventIds, strategy, chosenEventId) => {
			this.metadata.recordResolution(view.file?.path ?? query.filePath, eventIds, strategy, chosenEventId);
			await this.metadata.flush();
			this.refreshAllEditorViews();
			new Notice(t('resolutionDone'));
		}).open();
	}

	private async openKnowledgeReviewList(): Promise<void> {
		const t = createTranslator(getLanguage());
		let batch: KnowledgeDashboardNoteInput[] = [];
		const items: ReturnType<typeof buildKnowledgeDashboard> = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const context = this.getDocumentContext(file.path);
			if (context.mode !== 'knowledge' || context.reviewPolicy?.ignore) continue;
			let lineCharacterCounts: Record<number, number> = {};
			try { lineCharacterCounts = countTextCharactersByLine(await this.app.vault.cachedRead(file)); } catch { /* Keep the dashboard available when one file cannot be read. */ }
			batch.push({
				path: file.path,
				events: this.metadata.getEventsForFile(file.path),
				backlinksCount: Object.keys(this.app.metadataCache.resolvedLinks[file.path] ?? {}).length,
				policy: context.reviewPolicy as NonNullable<DocumentContext['reviewPolicy']>,
				lineCharacterCounts,
				lastReviewedAt: this.metadata.getLatestReviewForFile(file.path)?.reviewedAt,
			});
			if (batch.length >= 50) {
				items.push(...buildKnowledgeDashboard(batch));
				batch = [];
				await new Promise<void>(resolve => window.setTimeout(resolve, 0));
			}
		}
		items.push(...buildKnowledgeDashboard(batch));
		new KnowledgeDashboardModal(this.app, {
			title: t('knowledgeDashboardTitle'), search: t('knowledgeReviewSearch'), all: t('knowledgeReviewAll'),
			stale: t('knowledgeDashboardStale'), conflict: t('freshnessConflict'), lowConfidence: t('knowledgeDashboardLowConfidence'),
			sortOverdue: t('knowledgeDashboardSortOverdue'), sortBacklinks: t('knowledgeDashboardSortBacklinks'),
			empty: t('knowledgeReviewEmpty'), overdue: t('knowledgeDashboardOverdue'), backlinks: t('knowledgeDashboardBacklinks'),
			lineHeatmap: t('knowledgeDashboardLineHeatmap'), lineLabel: t('knowledgeDashboardLineLabel'),
			less: t('heatmapLess'), more: t('heatmapMore'), characterCount: t('heatmapCharacterCount'), over5000: t('heatmapOver5000'), open: t('open'),
			lastEdited: t('lastEdited'), lastReviewed: t('lastReviewed'),
			statuses: {
				fresh: t('freshnessFresh'), 'review-soon': t('freshnessSoon'), 'review-due': t('freshnessDue'),
				'possibly-stale': t('freshnessStale'), uncertain: t('freshnessUncertain'), conflict: t('freshnessConflict'),
			},
		}, items).open();
	}

	private async openKnowledgeImpactAnalysis(): Promise<void> {
		const notes: KnowledgeImpactNote[] = [];
		const relations: KnowledgeRelation[] = [];
		const knowledgePaths = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (isPathExcluded(file.path, this.settings) || this.getDocumentContext(file.path).mode !== 'knowledge') continue;
			knowledgePaths.add(file.path);
			const edit = this.metadata.getLatestEventForFile(file.path);
			const review = this.metadata.getLatestReviewForFile(file.path);
			const evidence = [edit?.editedAt, review?.reviewedAt, file.stat.mtime > 0 ? new Date(file.stat.mtime).toISOString() : undefined]
				.filter((value): value is string => !!value).sort((a, b) => Date.parse(b) - Date.parse(a));
			const lastChangedAt = evidence[0];
			const backlinksCount = Object.values(this.app.metadataCache.resolvedLinks).reduce((count, targets) => count + (targets[file.path] ?? 0), 0);
			notes.push({ path: file.path, lastChangedAt, backlinksCount });
		}
		for (const sourcePath of knowledgePaths) {
			const file = this.app.vault.getAbstractFileByPath(sourcePath);
			if (!(file instanceof TFile)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			const add = (link: string, kind: KnowledgeRelationKind) => {
				const target = this.app.metadataCache.getFirstLinkpathDest(link.split('#')[0], sourcePath);
				if (target && knowledgePaths.has(target.path) && !isPathExcluded(target.path, this.settings)) relations.push({ sourcePath, targetPath: target.path, kind });
			};
			for (const link of cache?.links ?? []) add(link.link, link.link.includes('#^') ? 'block' : link.link.includes('#') ? 'heading' : 'backlink');
			for (const embed of cache?.embeds ?? []) add(embed.link, 'embed');
		}
		const tasks = buildKnowledgeImpactTasks(notes, relations);
		const t = createTranslator(getLanguage());
		new KnowledgeImpactModal(this.app, {
			title: t('impactTitle'), empty: t('impactEmpty'), affected: t('impactAffected'), changed: t('impactChanged'),
			relation: t('impactRelation'), lag: t('impactLag'), unknown: t('impactUnknown'),
			reasonNewer: t('impactReasonNewer'), reasonUnknown: t('impactReasonUnknown'), open: t('open'),
		}, tasks).open();
	}

	private async openJournalReview(): Promise<void> {
		const notes: JournalReviewNoteInput[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const context = this.getDocumentContext(file.path);
			if (context.mode !== 'journal' || !context.journalDate) continue;
			let characterCount = 0;
			try { characterCount = countTextCharacters(await this.app.vault.cachedRead(file)); } catch { /* A read failure produces an empty cell instead of blocking the review. */ }
			notes.push({ path: file.path, journalDate: context.journalDate, events: this.metadata.getEventsForFile(file.path), characterCount });
		}
		const t = createTranslator(getLanguage());
		new JournalReviewModal(this.app, {
			title: t('journalReviewTitle'), week: t('journalReviewWeek'), month: t('journalReviewMonth'),
			allDevices: t('journalReviewAllDevices'), device: t('journalReviewDevice'), summary: t('journalReviewSummary'),
			heatmap: t('journalReviewHeatmap'), heatCell: t('journalReviewHeatCell'),
			less: t('heatmapLess'), more: t('heatmapMore'), characterCount: t('heatmapCharacterCount'), over5000: t('heatmapOver5000'), recent: t('journalReviewRecent'),
			empty: t('journalReviewEmpty'), delayed: t('journalReviewDelayed'), retrospective: t('journalReviewRetrospective'),
			open: t('open'), export: t('journalReviewExport'), exportTitle: t('journalReviewExportTitle'),
			exportPath: t('journalReviewExportPath'), exportConfirm: t('journalReviewExportConfirm'),
			exportReplace: t('journalReviewExportReplace'), exportInvalid: t('journalReviewExportInvalid'),
			exportDone: t('journalReviewExportDone'), exportFailed: t('journalReviewExportFailed'), cancel: t('cancel'),
		}, notes, this.settings).open();
	}

	private openJournalMigrations(): void {
		const notes: JournalMigrationNote[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (isPathExcluded(file.path, this.settings)) continue;
			const context = this.getDocumentContext(file.path);
			if (context.mode === 'journal' && context.journalDate) notes.push({ path: file.path, journalDate: context.journalDate, events: this.metadata.getEventsForFile(file.path) });
		}
		const t = createTranslator(getLanguage());
		new JournalMigrationModal(this.app, {
			title: t('migrationTitle'), empty: t('migrationEmpty'), possible: t('migrationPossible'), confirmed: t('migrationConfirmed'),
			from: t('migrationFrom'), to: t('migrationTo'), reason: t('migrationReason'), open: t('open'),
		}, buildJournalMigrationCandidates(notes)).open();
	}

	private async openLocalJournalSnapshots(filePath: string): Promise<void> {
		const t = createTranslator(getLanguage());
		new JournalSnapshotModal(this.app, {
			title: t('journalSnapshotsTitle'), empty: t('journalSnapshotsEmpty'), restore: t('journalSnapshotRestore'),
			confirm: t('journalSnapshotRestoreConfirm'), restored: t('journalSnapshotRestored'), missing: t('journalSnapshotMissing'), size: t('journalSnapshotSize'),
		}, await this.journalSnapshots.list(this.settings.deviceId, filePath), message => new Notice(message)).open();
	}

	private async openLocalInsights(periodDays: 7 | 30): Promise<void> {
		const t = createTranslator(getLanguage());
		if (!this.settings.enableLocalInsights) { new Notice(t('insightsDisabled')); return; }
		const notes: LocalInsightNote[] = [];
		let processed = 0;
		let skipped = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (isPathExcluded(file.path, this.settings)) continue;
			try {
				const context = this.getDocumentContext(file.path);
				const edit = this.metadata.getLatestEventForFile(file.path);
				const freshness = context.mode === 'knowledge' ? this.publicFileFreshness(file.path).status : undefined;
				notes.push({ path: file.path, mode: context.mode, content: await this.app.vault.cachedRead(file),
					lastChangedAt: edit?.editedAt ?? (file.stat.mtime > 0 ? new Date(file.stat.mtime).toISOString() : undefined),
					freshness: freshness === 'not-knowledge' ? undefined : freshness });
			} catch { skipped += 1; }
			if (++processed % 50 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
		}
		new LocalInsightsModal(this.app, {
			title: t('insightsTitle', { days: periodDays }), summary: t('insightsSummary'), topics: t('insightsTopics'),
			newTopics: t('insightsNewTopics'), journalThemes: t('insightsJournalThemes'), risks: t('insightsRisks'),
			explanation: t('insightsExplanation'), empty: t('insightsEmpty'),
		}, buildLocalInsights(notes, periodDays, Date.now(), skipped)).open();
	}

	private registerEvents(): void {
		this.registerEvent(this.app.vault.on('modify', file => this.handleVaultChange(file)));
		this.registerEvent(this.app.vault.on('create', file => this.handleVaultChange(file)));
		this.registerEvent(this.app.vault.on('delete', file => {
			if (file instanceof TFile && file.extension === 'md') {
				this.meaningfulEdits.clearFile(file.path);
				this.metadata.recordDelete(file.path);
			}
			this.handleVaultChange(file);
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile && file.extension === 'md') {
				this.meaningfulEdits.clearFile(oldPath);
				this.meaningfulEdits.clearFile(file.path);
				this.metadata.recordRename(oldPath, file.path);
			}
			this.git.invalidate(oldPath);
			this.git.invalidate(file.path);
			this.handleVaultChange(file);
		}));
		this.registerEvent(this.app.workspace.on('file-open', () => {
			void this.metadata.flush();
			this.refreshAllEditorViews();
		}));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshAllEditorViews()));
		this.registerDomEvent(window, 'beforeunload', () => { void this.metadata.flush(); });
	}

	private handleVaultChange(file: TAbstractFile): void {
		const path = normalizeVaultPath(file.path);
		if (file instanceof TFile && file.extension === 'md') {
			this.git.invalidate(path);
			this.refreshAllEditorViews();
		}
		const root = this.metadata.root;
		if (path.startsWith(`${root}/events/`) || path.startsWith(`${root}/blame-cache/`) || path.startsWith(`${root}/devices/`)) {
			if (this.reloadTimer !== undefined) window.clearTimeout(this.reloadTimer);
			this.reloadTimer = window.setTimeout(() => {
				this.reloadTimer = undefined;
				void this.metadata.reloadExternalData();
			}, 500);
		}
	}

	private async resolveLine(query: LineQuery, lineCount: number): Promise<DisplayInfo> {
		const context = this.getDocumentContext(query.filePath);
		if (context.mode === 'off') return { text: '', source: 'none', confidence: 'low', tooltip: '' };
		const file = this.app.vault.getAbstractFileByPath(query.filePath);
		const timestampTranslator = this.getTimestampTranslator();
		const info = await this.resolver.resolve(query, file instanceof TFile ? file : null, lineCount, timestampTranslator);
		return applyDocumentModeDisplay(info, context, this.settings, timestampTranslator);
	}

	private beforeJournalDocumentChange(filePath: string, previousContent: string): boolean {
		const mode = this.settings.journalHistoryProtection;
		if (mode === 'off' || this.journalProtection.has(filePath)) return true;
		const context = this.getDocumentContext(filePath);
		if (context.mode !== 'journal' || !context.journalDate) return true;
		const ageDays = journalAgeDays(context.journalDate, this.settings.journalTimezoneOffsetMinutes);
		if (ageDays === null || ageDays <= 0) return true;
		const t = createTranslator(getLanguage());
		if (mode === 'confirm' && !window.confirm(t('journalProtectionConfirm'))) return false;
		this.journalProtection.mark(filePath);
		if (mode === 'notice') new Notice(t('journalProtectionNotice'));
		if (mode === 'local-snapshot') {
			void this.journalSnapshots.save(this.settings.deviceId, filePath, previousContent, this.settings.journalSnapshotRetentionDays)
				.then(() => new Notice(t('journalSnapshotSaved')))
				.catch(() => new Notice(t('journalSnapshotFailed')));
		}
		return true;
	}

	private trackDocumentChange(update: ViewUpdate, filePath: string): void {
		const isUserEdit = update.transactions.some(transaction => {
			const event = transaction.annotation(Transaction.userEvent);
			return !!event && (
				transaction.isUserEvent('input') || transaction.isUserEvent('delete') ||
				transaction.isUserEvent('undo') || transaction.isUserEvent('redo') ||
				transaction.isUserEvent('move')
			);
		});
		if (!isUserEdit) return;
		const documentContext = this.getDocumentContext(filePath);
		if (documentContext.mode === 'off') return;
		if (documentContext.mode === 'journal' && documentContext.journalDate) {
			const age = journalAgeDays(documentContext.journalDate, this.settings.journalTimezoneOffsetMinutes);
			if (this.oldJournalNotices.shouldNotify(filePath, age, this.settings.oldJournalNoticeAfterDays)) {
				new Notice(createTranslator(getLanguage())('oldJournalNotice', { days: age as number }));
			}
		}
		this.git.invalidate(filePath);
		if (!this.settings.enableLocalEditTracking || isPathExcluded(filePath, this.settings)) return;
		const document = update.state.doc;
		const previousDocument = update.startState.doc;
		const isMove = update.transactions.some(transaction => transaction.isUserEvent('move'));
		const structuralChange = isMove || document.lines !== previousDocument.lines;
		if (structuralChange) this.meaningfulEdits.clearFile(filePath);
		const moveTransactionId = isMove ? safeId('move') : undefined;
		const record = (query: LineQuery) => {
			const accepted = this.meaningfulEdits.accept(query, this.settings.minimumChangedCharacters, structuralChange);
			if (accepted) this.metadata.recordEdit(accepted);
		};
		update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
			const isDelete = toA > fromA && toB === fromB;
			const isInsert = toA === fromA && toB > fromB;
			if (isDelete) {
				const start = previousDocument.lineAt(Math.min(fromA, previousDocument.length)).number;
				const end = previousDocument.lineAt(Math.min(Math.max(fromA, toA - 1), previousDocument.length)).number;
				for (let lineNumber = start; lineNumber <= end; lineNumber++) {
					const oldLine = previousDocument.line(lineNumber);
					record({ filePath, lineNumber, lineText: '', previousLineText: oldLine.text,
						operation: 'delete', moveTransactionId });
				}
				return;
			}
			const start = document.lineAt(Math.min(fromB, document.length)).number;
			const end = document.lineAt(Math.min(Math.max(fromB, toB ? toB - 1 : toB), document.length)).number;
			for (let lineNumber = start; lineNumber <= end; lineNumber++) {
				const line = document.line(lineNumber);
				const oldLineNumber = Math.min(previousDocument.lines, previousDocument.lineAt(Math.min(fromA, previousDocument.length)).number + (lineNumber - start));
				record({
					filePath, lineNumber, lineText: line.text,
					beforeLine: lineNumber > 1 ? document.line(lineNumber - 1).text : undefined,
					afterLine: lineNumber < document.lines ? document.line(lineNumber + 1).text : undefined,
					previousLineText: previousDocument.line(oldLineNumber).text,
					operation: isMove ? 'move' : isInsert ? 'insert' : 'edit', moveTransactionId,
				});
			}
		});
	}

	private getFilePathForEditorView(editorView: EditorView): string | null {
		return this.getMarkdownViewForEditorView(editorView)?.file?.path ?? null;
	}

	private getMarkdownViewForEditorView(editorView: EditorView): MarkdownView | null {
		let match: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves(leaf => {
			if (match || !(leaf.view instanceof MarkdownView)) return;
			const codeMirror = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
			if (codeMirror === editorView) match = leaf.view;
		});
		return match;
	}

	private getTimestampTranslator() {
		return createTranslator(resolveTimestampLanguage(this.settings.timestampLanguage, getLanguage()));
	}

	private updateStatusBar(editorView: EditorView, info: DisplayInfo | null): void {
		if (!this.statusBarItem) return;
		if (this.settings.timestampPlacement !== 'status-bar') { this.statusBarItem.hide(); return; }
		const activeFile = this.app.workspace.getActiveFile();
		const viewFilePath = this.getFilePathForEditorView(editorView);
		if (!activeFile || viewFilePath !== activeFile.path) return;
		if (!info?.text) { this.statusBarItem.hide(); return; }
		this.statusBarItem.setText(info.modeLabel ? `${info.modeLabel} · ${info.text}` : info.text);
		this.statusBarItem.setAttribute('aria-label', info.tooltip || info.text);
		this.statusBarItem.show();
	}

	private refreshAllEditorViews(): void {
		if (!this.app?.workspace) return;
		this.app.workspace.iterateAllLeaves(leaf => {
			if (!(leaf.view instanceof MarkdownView)) return;
			const codeMirror = (leaf.view.editor as unknown as { cm?: EditorView }).cm;
			if (codeMirror) codeMirror.dispatch({ effects: refreshLineTimestampEffect.of(null) });
		});
	}

	private scheduleEditorRefresh(): void {
		if (this.editorRefreshTimer !== undefined) return;
		this.editorRefreshTimer = window.setTimeout(() => {
			this.editorRefreshTimer = undefined;
			this.refreshAllEditorViews();
		}, 0);
	}
}
