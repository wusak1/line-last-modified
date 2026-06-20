import type {
	DisplayInfo,
	DisplaySource,
	EventMatch,
	GitLineResult,
	LineLastModifiedSettings,
} from './types';
import { absoluteTime } from './utils';
import { createTranslator, type TranslationKey } from './i18n';

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

function localizedRelativeTime(timestamp: string | number, now: number, t: Translate): string {
	const value = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
	if (!Number.isFinite(value)) return t('relativeUnknown');
	const delta = now - value;
	if (delta < -60_000) return t('relativeFuture');
	if (delta < 60_000) return t('relativeJustNow');
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) return t('relativeMinutes', { count: minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t(hours === 1 ? 'relativeHour' : 'relativeHours', { count: hours });
	const days = Math.floor(hours / 24);
	if (days < 7) return t(days === 1 ? 'relativeYesterday' : 'relativeDays', { count: days });
	const weeks = Math.floor(days / 7);
	if (days < 30) return t(weeks === 1 ? 'relativeWeek' : 'relativeWeeks', { count: weeks });
	const months = Math.floor(days / 30);
	if (days < 365) return t(months === 1 ? 'relativeMonth' : 'relativeMonths', { count: months });
	const years = Math.floor(days / 365);
	return t(years === 1 ? 'relativeYear' : 'relativeYears', { count: years });
}

function localizedDisplayTime(timestamp: string | number, settings: LineLastModifiedSettings, now: number, t: Translate): string {
	if (settings.displayMode === 'absolute') return absoluteTime(timestamp);
	const relative = localizedRelativeTime(timestamp, now, t);
	if (settings.displayMode === 'both') return `${relative} (${absoluteTime(timestamp)})`;
	if (settings.absoluteTimeAfter > 0) {
		const value = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
		const unit = settings.absoluteTimeAfterUnit === 'hours' ? 3_600_000 : 86_400_000;
		if (Number.isFinite(value) && now - value >= settings.absoluteTimeAfter * unit) return absoluteTime(timestamp);
	}
	return relative;
}

export interface DisplayPolicyInput {
	memory: EventMatch | null;
	local: EventMatch | null;
	sync: EventMatch | null;
	git: GitLineResult;
	fileMtime?: number;
	metadataLastScanAt?: string;
	now?: number;
}

function eventDisplay(match: EventMatch, source: 'memory' | 'local' | 'sync', settings: LineLastModifiedSettings, now: number, t: Translate): DisplayInfo {
	const event = match.event;
	let suffix = '';
	if (match.potentialConflict) suffix = ` · ${t('displayPossibleConflict')}`;
	else if (match.timeUncertain) suffix = settings.privacyMode === 'timestamp-only' ? ` · ${t('displayTimeUncertain')}` : ` · ${source === 'sync' ? t('displaySynced') : t('displayLocal')} · ${t('displayTimeUncertain')}`;
	else if (settings.privacyMode !== 'timestamp-only') {
		if (source === 'memory') suffix = ` · ${t('displayLocal')}`;
		else if (source === 'local' && settings.showUncommittedLabel) suffix = ` · ${t('displayUncommitted')}`;
		else if (source === 'sync') {
			suffix = settings.privacyMode === 'full' && settings.showDeviceName && event.deviceName
				? ` · ${t('displayFromDevice', { device: event.deviceName })}`
				: ` · ${t('displaySynced')}`;
		}
	}
	const tooltip = [
		t('displayEditedAt', { time: absoluteTime(event.editedAt) }),
		t('displaySourceDetail', { source: source === 'sync' ? t('displaySourceSynced') : source === 'memory' ? t('displaySourceMemory') : t('displaySourceLocalLog') }),
		t('displayMatchDetail', { reason: match.reason, confidence: match.confidence }),
	];
	if (settings.privacyMode === 'full' && settings.showDeviceName && event.deviceName) tooltip.push(t('displayDeviceDetail', { device: event.deviceName }));
	if (match.potentialConflict) {
		tooltip.push(t('displayConflictDetail'));
		for (const nearby of match.nearbyEvents.slice(0, 3)) {
			const label = settings.privacyMode === 'full' && nearby.deviceName ? nearby.deviceName : t('displayAnotherDevice');
			tooltip.push(t('displayNearbyEdit', { device: label, time: absoluteTime(nearby.editedAt) }));
		}
	}
	if (match.timeUncertain) tooltip.push(t('displayClockWarning'));
	if (match.verificationStatus) tooltip.push(t('displayVerificationDetail', { status: t(`verification_${match.verificationStatus}` as TranslationKey) }));
	return {
		text: `${t('displayEdited', { time: localizedDisplayTime(event.editedAt, settings, now, t) })}${suffix}`,
		source,
		timestamp: event.editedAt,
		deviceName: settings.privacyMode === 'full' ? event.deviceName : undefined,
		confidence: match.timeUncertain ? 'low' : match.confidence,
		tooltip: settings.showTooltipDetails ? tooltip.join('\n') : t('displayEdited', { time: absoluteTime(event.editedAt) }),
		potentialConflict: match.potentialConflict,
		timeUncertain: match.timeUncertain,
		verificationStatus: match.verificationStatus,
	};
}

function gitDisplay(git: GitLineResult, settings: LineLastModifiedSettings, now: number, t: Translate): DisplayInfo | null {
	const record = git.record;
	if (!record) return null;
	if (record.uncommitted) {
		return {
			text: `${t('displayEdited', { time: localizedDisplayTime(record.authorTime, settings, now, t) })}${settings.showUncommittedLabel ? ` · ${t('displayUncommitted')}` : ''}`,
			source: 'git',
			timestamp: record.authorTime,
			confidence: 'medium',
			tooltip: t('displayGitUncommitted'),
		};
	}
	let suffix = '';
	if (settings.privacyMode !== 'timestamp-only' && settings.showAuthor && record.authorName) suffix += ` · ${record.authorName}`;
	if (settings.privacyMode !== 'timestamp-only' && settings.showCommitHash) suffix += ` · ${record.commitHash.slice(0, 8)}`;
	const tooltip = [
		t('displayCommittedAt', { time: absoluteTime(record.authorTime) }),
		t('displaySourceDetail', { source: git.fromSyncedCache ? t('displaySourceGitCache') : t('displaySourceGit') }),
	];
	if (settings.privacyMode === 'full' && settings.showAuthor) tooltip.push(t('displayAuthorDetail', { author: record.authorName }));
	if (settings.showCommitHash) tooltip.push(t('displayCommitDetail', { commit: record.commitHash }));
	if (record.summary) tooltip.push(t('displaySummaryDetail', { summary: record.summary }));
	if (git.cacheGeneratedAt) tooltip.push(t('displayCacheDetail', { time: absoluteTime(git.cacheGeneratedAt), device: git.cacheDeviceName ? t('displayByDevice', { device: git.cacheDeviceName }) : '' }));
	return {
		text: `${t('displayCommitted', { time: localizedDisplayTime(record.authorTime, settings, now, t) })}${suffix}`,
		source: 'git',
		timestamp: record.authorTime,
		authorName: settings.privacyMode === 'full' ? record.authorName : undefined,
		commitHash: settings.showCommitHash ? record.commitHash : undefined,
		summary: record.summary,
		confidence: git.fromSyncedCache ? 'medium' : 'high',
		tooltip: settings.showTooltipDetails ? tooltip.join('\n') : t('displayCommitted', { time: absoluteTime(record.authorTime) }),
	};
}

function gitStateLabel(git: GitLineResult, t: Translate): string {
	switch (git.state) {
		case 'mobile': return t('displayGitMobile');
		case 'unavailable': return t('displayGitUnavailable');
		case 'not-repository': return t('displayGitNoRepo');
		case 'untracked': return t('displayGitUntracked');
		case 'error': return t('displayGitError');
		case 'disabled': return t('displayGitDisabled');
		default: return t('displayNoHistory');
	}
}

export function gitStateGuidance(git: GitLineResult, t: Translate = createTranslator('en')): string | null {
	switch (git.state) {
		case 'not-repository':
			return t('displayGuideNoRepo');
		case 'untracked':
			return t('displayGuideUntracked');
		case 'unavailable':
			return t('displayGuideUnavailable');
		case 'mobile':
			return t('displayGuideMobile');
		case 'error':
			return t('displayGuideError');
		default:
			return null;
	}
}

export function applyDisplayPolicy(input: DisplayPolicyInput, settings: LineLastModifiedSettings, t: Translate = createTranslator('en')): DisplayInfo {
	const now = input.now ?? Date.now();
	if (input.memory) return eventDisplay(input.memory, 'memory', settings, now, t);
	if (input.local) return eventDisplay(input.local, 'local', settings, now, t);
	if (input.sync) return eventDisplay(input.sync, 'sync', settings, now, t);
	const git = gitDisplay(input.git, settings, now, t);
	if (git) return git;
	const stateLabel = gitStateLabel(input.git, t);
	const guidance = gitStateGuidance(input.git, t);
	if (input.fileMtime) {
		const timestamp = new Date(input.fileMtime).toISOString();
		const textSuffix = input.git.state === 'ok' ? '' : ` · ${stateLabel}`;
		const details = [t('displayFileModifiedAt', { time: absoluteTime(input.fileMtime) }), t('displayFallbackReason', { reason: stateLabel })];
		if (input.git.detail) details.push(input.git.detail);
		if (guidance) details.push(guidance);
		if (input.metadataLastScanAt) details.push(t('displayMetadataScanned', { time: absoluteTime(input.metadataLastScanAt) }));
		return {
			text: `${t('displayFileModified', { time: localizedDisplayTime(input.fileMtime, settings, now, t) })}${textSuffix}`,
			source: 'filesystem',
			timestamp,
			confidence: 'low',
			tooltip: settings.showTooltipDetails ? details.join('\n') : stateLabel,
		};
	}
	const source: DisplaySource = input.git.state === 'error' ? 'error' : 'none';
	return {
		text: stateLabel,
		source,
		confidence: 'low',
		tooltip: [input.git.detail, guidance].filter(Boolean).join('\n') || stateLabel,
	};
}
