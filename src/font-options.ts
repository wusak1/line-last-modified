export interface FontChoice {
	value: string;
	label: string;
}

export const OBSIDIAN_FONT_CHOICES: FontChoice[] = [
	{ value: 'var(--font-interface)', label: 'Obsidian interface font' },
	{ value: 'var(--font-text)', label: 'Obsidian text font' },
	{ value: 'var(--font-monospace)', label: 'Obsidian monospace font' },
];

export const COMMON_LOCAL_FONT_FAMILIES = [
	'Segoe UI',
	'Microsoft YaHei',
	'Microsoft JhengHei',
	'SimSun',
	'SimHei',
	'DengXian',
	'Arial',
	'Calibri',
	'Cambria',
	'Consolas',
	'Courier New',
	'Times New Roman',
	'Georgia',
	'Verdana',
	'Tahoma',
	'Inter',
	'Roboto',
	'Noto Sans',
	'Noto Sans CJK SC',
	'Noto Serif CJK SC',
	'PingFang SC',
	'Hiragino Sans GB',
	'Heiti SC',
	'Songti SC',
	'SF Pro Text',
	'Menlo',
	'Monaco',
	'Ubuntu',
	'DejaVu Sans',
	'Liberation Sans',
];

interface LocalFontData {
	family?: string;
}

interface LocalFontWindow extends Window {
	queryLocalFonts?: () => Promise<LocalFontData[]>;
}

interface CommandError extends Error {
	stderr?: string;
}

export function mergeFontFamilies(...groups: readonly (readonly string[])[]): string[] {
	const unique = new Map<string, string>();
	for (const group of groups) {
		for (const raw of group) {
			const family = raw.trim();
			if (!family) continue;
			const key = family.toLocaleLowerCase();
			if (!unique.has(key)) unique.set(key, family);
		}
	}
	return [...unique.values()].sort((left, right) => left.localeCompare(right));
}

function canvasReportsFont(fontFamily: string): boolean {
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	if (!context) return false;
	const sample = 'mmmmmmmmmmlliWW@#0123456789中文测试';
	const size = '72px';
	const baselines = ['monospace', 'sans-serif', 'serif'].map(baseline => {
		context.font = `${size} ${baseline}`;
		return context.measureText(sample).width;
	});
	return baselines.some((baselineWidth, index) => {
		const baseline = ['monospace', 'sans-serif', 'serif'][index];
		context.font = `${size} "${fontFamily.replace(/"/g, '\\"')}", ${baseline}`;
		return context.measureText(sample).width !== baselineWidth;
	});
}

export function detectCommonLocalFonts(): string[] {
	return COMMON_LOCAL_FONT_FAMILIES.filter(canvasReportsFont);
}

export function parseWindowsFontRegistry(output: string): string[] {
	return mergeFontFamilies(output.split(/\r?\n/).map(line => {
		const match = line.match(/^\s{2,}(.+?)\s{2,}REG_\w+\s{2,}/);
		return match?.[1].replace(/\s+\((?:TrueType|OpenType)\)$/i, '').trim() ?? '';
	}));
}

async function enumerateDesktopFontFamilies(): Promise<string[]> {
	try {
		const platform = (globalThis as unknown as { process?: { platform?: string } }).process?.platform;
		if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') return [];
		const runtimeRequire = typeof require === 'function'
			? require as (id: string) => unknown
			: (globalThis as unknown as { require?: (id: string) => unknown }).require;
		if (!runtimeRequire) return [];
		const childProcess = runtimeRequire('child_process') as {
			execFile: (
				file: string,
				args: string[],
				options: Record<string, unknown>,
				callback: (error: CommandError | null, stdout: string) => void,
			) => void;
		};
		const run = (file: string, args: string[]) => new Promise<string>(resolve => {
			childProcess.execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 }, (error, stdout) => {
				resolve(error ? '' : stdout);
			});
		});
		if (platform === 'win32') {
			const keys = [
				'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
				'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
			];
			const outputs = await Promise.all(keys.map(key => run('reg.exe', ['query', key])));
			return mergeFontFamilies(...outputs.map(parseWindowsFontRegistry));
		}
		if (platform === 'darwin') {
			const output = await run('system_profiler', ['SPFontsDataType', '-json']);
			if (!output) return [];
			const data = JSON.parse(output) as { SPFontsDataType?: Array<{ family?: string; typefaces?: Array<{ family?: string }> }> };
			return mergeFontFamilies((data.SPFontsDataType ?? []).flatMap(font => [
				font.family ?? '', ...(font.typefaces ?? []).map(face => face.family ?? ''),
			]));
		}
		const output = await run('fc-list', ['--format', '%{family}\n']);
		return mergeFontFamilies(output.split(/\r?\n/).flatMap(line => line.split(',')));
	} catch {
		return [];
	}
}

export async function scanLocalFontFamilies(): Promise<{ families: string[]; usedLocalFontApi: boolean }> {
	let apiFamilies: string[] = [];
	let usedLocalFontApi = false;
	const queryLocalFonts = (window as LocalFontWindow).queryLocalFonts;
	if (typeof queryLocalFonts === 'function') {
		try {
			const fonts = await queryLocalFonts.call(window);
			apiFamilies = fonts.map(font => font.family ?? '');
			usedLocalFontApi = true;
		} catch {
			// Permission denial or unsupported Electron builds fall back to OS enumeration.
		}
	}
	return {
		families: mergeFontFamilies(apiFamilies, await enumerateDesktopFontFamilies(), detectCommonLocalFonts()),
		usedLocalFontApi,
	};
}
