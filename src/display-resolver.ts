import type { TFile } from 'obsidian';
import type { GitBlameService } from './git-blame-service';
import type { SyncMetadataService } from './metadata-service';
import type { DisplayInfo, GitLineResult, LineHistorySnapshot, LineLastModifiedSettings, LineQuery } from './types';
import { applyDisplayPolicy } from './display-policy';
import { createTranslator } from './i18n';

export class DisplayResolver {
	constructor(
		private readonly settings: () => LineLastModifiedSettings,
		private readonly metadata: SyncMetadataService,
		private readonly git: GitBlameService,
	) {}

	async resolve(query: LineQuery, file: TFile | null, lineCount: number, t = createTranslator('en')): Promise<DisplayInfo> {
		const settings = this.settings();
		if (!settings.enabled) return { text: '', source: 'none', confidence: 'low', tooltip: '' };
		const history = this.metadata.findLineHistory(query);
		let gitResult: GitLineResult = { state: settings.enableGitBlame ? 'unavailable' : 'disabled', record: null };
		if (!history.memory && !history.local && !history.sync) {
			gitResult = await this.git.getLineBlame(query.filePath, query.lineNumber, lineCount);
			if (!gitResult.record) {
				const synced = this.metadata.getCachedBlame(query.filePath, query.lineNumber, query);
				if (synced) {
					gitResult = {
						state: 'ok',
						record: synced.record,
						fromSyncedCache: true,
						cacheGeneratedAt: synced.cache.generatedAt,
						cacheDeviceName: synced.cache.generatedByDeviceName,
					};
				}
			}
		}
		return applyDisplayPolicy({
			...history,
			git: gitResult,
			fileMtime: file?.stat.mtime,
			metadataLastScanAt: this.metadata.getDiagnostics().lastScanAt,
		}, settings, t);
	}

	async explain(query: LineQuery, file: TFile | null, lineCount: number, t = createTranslator('en')): Promise<LineHistorySnapshot> {
		const settings = this.settings();
		const history = this.metadata.findLineHistory(query);
		let gitResult = await this.git.getLineBlame(query.filePath, query.lineNumber, lineCount);
		if (!gitResult.record) {
			const synced = this.metadata.getCachedBlame(query.filePath, query.lineNumber, query);
			if (synced) gitResult = {
				state: 'ok', record: synced.record, fromSyncedCache: true,
				cacheGeneratedAt: synced.cache.generatedAt, cacheDeviceName: synced.cache.generatedByDeviceName,
			};
		}
		const metadata = this.metadata.getDiagnostics();
		return {
			...history,
			git: gitResult,
			fileMtime: file?.stat.mtime,
			metadata,
			selected: applyDisplayPolicy({
				...history, git: gitResult, fileMtime: file?.stat.mtime,
				metadataLastScanAt: metadata.lastScanAt,
			}, settings, t),
		};
	}
}
