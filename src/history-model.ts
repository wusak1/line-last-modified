import type { EventMatch, LineHistorySnapshot, LineLastModifiedSettings, ResolutionEvent } from './types';

export interface HistoryCandidateView {
	id: string;
	source: 'memory' | 'local' | 'sync';
	timestamp: string;
	matchReason: EventMatch['reason'];
	confidence: EventMatch['confidence'];
	deviceName?: string;
	conflict: boolean;
	timeUncertain: boolean;
	verificationStatus?: EventMatch['verificationStatus'];
}

export interface HistoryPanelModel {
	selectedText: string;
	selectedSource: string;
	selectedConfidence: string;
	candidates: HistoryCandidateView[];
	git?: { timestamp: string; commit?: string; author?: string; cacheGeneratedAt?: string };
	fileMtime?: string;
	lastScanAt?: string;
	resolutions: Array<{ id: string; strategy: ResolutionEvent['strategy']; chosenEventId?: string; resolvedAt: string; resolvedEventIds: string[] }>;
}

export function buildHistoryPanelModel(snapshot: LineHistorySnapshot, settings: LineLastModifiedSettings, resolutions: ResolutionEvent[] = []): HistoryPanelModel {
	const candidates: HistoryCandidateView[] = [];
	const seen = new Set<string>();
	const add = (source: HistoryCandidateView['source'], match: EventMatch | null) => {
		if (!match) return;
		for (const event of [match.event, ...match.nearbyEvents]) {
			if (seen.has(event.eventId)) continue;
			seen.add(event.eventId);
			candidates.push({
				id: event.eventId, source, timestamp: event.editedAt,
				matchReason: event.eventId === match.event.eventId ? match.reason : 'line-number-only',
				confidence: event.eventId === match.event.eventId ? match.confidence : 'low',
				deviceName: settings.privacyMode === 'full' ? event.deviceName : undefined,
				conflict: match.potentialConflict, timeUncertain: match.timeUncertain,
				verificationStatus: event.eventId === match.event.eventId ? match.verificationStatus : undefined,
			});
		}
	};
	add('memory', snapshot.memory);
	add('local', snapshot.local);
	add('sync', snapshot.sync);
	candidates.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
	const record = snapshot.git.record;
	return {
		selectedText: snapshot.selected.text,
		selectedSource: snapshot.selected.source,
		selectedConfidence: snapshot.selected.confidence,
		candidates,
		git: record ? {
			timestamp: record.authorTime,
			commit: settings.showCommitHash ? record.commitHash : undefined,
			author: settings.privacyMode === 'full' && settings.showAuthor ? record.authorName : undefined,
			cacheGeneratedAt: snapshot.git.cacheGeneratedAt,
		} : undefined,
		fileMtime: snapshot.fileMtime ? new Date(snapshot.fileMtime).toISOString() : undefined,
		lastScanAt: snapshot.metadata.lastScanAt,
		resolutions: resolutions.map(value => ({ id: value.eventId, strategy: value.strategy, chosenEventId: value.chosenEventId, resolvedAt: value.resolvedAt, resolvedEventIds: value.resolvedEventIds })),
	};
}
