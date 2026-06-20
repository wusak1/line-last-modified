export type KnowledgeRelationKind = 'backlink' | 'embed' | 'heading' | 'block';

export interface KnowledgeImpactNote {
	path: string;
	lastChangedAt?: string;
	backlinksCount: number;
}

export interface KnowledgeRelation {
	sourcePath: string;
	targetPath: string;
	kind: KnowledgeRelationKind;
}

export interface KnowledgeImpactTask {
	affectedPath: string;
	changedPath: string;
	relation: KnowledgeRelationKind;
	changedAt: string;
	affectedAt?: string;
	lagDays: number | null;
	priority: number;
	reason: 'target-newer' | 'affected-time-unknown';
}

const RELATION_WEIGHT: Record<KnowledgeRelationKind, number> = { backlink: 1, heading: 2, block: 3, embed: 4 };

export function buildKnowledgeImpactTasks(notes: KnowledgeImpactNote[], relations: KnowledgeRelation[]): KnowledgeImpactTask[] {
	const byPath = new Map(notes.map(note => [note.path, note]));
	const unique = new Map<string, KnowledgeImpactTask>();
	for (const relation of relations) {
		if (relation.sourcePath === relation.targetPath) continue;
		const affected = byPath.get(relation.sourcePath);
		const changed = byPath.get(relation.targetPath);
		if (!affected || !changed?.lastChangedAt) continue;
		const changedTime = Date.parse(changed.lastChangedAt);
		const affectedTime = affected.lastChangedAt ? Date.parse(affected.lastChangedAt) : Number.NaN;
		if (Number.isFinite(affectedTime) && affectedTime >= changedTime) continue;
		const lagDays = Number.isFinite(affectedTime) ? Math.max(0, (changedTime - affectedTime) / 86_400_000) : null;
		const priority = RELATION_WEIGHT[relation.kind] * 100 + Math.min(99, Math.floor(lagDays ?? 99)) + Math.min(50, affected.backlinksCount);
		const task: KnowledgeImpactTask = {
			affectedPath: affected.path, changedPath: changed.path, relation: relation.kind,
			changedAt: changed.lastChangedAt, affectedAt: affected.lastChangedAt, lagDays, priority,
			reason: Number.isFinite(affectedTime) ? 'target-newer' : 'affected-time-unknown',
		};
		const key = `${task.affectedPath}\u0000${task.changedPath}`;
		const previous = unique.get(key);
		if (!previous || task.priority > previous.priority) unique.set(key, task);
	}
	return [...unique.values()].sort((a, b) => b.priority - a.priority || a.affectedPath.localeCompare(b.affectedPath));
}
