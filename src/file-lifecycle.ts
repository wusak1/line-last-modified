import type { FileLifecycleEvent, HistoryEvent, LineEditEvent } from './types';
import { compareHistoryEvents } from './hybrid-clock';

export interface FileLineage {
	activeByPath: Map<string, string>;
	pathsByIncarnation: Map<string, Set<string>>;
	deletedIncarnations: Set<string>;
	renameConflicts: Map<string, FileLifecycleEvent[]>;
}

export function buildFileLineage(events: HistoryEvent[]): FileLineage {
	const activeByPath = new Map<string, string>();
	const pathsByIncarnation = new Map<string, Set<string>>();
	const deletedIncarnations = new Set<string>();
	const renameConflicts = new Map<string, FileLifecycleEvent[]>();
	const ordered = [...events].sort(compareHistoryEvents);
	const renamesByIncarnation = new Map<string, FileLifecycleEvent[]>();
	for (const event of ordered) {
		if (event.eventType !== 'rename') continue;
		const values = renamesByIncarnation.get(event.fileIncarnationId) ?? [];
		values.push(event);
		renamesByIncarnation.set(event.fileIncarnationId, values);
	}
	for (const event of ordered) {
		const incarnation = event.fileIncarnationId;
		if (!incarnation) continue;
		const paths = pathsByIncarnation.get(incarnation) ?? new Set<string>();
		paths.add(event.filePath);
		if ('previousPath' in event && event.previousPath) paths.add(event.previousPath);
		pathsByIncarnation.set(incarnation, paths);
		if (event.eventType === 'delete') {
			if (activeByPath.get(event.filePath) === incarnation) activeByPath.delete(event.filePath);
			deletedIncarnations.add(incarnation);
			continue;
		}
		if (event.eventType === 'rename') {
			if (event.previousPath && activeByPath.get(event.previousPath) === incarnation) activeByPath.delete(event.previousPath);
			const competing = (renamesByIncarnation.get(incarnation) ?? []).filter(candidate =>
				candidate.eventId !== event.eventId &&
				candidate.deviceId !== event.deviceId &&
				Math.abs(compareWall(candidate, event)) < 60_000 && candidate.filePath !== event.filePath);
			if (competing.length) renameConflicts.set(incarnation, [event, ...competing]);
			activeByPath.set(event.filePath, incarnation);
			continue;
		}
		if (!deletedIncarnations.has(incarnation)) activeByPath.set(event.filePath, incarnation);
	}
	return { activeByPath, pathsByIncarnation, deletedIncarnations, renameConflicts };
}

function compareWall(a: HistoryEvent, b: HistoryEvent): number {
	const aTime = 'editedAt' in a ? a.editedAt : 'recordedAt' in a ? a.recordedAt : '';
	const bTime = 'editedAt' in b ? b.editedAt : 'recordedAt' in b ? b.recordedAt : '';
	return (Date.parse(aTime) || 0) - (Date.parse(bTime) || 0);
}

export function editEventsForPath(events: HistoryEvent[], path: string, lineage = buildFileLineage(events)): LineEditEvent[] {
	const incarnation = lineage.activeByPath.get(path);
	return events.filter((event): event is LineEditEvent => (!event.eventType || event.eventType === 'edit') &&
		(incarnation ? event.fileIncarnationId === incarnation : !event.fileIncarnationId && event.filePath === path));
}
