import type { GitBlameRecord } from './types';
import { hashLine, hashNormalizedLine } from './utils';

const HEADER = /^([0-9a-f^]{40,64})\s+(\d+)\s+(\d+)(?:\s+(\d+))?$/i;

export function parseGitBlamePorcelain(output: string, filePath: string): Map<number, GitBlameRecord> {
	const records = new Map<number, GitBlameRecord>();
	const lines = output.split(/\r?\n/);
	let index = 0;
	while (index < lines.length) {
		const header = HEADER.exec(lines[index]);
		if (!header) {
			index++;
			continue;
		}
		const commitHash = header[1].replace(/^\^/, '');
		const lineNumber = Number(header[3]);
		const metadata: Record<string, string> = {};
		index++;
		while (index < lines.length && !lines[index].startsWith('\t') && !HEADER.test(lines[index])) {
			const separator = lines[index].indexOf(' ');
			if (separator > 0) metadata[lines[index].slice(0, separator)] = lines[index].slice(separator + 1);
			index++;
		}
		const content = index < lines.length && lines[index].startsWith('\t') ? lines[index].slice(1) : '';
		if (index < lines.length && lines[index].startsWith('\t')) index++;
		const epochSeconds = Number(metadata['author-time']);
		const uncommitted = /^0+$/.test(commitHash);
		records.set(lineNumber, {
			filePath,
			lineNumber,
			commitHash,
			authorName: metadata.author || (uncommitted ? 'Not Committed Yet' : 'Unknown'),
			authorEmail: metadata['author-mail']?.replace(/^<|>$/g, ''),
			authorTime: Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : new Date(0).toISOString(),
			authorTimezone: metadata['author-tz'],
			summary: metadata.summary,
			source: 'git',
			uncommitted,
			rawContent: content,
			contentHash: hashLine(content),
			normalizedContentHash: hashNormalizedLine(content),
		});
	}
	for (const [lineNumber, record] of records) {
		record.beforeContextHash = records.get(lineNumber - 1)?.normalizedContentHash;
		record.afterContextHash = records.get(lineNumber + 1)?.normalizedContentHash;
	}
	return records;
}
