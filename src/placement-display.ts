import type { DisplayInfo } from './types';

const PREFIXES = ['Edited ', 'Committed ', 'File modified ', '编辑于 ', '提交于 ', '文件修改于 '];

export function compactGutterLabel(info: DisplayInfo): string {
	let label = info.text.split(' · ')[0].trim();
	for (const prefix of PREFIXES) {
		if (label.startsWith(prefix)) { label = label.slice(prefix.length).trim(); break; }
	}
	return label || info.modeLabel || '◷';
}
