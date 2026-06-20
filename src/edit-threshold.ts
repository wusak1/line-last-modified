import type { LineQuery } from './types';

export function netChangedCharacters(before: string, after: string): number {
	if (before === after) return 0;
	const left = Array.from(before);
	const right = Array.from(after);
	let prefix = 0;
	while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
	let suffix = 0;
	while (suffix < left.length - prefix && suffix < right.length - prefix &&
		left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
	return Math.max(left.length - prefix - suffix, right.length - prefix - suffix);
}

interface EditBaseline {
	text: string;
	seenAt: number;
}

export class MeaningfulEditGate {
	private baselines = new Map<string, EditBaseline>();

	accept(query: LineQuery, minimumCharacters: number, structuralChange = false): LineQuery | null {
		const key = `${query.filePath}\u0000${query.lineNumber}`;
		const minimum = Math.max(1, Math.floor(minimumCharacters));
		const existing = this.baselines.get(key);
		const baseline = existing?.text ?? query.previousLineText ?? query.lineText;
		const changed = netChangedCharacters(baseline, query.lineText);

		if (changed === 0) {
			this.baselines.delete(key);
			return null;
		}
		if (structuralChange || changed >= minimum) {
			this.baselines.delete(key);
			return { ...query, previousLineText: baseline };
		}

		this.baselines.set(key, { text: baseline, seenAt: Date.now() });
		this.prune();
		return null;
	}

	clearFile(filePath: string): void {
		for (const key of this.baselines.keys()) if (key.startsWith(`${filePath}\u0000`)) this.baselines.delete(key);
	}

	private prune(): void {
		if (this.baselines.size <= 1000) return;
		const oldest = [...this.baselines.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt).slice(0, 100);
		for (const [key] of oldest) this.baselines.delete(key);
	}
}
