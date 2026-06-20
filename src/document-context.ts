import type { DocumentContext, DocumentMode, LineLastModifiedSettings, ResolvedDocumentMode } from './types';
import { normalizeVaultPath } from './utils';
import { parseDayDuration } from './knowledge-policy';

export interface DocumentContextInput {
	filePath: string;
	frontmatter?: Record<string, unknown>;
	settings: LineLastModifiedSettings;
	dailyNotesFolder?: string;
	dailyNotesFormat?: string;
}

function validMode(value: unknown): DocumentMode | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	return normalized === 'auto' || normalized === 'knowledge' || normalized === 'journal' || normalized === 'off'
		? normalized : null;
}

function strictDate(value: unknown): string | undefined {
	const text = value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === 'string' ? value.trim() : '';
	const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
	if (!match) return undefined;
	const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
	return date.toISOString().slice(0, 10) === `${match[1]}-${match[2]}-${match[3]}` ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function dateFromFilename(filePath: string, format: string): string | undefined {
	const name = normalizeVaultPath(filePath).split('/').pop()?.replace(/\.md$/i, '') ?? '';
	const tokenPattern = /(YYYY|MM|DD)/g;
	const tokens: string[] = [];
	let source = '^';
	let offset = 0;
	let match: RegExpExecArray | null;
	while ((match = tokenPattern.exec(format)) !== null) {
		source += format.slice(offset, match.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		source += match[1] === 'YYYY' ? '(\\d{4})' : '(\\d{2})';
		tokens.push(match[1]);
		offset = match.index + match[1].length;
	}
	if (tokens.length !== 3 || new Set(tokens).size !== 3) return undefined;
	source += format.slice(offset).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
	const values = name.match(new RegExp(source));
	if (!values) return undefined;
	const parts: Record<string, string> = {};
	tokens.forEach((token, index) => { parts[token] = values[index + 1]; });
	return strictDate(`${parts.YYYY}-${parts.MM}-${parts.DD}`);
}

function folderMatch(filePath: string, settings: LineLastModifiedSettings): ResolvedDocumentMode | null {
	const path = normalizeVaultPath(filePath);
	const candidates: Array<{ folder: string; mode: ResolvedDocumentMode; priority: number }> = [];
	for (const [folders, mode, priority] of [
		[settings.offModeFolders, 'off', 3],
		[settings.journalModeFolders, 'journal', 2],
		[settings.knowledgeModeFolders, 'knowledge', 1],
	] as const) {
		for (const raw of folders) {
			const folder = normalizeVaultPath(raw);
			if (folder && (path === folder || path.startsWith(`${folder}/`))) candidates.push({ folder, mode, priority });
		}
	}
	candidates.sort((a, b) => b.folder.length - a.folder.length || b.priority - a.priority);
	return candidates[0]?.mode ?? null;
}

export function resolveDocumentContext(input: DocumentContextInput): DocumentContext {
	if (!input.settings.enableDocumentModes) return { mode: 'normal', modeReason: 'default' };
	const finish = (context: DocumentContext): DocumentContext => {
		if (context.mode !== 'knowledge') return context;
		const hasOverride = input.frontmatter?.review_after !== undefined || input.frontmatter?.expires_after !== undefined || input.frontmatter?.freshness_ignore !== undefined;
		const reviewAfterDays = parseDayDuration(input.frontmatter?.review_after, input.settings.knowledgeReviewAfterDays);
		return {
			...context,
			reviewPolicy: {
				reviewAfterDays,
				expiresAfterDays: Math.max(reviewAfterDays, parseDayDuration(input.frontmatter?.expires_after, input.settings.knowledgeExpiresAfterDays)),
				ignore: input.frontmatter?.freshness_ignore === true,
				source: hasOverride ? 'frontmatter' : 'settings',
			},
		};
	};
	const frontmatterMode = validMode(input.frontmatter?.line_history_mode);
	if (frontmatterMode && frontmatterMode !== 'auto') return finish({ mode: frontmatterMode, modeReason: 'frontmatter' });
	const folderMode = folderMatch(input.filePath, input.settings);
	if (folderMode) return finish({ mode: folderMode, modeReason: 'folder' });
	for (const field of input.settings.journalDateFields) {
		const journalDate = strictDate(input.frontmatter?.[field]);
		if (journalDate) return finish({ mode: 'journal', modeReason: 'journal-date', journalDate, journalDateSource: 'frontmatter' });
	}
	const dailyFolder = normalizeVaultPath(input.dailyNotesFolder ?? '');
	const path = normalizeVaultPath(input.filePath);
	const isDailyFolder = !!dailyFolder && (path === dailyFolder || path.startsWith(`${dailyFolder}/`));
	const journalDate = dateFromFilename(input.filePath, isDailyFolder ? input.dailyNotesFormat ?? input.settings.journalFilenameFormat : input.settings.journalFilenameFormat);
	if (journalDate) return finish({
		mode: 'journal', modeReason: 'journal-date', journalDate,
		journalDateSource: isDailyFolder ? 'daily-notes' : 'filename',
	});
	const fallback = input.settings.defaultDocumentMode;
	return finish({ mode: fallback === 'auto' ? 'normal' : fallback, modeReason: 'default' });
}
