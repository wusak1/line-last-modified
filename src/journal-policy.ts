import { evaluateTimestamp } from './time-semantics';

export type JournalEditKind = 'same-day' | 'next-day' | 'delayed' | 'retrospective' | 'prewrite' | 'uncertain';

export interface JournalEditClassification {
	kind: JournalEditKind;
	differenceDays: number | null;
}

function dateDay(date: string): number | null {
	const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return new Date(value).toISOString().slice(0, 10) === date ? Math.floor(value / 86_400_000) : null;
}

export function classifyJournalEdit(
	journalDate: string,
	editedAt: string,
	retrospectiveAfterDays: number,
	timezoneOffsetMinutes: number,
	now = Date.now(),
): JournalEditClassification {
	const journalDay = dateDay(journalDate);
	const evidence = evaluateTimestamp(editedAt, now);
	if (journalDay === null || evidence.epochMs === null || evidence.clockStatus !== 'reliable') return { kind: 'uncertain', differenceDays: null };
	const editDay = Math.floor((evidence.epochMs + timezoneOffsetMinutes * 60_000) / 86_400_000);
	const differenceDays = editDay - journalDay;
	if (differenceDays < 0) return { kind: 'prewrite', differenceDays };
	if (differenceDays === 0) return { kind: 'same-day', differenceDays };
	if (differenceDays === 1) return { kind: 'next-day', differenceDays };
	if (differenceDays <= Math.max(1, retrospectiveAfterDays)) return { kind: 'delayed', differenceDays };
	return { kind: 'retrospective', differenceDays };
}

export function journalAgeDays(journalDate: string, timezoneOffsetMinutes: number, now = Date.now()): number | null {
	const day = dateDay(journalDate);
	return day === null ? null : Math.floor((now + timezoneOffsetMinutes * 60_000) / 86_400_000) - day;
}

export class OldJournalNoticeTracker {
	private shown = new Set<string>();

	shouldNotify(filePath: string, ageDays: number | null, thresholdDays: number): boolean {
		if (thresholdDays <= 0 || ageDays === null || ageDays < thresholdDays || this.shown.has(filePath)) return false;
		this.shown.add(filePath);
		return true;
	}
}
