export interface HeatIntensity {
	level: number;
	emphasized: boolean;
}

export function countTextCharacters(markdown: string): number {
	const visibleText = markdown
		.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '')
		.replace(/^\s*```.*$/gm, '')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/!\[\[[^\]]+\]\]/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
		.replace(/\[\[([^\]]+)\]\]/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/https?:\/\/\S+/gi, '')
		.replace(/\^[\p{L}\p{N}_-]+\s*$/gmu, '');
	return Array.from(visibleText).filter(character => /[\p{L}\p{N}]/u.test(character)).length;
}

export function countTextCharactersByLine(markdown: string): Record<number, number> {
	const lines = markdown.split(/\r?\n/);
	let inFrontmatter = lines[0]?.trim() === '---';
	return Object.fromEntries(lines.map((line, index) => {
		if (inFrontmatter) {
			if (index > 0 && line.trim() === '---') inFrontmatter = false;
			return [index + 1, 0];
		}
		return [index + 1, countTextCharacters(line)];
	}));
}

export function heatIntensity(characterCount: number): HeatIntensity {
	const count = Math.max(0, Math.floor(Number.isFinite(characterCount) ? characterCount : 0));
	return {
		level: count === 0 ? 0 : Math.min(10, Math.ceil(count / 500)),
		emphasized: count > 5000,
	};
}
