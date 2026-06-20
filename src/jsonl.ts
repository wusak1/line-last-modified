export interface JsonLinesResult<T> {
	values: T[];
	errors: number;
}

export function parseJsonLines<T>(input: string, validate?: (value: unknown) => value is T): JsonLinesResult<T> {
	const values: T[] = [];
	let errors = 0;
	for (const line of input.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (validate && !validate(value)) {
				errors++;
				continue;
			}
			values.push(value as T);
		} catch {
			errors++;
		}
	}
	return { values, errors };
}

export function toJsonLines(values: unknown[]): string {
	return values.map(value => JSON.stringify(value)).join('\n') + (values.length ? '\n' : '');
}

export function deduplicateByEventId<T extends { eventId: string }>(events: T[]): T[] {
	const byId = new Map<string, T>();
	for (const event of events) byId.set(event.eventId, event);
	return [...byId.values()];
}
