import type { DisplayInfo, LineLastModifiedSettings } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function nextRelativeBoundary(timestamp: number, now: number): number | null {
	const age = now - timestamp;
	if (age < -MINUTE) return timestamp - MINUTE;
	if (age < MINUTE) return timestamp + MINUTE;
	if (age < HOUR) return timestamp + (Math.floor(age / MINUTE) + 1) * MINUTE;
	if (age < DAY) return timestamp + (Math.floor(age / HOUR) + 1) * HOUR;
	if (age < 7 * DAY) return timestamp + (Math.floor(age / DAY) + 1) * DAY;
	if (age < 30 * DAY) return timestamp + (Math.floor(age / (7 * DAY)) + 1) * 7 * DAY;
	if (age < 365 * DAY) return timestamp + (Math.floor(age / (30 * DAY)) + 1) * 30 * DAY;
	return timestamp + (Math.floor(age / (365 * DAY)) + 1) * 365 * DAY;
}

function nextCalendarMidnight(now: number, offsetMinutes: number): number {
	const shifted = now + offsetMinutes * MINUTE;
	return (Math.floor(shifted / DAY) + 1) * DAY - offsetMinutes * MINUTE;
}

export function nextTimestampRefreshDelay(
	info: DisplayInfo,
	settings: LineLastModifiedSettings,
	now = Date.now(),
): number | null {
	const timestamp = info.timestamp ? Date.parse(info.timestamp) : Number.NaN;
	const candidates: number[] = [];
	const hasRelativeText = settings.displayMode === 'relative' || settings.displayMode === 'both';
	if (hasRelativeText && Number.isFinite(timestamp)) {
		const threshold = settings.displayMode === 'relative' && settings.absoluteTimeAfter > 0
			? timestamp + settings.absoluteTimeAfter * (settings.absoluteTimeAfterUnit === 'hours' ? HOUR : DAY)
			: null;
		if (threshold === null || now < threshold) {
			const relative = nextRelativeBoundary(timestamp, now);
			if (relative !== null && relative > now) candidates.push(relative);
			if (threshold !== null && threshold > now) candidates.push(threshold);
		}
	}
	if (info.documentMode === 'journal' || info.documentMode === 'knowledge') {
		candidates.push(nextCalendarMidnight(now, settings.journalTimezoneOffsetMinutes));
	}
	if (!candidates.length) return null;
	return Math.max(250, Math.min(2_147_000_000, Math.min(...candidates) - now + 25));
}
