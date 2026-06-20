import type { Confidence, DisplaySource, EventVerificationStatus } from './types';
import type { KnowledgeFreshness } from './knowledge-policy';

export interface PublicLineHistory {
	path: string;
	lineNumber: number;
	selected: { timestamp?: string; source: DisplaySource; confidence: Confidence; conflict: boolean; timeUncertain: boolean };
	candidates: Array<{ timestamp: string; source: 'memory' | 'local' | 'sync'; confidence: Confidence; conflict: boolean; deviceName?: string; verificationStatus?: EventVerificationStatus }>;
}

export interface PublicFileFreshness {
	path: string;
	status: KnowledgeFreshness | 'not-knowledge';
	ageDays: number | null;
	lastEditedAt?: string;
	lastReviewedAt?: string;
}

export interface PublicJournalClassification {
	path: string;
	state: 'same-day' | 'next-day' | 'delayed' | 'retrospective' | 'prewrite' | 'uncertain' | 'not-journal';
	daysFromJournal: number | null;
}

export interface LineLastModifiedPublicApi {
	version: 1;
	getLineHistory(path: string, lineNumber: number): Promise<PublicLineHistory | null>;
	getFileFreshness(path: string): PublicFileFreshness;
	getJournalClassification(path: string): PublicJournalClassification;
	getReviewDue(): PublicFileFreshness[];
	getConflictState(path: string, lineNumber: number): Promise<{ conflict: boolean; resolved: boolean } | null>;
}

export function sanitizePublicCandidate(candidate: {
	timestamp: string; source: 'memory' | 'local' | 'sync'; confidence: Confidence; conflict: boolean; deviceName?: string; verificationStatus?: EventVerificationStatus;
}, allowDeviceName: boolean): PublicLineHistory['candidates'][number] {
	return { timestamp: candidate.timestamp, source: candidate.source, confidence: candidate.confidence,
		conflict: candidate.conflict, deviceName: allowDeviceName ? candidate.deviceName : undefined,
		...(candidate.verificationStatus ? { verificationStatus: candidate.verificationStatus } : {}) };
}

export function safePublicVaultPath(path: string): string | null {
	const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '');
	if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
	const parts = normalized.split('/');
	if (parts.some(part => !part || part === '.' || part === '..')) return null;
	return normalized;
}
