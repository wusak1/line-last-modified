import type { DocumentContext, DisplayInfo, LineLastModifiedSettings } from './types';
import type { TranslationKey } from './i18n';
import { classifyJournalEdit } from './journal-policy';
import { evaluateKnowledgeFreshness } from './knowledge-policy';

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export function applyDocumentModeDisplay(
	info: DisplayInfo,
	context: DocumentContext,
	settings: LineLastModifiedSettings,
	t: Translate,
	now = Date.now(),
): DisplayInfo {
	if (!info.text || context.mode === 'off') return { ...info, documentMode: context.mode };
	if (context.mode === 'journal' && context.journalDate && info.timestamp) {
		const classification = classifyJournalEdit(
			context.journalDate, info.timestamp, settings.journalRetrospectiveAfterDays,
			settings.journalTimezoneOffsetMinutes, now,
		);
		const days = Math.abs(classification.differenceDays ?? 0);
		const labels: Record<typeof classification.kind, string> = {
			'same-day': t('journalSameDay'),
			'next-day': t('journalNextDay'), delayed: t('journalDelayed', { days }),
			retrospective: t('journalRetrospective', { days }), prewrite: t('journalPrewrite', { days }),
			uncertain: t('journalUncertain'),
		};
		return {
			...info,
			documentMode: context.mode,
			modeLabel: labels[classification.kind],
			modeState: `journal-${classification.kind}`,
			tooltip: `${info.tooltip}\n${t('journalModeReason', { label: labels[classification.kind] })}`,
		};
	}
	if (context.mode === 'knowledge' && !context.reviewPolicy?.ignore) {
		const policy = context.reviewPolicy ?? {
			reviewAfterDays: settings.knowledgeReviewAfterDays, expiresAfterDays: settings.knowledgeExpiresAfterDays,
			ignore: false, source: 'settings' as const,
		};
		const freshness = evaluateKnowledgeFreshness({
			timestamp: info.timestamp, now, reviewAfterDays: policy.reviewAfterDays,
			expiresAfterDays: policy.expiresAfterDays, timeUncertain: info.timeUncertain,
			conflict: info.potentialConflict,
		});
		const keys: Record<typeof freshness.status, TranslationKey> = {
			fresh: 'freshnessFresh', 'review-soon': 'freshnessSoon', 'review-due': 'freshnessDue',
			'possibly-stale': 'freshnessStale', uncertain: 'freshnessUncertain', conflict: 'freshnessConflict',
		};
		const label = t(keys[freshness.status]);
		const reasonKeys: Record<typeof freshness.status, TranslationKey> = {
			fresh: 'freshnessReasonFresh', 'review-soon': 'freshnessReasonSoon', 'review-due': 'freshnessReasonDue',
			'possibly-stale': 'freshnessReasonStale', uncertain: 'freshnessReasonUncertain', conflict: 'freshnessReasonConflict',
		};
		const reason = t(reasonKeys[freshness.status], {
			days: Math.floor(freshness.ageDays ?? 0), review: policy.reviewAfterDays, expires: policy.expiresAfterDays,
		});
		return {
			...info,
			documentMode: context.mode,
			modeLabel: label,
			modeState: freshness.status,
			tooltip: `${info.tooltip}\n${t('freshnessReason', { label, reason })}`,
		};
	}
	return { ...info, documentMode: context.mode };
}
