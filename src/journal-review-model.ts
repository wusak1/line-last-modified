import { classifyJournalEdit, type JournalEditKind } from './journal-policy';
import type { LineEditEvent, LineLastModifiedSettings } from './types';
import { heatIntensity } from './text-metrics';

export type JournalReviewRange = 'week' | 'month';

export interface JournalReviewNoteInput {
	path: string;
	journalDate: string;
	events: LineEditEvent[];
	characterCount: number;
}

export interface JournalReviewOptions {
	range: JournalReviewRange;
	deviceKey?: string;
	now?: number;
}

export interface JournalReviewEdit {
	eventId: string;
	path: string;
	journalDate: string;
	editedAt: string;
	kind: JournalEditKind;
	differenceDays: number | null;
	deviceKey: string;
	deviceLabel: string;
}

export interface JournalHeatCell {
	date: string;
	delayed: number;
	retrospective: number;
	total: number;
	characterCount: number;
	intensityLevel: number;
	emphasized: boolean;
}

export interface JournalReviewModel {
	startDate: string;
	endDate: string;
	noteCount: number;
	delayedCount: number;
	retrospectiveCount: number;
	devices: Array<{ key: string; label: string }>;
	edits: JournalReviewEdit[];
	heatmap: JournalHeatCell[];
}

function dayNumber(timestamp: number, timezoneOffsetMinutes: number): number {
	return Math.floor((timestamp + timezoneOffsetMinutes * 60_000) / 86_400_000);
}

function dayString(day: number): string {
	return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function buildJournalReviewModel(
	notes: JournalReviewNoteInput[],
	settings: LineLastModifiedSettings,
	options: JournalReviewOptions,
): JournalReviewModel {
	const now = options.now ?? Date.now();
	const endDay = dayNumber(now, settings.journalTimezoneOffsetMinutes);
	const span = options.range === 'week' ? 7 : 30;
	const startDay = endDay - span + 1;
	const deviceIds = [...new Set(notes.flatMap(note => note.events.map(event => event.deviceId)))].sort();
	const deviceLabels = new Map(deviceIds.map((id, index) => [id, settings.privacyMode === 'full'
		? notes.flatMap(note => note.events).find(event => event.deviceId === id)?.deviceName || `Device ${index + 1}`
		: `Device ${index + 1}`]));
	const edits: JournalReviewEdit[] = [];
	for (const note of notes) {
		const noteDay = Math.floor(Date.parse(`${note.journalDate}T00:00:00Z`) / 86_400_000);
		if (!Number.isFinite(noteDay) || noteDay < startDay || noteDay > endDay) continue;
		for (const event of note.events) {
			if (options.deviceKey && event.deviceId !== options.deviceKey) continue;
			const classification = classifyJournalEdit(
				note.journalDate, event.editedAt, settings.journalRetrospectiveAfterDays,
				settings.journalTimezoneOffsetMinutes, now,
			);
			edits.push({
				eventId: event.eventId, path: note.path, journalDate: note.journalDate,
				editedAt: event.editedAt, kind: classification.kind,
				differenceDays: classification.differenceDays, deviceKey: event.deviceId,
				deviceLabel: deviceLabels.get(event.deviceId) ?? 'Device',
			});
		}
	}
	edits.sort((a, b) => Date.parse(b.editedAt) - Date.parse(a.editedAt));
	const heatmap: JournalHeatCell[] = [];
	for (let day = startDay; day <= endDay; day++) {
		const date = dayString(day);
		const values = edits.filter(edit => edit.journalDate === date);
		const delayed = values.filter(edit => edit.kind === 'next-day' || edit.kind === 'delayed').length;
		const retrospective = values.filter(edit => edit.kind === 'retrospective').length;
		const characterCount = notes.filter(note => note.journalDate === date).reduce((sum, note) => sum + note.characterCount, 0);
		const intensity = heatIntensity(characterCount);
		heatmap.push({ date, delayed, retrospective, total: delayed + retrospective, characterCount, intensityLevel: intensity.level, emphasized: intensity.emphasized });
	}
	return {
		startDate: dayString(startDay), endDate: dayString(endDay),
		noteCount: new Set(edits.map(edit => edit.path)).size,
		delayedCount: edits.filter(edit => edit.kind === 'next-day' || edit.kind === 'delayed').length,
		retrospectiveCount: edits.filter(edit => edit.kind === 'retrospective').length,
		devices: deviceIds.map(key => ({ key, label: deviceLabels.get(key) ?? 'Device' })),
		edits, heatmap,
	};
}

export function journalReviewMarkdown(model: JournalReviewModel, title: string): string {
	const lines = [
		`# ${title}`,
		'',
		`${model.startDate} – ${model.endDate}`,
		'',
		`- Notes: ${model.noteCount}`,
		`- Delayed additions: ${model.delayedCount}`,
		`- Later revisions: ${model.retrospectiveCount}`,
		'',
		'| Journal | Edit time | Classification | Device |',
		'|---|---|---|---|',
	];
	for (const edit of model.edits) lines.push(`| [[${edit.path.replace(/\.md$/i, '')}]] | ${edit.editedAt} | ${edit.kind}${edit.differenceDays === null ? '' : ` (${edit.differenceDays >= 0 ? '+' : ''}${edit.differenceDays}d)`} | ${edit.deviceLabel} |`);
	return `${lines.join('\n')}\n`;
}

export function validateJournalExportPath(raw: string): string | null {
	const path = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
	if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || !path.toLowerCase().endsWith('.md')) return null;
	const parts = path.split('/');
	if (parts.some(part => !part || part === '.' || part === '..') || parts[0].toLowerCase() === '.obsidian') return null;
	return path;
}
