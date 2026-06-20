export type ClockStatus = 'reliable' | 'future' | 'invalid';

export interface TimeEvidence {
	timestamp: string;
	epochMs: number | null;
	clockStatus: ClockStatus;
}

export function evaluateTimestamp(timestamp: string, now = Date.now(), futureToleranceMs = 86_400_000): TimeEvidence {
	const epochMs = Date.parse(timestamp);
	if (!Number.isFinite(epochMs)) return { timestamp, epochMs: null, clockStatus: 'invalid' };
	return { timestamp, epochMs, clockStatus: epochMs > now + futureToleranceMs ? 'future' : 'reliable' };
}
