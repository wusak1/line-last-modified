export type KnowledgeFreshness = 'fresh' | 'review-soon' | 'review-due' | 'possibly-stale' | 'uncertain' | 'conflict';

export interface KnowledgeFreshnessResult {
	status: KnowledgeFreshness;
	ageDays: number | null;
	reason: string;
}

export function parseDayDuration(value: unknown, fallback: number): number {
	if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
	if (typeof value !== 'string') return fallback;
	const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*d(?:ays?)?$/i);
	return match ? Number(match[1]) : fallback;
}

export function evaluateKnowledgeFreshness(input: {
	timestamp?: string;
	now?: number;
	reviewAfterDays: number;
	expiresAfterDays: number;
	timeUncertain?: boolean;
	conflict?: boolean;
}): KnowledgeFreshnessResult {
	if (input.conflict) return { status: 'conflict', ageDays: null, reason: 'Conflicting edit evidence requires review.' };
	const timestamp = input.timestamp ? Date.parse(input.timestamp) : NaN;
	if (!Number.isFinite(timestamp) || input.timeUncertain) return { status: 'uncertain', ageDays: null, reason: 'No reliable modification time is available.' };
	const ageDays = Math.max(0, ((input.now ?? Date.now()) - timestamp) / 86_400_000);
	const review = Math.max(0, input.reviewAfterDays);
	const expires = Math.max(review, input.expiresAfterDays);
	if (ageDays >= expires) return { status: 'possibly-stale', ageDays, reason: `Last reliable change is at least ${expires} days old.` };
	if (ageDays >= review) return { status: 'review-due', ageDays, reason: `Review threshold of ${review} days has been reached.` };
	if (review > 0 && ageDays >= review * 0.8) return { status: 'review-soon', ageDays, reason: `Review threshold of ${review} days is approaching.` };
	return { status: 'fresh', ageDays, reason: `Last reliable change is within the ${review}-day review window.` };
}
