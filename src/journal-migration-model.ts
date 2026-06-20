import type { LineEditEvent } from './types';

export interface JournalMigrationNote {
	path: string;
	journalDate: string;
	events: LineEditEvent[];
}

export interface JournalMigrationCandidate {
	sourcePath: string;
	sourceDate: string;
	sourceIncarnationId?: string;
	sourceLine: number;
	targetPath: string;
	targetDate: string;
	targetIncarnationId?: string;
	targetLine: number;
	contentHash: string;
	detectedAt: string;
	confidence: 'confirmed-move' | 'possible';
	reason: 'move-transaction' | 'unique-copy-delete';
}

export function buildJournalMigrationCandidates(notes: JournalMigrationNote[]): JournalMigrationCandidate[] {
	const events = notes.flatMap(note => note.events.map(event => ({ note, event })));
	const deletes = events.filter(value => value.event.operation === 'delete' && !!value.event.previousContentHash);
	const inserts = events.filter(value => (value.event.operation === 'insert' || value.event.operation === 'move') && !!value.event.contentHash);
	const deleteCounts = countHashes(deletes.map(value => value.event.previousContentHash as string));
	const insertCounts = countHashes(inserts.map(value => value.event.contentHash as string));
	const candidates: JournalMigrationCandidate[] = [];
	for (const target of inserts) {
		const hash = target.event.contentHash as string;
		const sources = deletes.filter(source => source.event.previousContentHash === hash && source.note.path !== target.note.path && source.note.journalDate !== target.note.journalDate);
		for (const source of sources) {
			const explicit = !!target.event.moveTransactionId && target.event.moveTransactionId === source.event.moveTransactionId;
			const unique = deleteCounts.get(hash) === 1 && insertCounts.get(hash) === 1;
			const delta = Math.abs(Date.parse(target.event.editedAt) - Date.parse(source.event.editedAt));
			if (!explicit && (!unique || delta > 5 * 60_000)) continue;
			candidates.push({
				sourcePath: source.note.path, sourceDate: source.note.journalDate, sourceIncarnationId: source.event.fileIncarnationId,
				sourceLine: source.event.lineNumber, targetPath: target.note.path, targetDate: target.note.journalDate,
				targetIncarnationId: target.event.fileIncarnationId, targetLine: target.event.lineNumber,
				contentHash: hash, detectedAt: target.event.editedAt,
				confidence: explicit ? 'confirmed-move' : 'possible', reason: explicit ? 'move-transaction' : 'unique-copy-delete',
			});
		}
	}
	return candidates.sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));
}

function countHashes(values: string[]): Map<string, number> {
	const result = new Map<string, number>();
	for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
	return result;
}
