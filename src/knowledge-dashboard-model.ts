import { evaluateKnowledgeFreshness, type KnowledgeFreshness } from './knowledge-policy';
import type { LineEditEvent, ReviewPolicy } from './types';
import { heatIntensity } from './text-metrics';
import { compareHistoryEvents } from './hybrid-clock';

export interface KnowledgeDashboardNoteInput {
	path: string;
	events: LineEditEvent[];
	backlinksCount: number;
	policy: ReviewPolicy;
	lineCharacterCounts: Record<number, number>;
	lastReviewedAt?: string;
}

export interface KnowledgeLineHeatCell {
	lineNumber: number;
	lastEditedAt?: string;
	ageDays: number | null;
	status: KnowledgeFreshness;
	conflict: boolean;
	confidence: 'high' | 'low';
	characterCount: number;
	intensityLevel: number;
	emphasized: boolean;
}

export interface KnowledgeDashboardItem {
	path: string;
	status: KnowledgeFreshness;
	ageDays: number | null;
	overdueDays: number | null;
	backlinksCount: number;
	conflict: boolean;
	lowConfidence: boolean;
	lines: KnowledgeLineHeatCell[];
	lastEditedAt?: string;
	lastReviewedAt?: string;
}

export type KnowledgeDashboardFilter = 'all' | 'stale' | 'conflict' | 'low-confidence';
export type KnowledgeDashboardSort = 'overdue' | 'backlinks';

function hasLineConflict(events: LineEditEvent[]): boolean {
	const sorted = [...events].sort((a, b) => Date.parse(a.editedAt) - Date.parse(b.editedAt));
	for (let index = 1; index < sorted.length; index++) {
		const previous = sorted[index - 1];
		const current = sorted[index];
		if (previous.deviceId !== current.deviceId && Math.abs(Date.parse(current.editedAt) - Date.parse(previous.editedAt)) <= 60_000) return true;
	}
	return false;
}

export function buildKnowledgeDashboard(notes: KnowledgeDashboardNoteInput[], now = Date.now()): KnowledgeDashboardItem[] {
	return notes.map(note => {
		const byLine = new Map<number, LineEditEvent[]>();
		for (const event of note.events) {
			const values = byLine.get(event.lineNumber) ?? [];
			values.push(event);
			byLine.set(event.lineNumber, values);
		}
		const lineNumbers = new Set([...byLine.keys(), ...Object.keys(note.lineCharacterCounts).map(Number)]);
		const lines = [...lineNumbers].map((lineNumber): KnowledgeLineHeatCell => {
			const events = byLine.get(lineNumber) ?? [];
			const latest = events.reduce<LineEditEvent | null>((best, value) => !best || compareHistoryEvents(value, best, now) > 0 ? value : best, null);
			const conflict = hasLineConflict(events);
			const result = evaluateKnowledgeFreshness({
				timestamp: latest?.editedAt, conflict, now,
				reviewAfterDays: note.policy.reviewAfterDays, expiresAfterDays: note.policy.expiresAfterDays,
			});
			const characterCount = note.lineCharacterCounts[lineNumber] ?? 0;
			const intensity = heatIntensity(characterCount);
			return {
				lineNumber, lastEditedAt: latest?.editedAt, ageDays: result.ageDays, status: result.status,
				conflict, confidence: latest?.contentHash || latest?.normalizedContentHash ? 'high' : 'low',
				characterCount, intensityLevel: intensity.level, emphasized: intensity.emphasized,
			};
		}).sort((a, b) => a.lineNumber - b.lineNumber);
		const latest = note.events.reduce<LineEditEvent | null>((best, value) => !best || compareHistoryEvents(value, best, now) > 0 ? value : best, null);
		const conflict = lines.some(line => line.conflict);
		const freshnessTimestamp = note.lastReviewedAt && (!latest || Date.parse(note.lastReviewedAt) > Date.parse(latest.editedAt)) ? note.lastReviewedAt : latest?.editedAt;
		const freshness = evaluateKnowledgeFreshness({
			timestamp: freshnessTimestamp, conflict, now,
			reviewAfterDays: note.policy.reviewAfterDays, expiresAfterDays: note.policy.expiresAfterDays,
		});
		return {
			path: note.path, status: freshness.status, ageDays: freshness.ageDays,
			overdueDays: freshness.ageDays === null ? null : Math.max(0, Math.floor(freshness.ageDays - note.policy.reviewAfterDays)),
			backlinksCount: note.backlinksCount, conflict,
			lowConfidence: !latest || lines.some(line => line.confidence === 'low'), lines,
			lastEditedAt: latest?.editedAt, lastReviewedAt: note.lastReviewedAt,
		};
	});
}

export function filterAndSortKnowledgeDashboard(
	items: KnowledgeDashboardItem[], filter: KnowledgeDashboardFilter, sort: KnowledgeDashboardSort,
): KnowledgeDashboardItem[] {
	const filtered = items.filter(item => filter === 'all' ||
		(filter === 'stale' && (item.status === 'review-due' || item.status === 'possibly-stale')) ||
		(filter === 'conflict' && item.conflict) ||
		(filter === 'low-confidence' && item.lowConfidence));
	return [...filtered].sort((a, b) => sort === 'backlinks'
		? b.backlinksCount - a.backlinksCount || (b.overdueDays ?? -1) - (a.overdueDays ?? -1) || a.path.localeCompare(b.path)
		: (b.overdueDays ?? -1) - (a.overdueDays ?? -1) || b.backlinksCount - a.backlinksCount || a.path.localeCompare(b.path));
}
