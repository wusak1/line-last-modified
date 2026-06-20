import type { Confidence, EventMatch, LineEditEvent, LineQuery } from './types';
import { buildLineHashes } from './utils';
import { evaluateTimestamp } from './time-semantics';
import { compareHistoryEvents } from './hybrid-clock';

interface ScoredEvent {
	event: LineEditEvent;
	score: number;
	reason: EventMatch['reason'];
}

function scoreEvent(event: LineEditEvent, query: ReturnType<typeof buildLineHashes>): ScoredEvent | null {
	if (event.filePath !== query.filePath) return null;
	const distance = Math.abs(event.lineNumber - query.lineNumber);
	if (event.contentHash && event.contentHash === query.contentHash) {
		if (distance === 0) return { event, score: 120, reason: 'exact' };
		if (distance <= 20) return { event, score: 100 - distance, reason: 'nearby-content' };
	}
	if (event.normalizedContentHash && event.normalizedContentHash === query.normalizedContentHash && distance <= 20) {
		let context = 0;
		if (event.beforeContextHash && event.beforeContextHash === query.beforeContextHash) context++;
		if (event.afterContextHash && event.afterContextHash === query.afterContextHash) context++;
		return { event, score: 75 + context * 10 - distance, reason: 'normalized-context' };
	}
	if (distance === 0) return { event, score: 40, reason: 'line-number-only' };
	return null;
}

function confidenceFor(score: number, ambiguous: boolean): Confidence {
	if (score >= 110 && !ambiguous) return 'high';
	if (score >= 65) return 'medium';
	return 'low';
}

export function matchLineEvents(events: LineEditEvent[], query: LineQuery, now = Date.now()): EventMatch | null {
	const hashes = buildLineHashes(query);
	const scored = events.map(event => scoreEvent(event, hashes)).filter((value): value is ScoredEvent => value !== null);
	if (!scored.length) return null;
	const bestScore = Math.max(...scored.map(value => value.score));
	const relevant = scored.filter(value => value.score >= bestScore - 10);
	relevant.sort((a, b) => compareHistoryEvents(b.event, a.event, now));
	const selected = relevant[0];
	const nearbyEvents = relevant.slice(1).map(value => value.event);
	const conflicts = findPotentialConflicts(selected.event, events, query);
	const potentialConflict = conflicts.length > 0;
	const sameHashAtDifferentLines = scored.filter(value =>
		value.event.contentHash && value.event.contentHash === selected.event.contentHash && value.event.lineNumber !== selected.event.lineNumber
	).length > 0;
	return {
		event: selected.event,
		confidence: confidenceFor(selected.score, sameHashAtDifferentLines),
		reason: selected.reason,
		nearbyEvents: [...conflicts, ...nearbyEvents.filter(event => !conflicts.some(conflict => conflict.eventId === event.eventId))],
		potentialConflict,
		timeUncertain: evaluateTimestamp(selected.event.editedAt, now).clockStatus !== 'reliable',
	};
}

export function findPotentialConflicts(selected: LineEditEvent, events: LineEditEvent[], query: LineQuery): LineEditEvent[] {
	const hashes = buildLineHashes(query);
	const selectedScore = scoreEvent(selected, hashes)?.score ?? 0;
	return events
		.map(event => scoreEvent(event, hashes))
		.filter((value): value is ScoredEvent => value !== null)
		.filter(value =>
			value.event.eventId !== selected.eventId &&
			value.event.deviceId !== selected.deviceId &&
			value.score >= Math.max(40, selectedScore - 10) &&
			Math.abs(Date.parse(value.event.editedAt) - Date.parse(selected.editedAt)) < 60_000
		)
		.sort((a, b) => compareHistoryEvents(b.event, a.event))
		.map(value => value.event);
}
