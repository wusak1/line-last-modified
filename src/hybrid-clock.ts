import type { HistoryEvent, HybridLogicalClock } from './types';

export const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;

export function clampRemoteWallTime(wallTime: number, now = Date.now()): number {
	if (!Number.isFinite(wallTime)) return now;
	return Math.min(wallTime, now + MAX_CLOCK_AHEAD_MS);
}

export class HybridClock {
	private wallTime = 0;
	private logical = 0;

	constructor(private readonly nodeId: string, private readonly now: () => number = Date.now) {}

	next(observed?: HybridLogicalClock): HybridLogicalClock {
		const physical = this.now();
		const remoteWall = observed ? clampRemoteWallTime(observed.wallTime, physical) : 0;
		const wall = Math.max(physical, this.wallTime, remoteWall);
		if (wall === this.wallTime && wall === remoteWall && observed) this.logical = Math.max(this.logical, observed.logical) + 1;
		else if (wall === this.wallTime) this.logical += 1;
		else if (wall === remoteWall && observed) this.logical = observed.logical + 1;
		else this.logical = 0;
		this.wallTime = wall;
		return { wallTime: wall, logical: this.logical, nodeId: this.nodeId };
	}

	observe(value: HybridLogicalClock): void {
		this.next(value);
	}
}

export function eventClock(event: HistoryEvent): HybridLogicalClock {
	if (event.hlc) return event.hlc;
	const timestamp = 'editedAt' in event ? event.editedAt :
		'reviewedAt' in event ? event.reviewedAt :
		'resolvedAt' in event ? event.resolvedAt : event.recordedAt;
	return { wallTime: Date.parse(timestamp) || 0, logical: event.localSequence, nodeId: event.deviceId };
}

export function compareHistoryEvents(a: HistoryEvent, b: HistoryEvent, now = Date.now()): number {
	const left = eventClock(a);
	const right = eventClock(b);
	const leftWall = clampRemoteWallTime(left.wallTime, now);
	const rightWall = clampRemoteWallTime(right.wallTime, now);
	if (leftWall !== rightWall) return leftWall - rightWall;
	if (left.logical !== right.logical) return left.logical - right.logical;
	if (left.nodeId !== right.nodeId) return left.nodeId.localeCompare(right.nodeId);
	return a.eventId.localeCompare(b.eventId);
}
