import type { ResolvedDocumentMode } from './types';
import { countTextCharacters } from './text-metrics';

export interface LocalInsightNote {
	path: string;
	mode: ResolvedDocumentMode;
	content: string;
	lastChangedAt?: string;
	freshness?: 'fresh' | 'review-soon' | 'review-due' | 'possibly-stale' | 'uncertain' | 'conflict';
}

export interface LocalInsights {
	periodDays: 7 | 30;
	changedNotes: number;
	skippedNotes: number;
	visibleCharacters: number;
	topTopics: Array<{ topic: string; count: number; evidence: 'heading' | 'tag' | 'link' }>;
	newTopics: string[];
	journalThemes: Array<{ topic: string; count: number }>;
	knowledgeRisks: Array<{ path: string; status: string; reason: string }>;
	explanation: string;
}

interface TopicEvidence { topic: string; evidence: 'heading' | 'tag' | 'link' }

export function buildLocalInsights(notes: LocalInsightNote[], periodDays: 7 | 30, now = Date.now(), skippedNotes = 0): LocalInsights {
	const cutoff = now - periodDays * 86_400_000;
	const recent = notes.filter(note => !note.lastChangedAt || Date.parse(note.lastChangedAt) >= cutoff);
	const midpoint = now - periodDays * 86_400_000 / 2;
	const earlierTopics = countTopics(recent.filter(note => !note.lastChangedAt || Date.parse(note.lastChangedAt) < midpoint));
	const laterTopics = countTopics(recent.filter(note => !!note.lastChangedAt && Date.parse(note.lastChangedAt) >= midpoint));
	const allTopics = countTopics(recent);
	const topTopics = [...allTopics.values()].sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic)).slice(0, 12);
	const newTopics = [...laterTopics.values()].filter(value => !earlierTopics.has(value.topic) && value.count >= 1)
		.sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic)).slice(0, 8).map(value => value.topic);
	const journalCounts = countTopics(recent.filter(note => note.mode === 'journal'));
	const journalThemes = [...journalCounts.values()].sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic)).slice(0, 8)
		.map(({ topic, count }) => ({ topic, count }));
	const knowledgeRisks = notes.filter(note => note.mode === 'knowledge' &&
		(note.freshness === 'review-due' || note.freshness === 'possibly-stale' || note.freshness === 'conflict'))
		.map(note => ({ path: note.path, status: note.freshness as string,
			reason: note.freshness === 'conflict' ? 'conflicting history evidence' : `deterministic freshness status: ${note.freshness}` }));
	return {
		periodDays, changedNotes: recent.length, skippedNotes, visibleCharacters: recent.reduce((sum, note) => sum + countTextCharacters(note.content), 0),
		topTopics, newTopics, journalThemes, knowledgeRisks,
		explanation: `Computed locally from headings, hashtags, wikilinks, visible character counts, timestamps, and deterministic freshness rules. No model or network request was used.${skippedNotes ? ` ${skippedNotes} unreadable note(s) were skipped.` : ''}`,
	};
}

function countTopics(notes: LocalInsightNote[]): Map<string, { topic: string; count: number; evidence: TopicEvidence['evidence'] }> {
	const result = new Map<string, { topic: string; count: number; evidence: TopicEvidence['evidence'] }>();
	for (const note of notes) for (const evidence of extractTopics(note.content)) {
		const key = evidence.topic.toLocaleLowerCase();
		const current = result.get(key);
		if (current) current.count += 1;
		else result.set(key, { ...evidence, count: 1 });
	}
	return result;
}

function extractTopics(content: string): TopicEvidence[] {
	const values: TopicEvidence[] = [];
	for (const line of content.split(/\r?\n/)) {
		const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)?.[1]?.replace(/[*_`]/g, '').trim();
		if (heading) values.push({ topic: heading.slice(0, 80), evidence: 'heading' });
		for (const match of line.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)) values.push({ topic: `#${match[2]}`, evidence: 'tag' });
		for (const match of line.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) values.push({ topic: match[1].trim(), evidence: 'link' });
	}
	return values;
}
