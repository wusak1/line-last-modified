import { parseGitBlamePorcelain } from './git-parser';
import type { GitLineResult, GitBlameRecord, GitInitAssessment, GitInitResult, GitOnboardingStatus, LineLastModifiedSettings } from './types';
import type { SyncMetadataService } from './metadata-service';
import type { GitProvider } from './git-provider';

interface FileBlameCache {
	headCommit: string;
	records: Map<number, GitBlameRecord>;
}

interface GitCommandError extends Error {
	stderr?: string;
	code?: string | number;
}

export class GitBlameService implements GitProvider {
	private fileCache = new Map<string, FileBlameCache>();
	private headCache: { value: string; checkedAt: number } | null = null;
	private availabilityCache: { available: boolean; checkedAt: number; detail?: string } | null = null;
	private trackedCache = new Map<string, { value: boolean; checkedAt: number }>();
	private fileRequests = new Map<string, Promise<Map<number, GitBlameRecord>>>();
	private activeCurrentLineRequests = 0;
	private currentLineWaiters: Array<() => void> = [];

	constructor(
		private readonly vaultRoot: string | null,
		private readonly isMobile: boolean,
		private readonly settings: () => LineLastModifiedSettings,
		private readonly metadata: SyncMetadataService,
	) {}

	invalidate(filePath?: string): void {
		if (filePath) {
			this.fileCache.delete(filePath);
			this.trackedCache.clear();
		}
		else {
			this.fileCache.clear();
			this.headCache = null;
			this.availabilityCache = null;
			this.trackedCache.clear();
			this.fileRequests.clear();
		}
	}

	async assessRepositoryInitialization(): Promise<GitInitAssessment> {
		if (this.isMobile) return { state: 'mobile', canInitialize: false, requiresNestedConfirmation: false, detail: 'Git initialization is unavailable on mobile.' };
		if (!this.vaultRoot) return { state: 'unavailable', canInitialize: false, requiresNestedConfirmation: false, detail: 'The Vault has no desktop filesystem path.' };
		const availability = await this.isAvailable();
		if (!availability.available) return { state: 'unavailable', targetPath: this.vaultRoot, canInitialize: false, requiresNestedConfirmation: false, detail: availability.detail ?? 'Git is unavailable.' };
		try {
			const root = (await this.runExecutable(['-C', this.vaultRoot, 'rev-parse', '--show-toplevel'], false)).trim();
			const parent = !this.sameFilesystemPath(root, this.vaultRoot);
			return {
				state: parent ? 'parent' : 'ready', targetPath: this.vaultRoot,
				canInitialize: parent, requiresNestedConfirmation: parent,
				detail: parent ? 'The Vault is already inside a parent Git repository.' : 'The Vault root is already a Git repository.',
			};
		} catch (error) {
			const detail = this.errorMessage(error);
			if (/not a git repository/i.test(detail)) return { state: 'none', targetPath: this.vaultRoot, canInitialize: true, requiresNestedConfirmation: false, detail: 'No Git repository contains the Vault.' };
			return { state: 'error', targetPath: this.vaultRoot, canInitialize: false, requiresNestedConfirmation: false, detail };
		}
	}

	async initializeRepository(confirmed: boolean, allowNested = false): Promise<GitInitResult> {
		if (!confirmed) return { state: 'cancelled', detail: 'Initialization was cancelled before any Git command ran.' };
		const assessment = await this.assessRepositoryInitialization();
		if (!assessment.canInitialize || (assessment.requiresNestedConfirmation && !allowNested)) {
			return { state: 'blocked', detail: assessment.detail };
		}
		try {
			await this.runExecutable(['-C', assessment.targetPath as string, 'init'], false);
			this.invalidate();
			return { state: 'initialized', detail: 'Git repository initialized. No commit, remote, author, or credentials were created.' };
		} catch (error) {
			return { state: 'error', detail: this.errorMessage(error) };
		}
	}

	async getOnboardingStatus(): Promise<Omit<GitOnboardingStatus, 'obsidianGitInstalled' | 'obsidianGitEnabled'>> {
		if (this.isMobile) {
			return {
				platform: 'mobile', nativeGitAvailable: false, repositoryState: 'mobile', hasRemote: false,
				detail: 'Native Git commands are unavailable on mobile.',
				recommendation: 'Use synchronized edit events and desktop-generated blame caches.',
			};
		}
		if (!this.vaultRoot) {
			return {
				platform: 'desktop', nativeGitAvailable: false, repositoryState: 'unavailable', hasRemote: false,
				detail: 'This Vault does not expose a desktop filesystem path.',
				recommendation: 'Local and synchronized edit events remain available.',
			};
		}
		const availability = await this.isAvailable();
		if (!availability.available) {
			return {
				platform: 'desktop', nativeGitAvailable: false, repositoryState: 'unavailable', hasRemote: false,
				detail: availability.detail ?? 'Git executable is unavailable.',
				recommendation: 'Install Git or configure the Git executable for this device.',
			};
		}
		try {
			const root = (await this.runGit(['rev-parse', '--show-toplevel'])).trim();
			const configured = !!this.settings().gitRepositoryPath.trim();
			const repositoryState = configured ? 'configured' : this.sameFilesystemPath(root, this.vaultRoot) ? 'vault' : 'parent';
			const hasRemote = (await this.runGit(['remote'])).trim().length > 0;
			return {
				platform: 'desktop', nativeGitAvailable: true, repositoryState, hasRemote,
				detail: repositoryState === 'vault' ? 'The Vault root is a Git repository.'
					: repositoryState === 'parent' ? 'The Vault is inside a parent Git repository.'
						: 'The configured repository folder is valid.',
				recommendation: hasRemote ? 'Git history is ready.' : 'Add a remote only if cross-device Git synchronization is desired.',
			};
		} catch (error) {
			const detail = this.errorMessage(error);
			const notRepository = /not a git repository/i.test(detail);
			return {
				platform: 'desktop', nativeGitAvailable: true,
				repositoryState: notRepository ? 'none' : 'error', hasRemote: false, detail,
				recommendation: notRepository
					? 'Initialize Git manually or with Obsidian Git. This plugin will not run git init automatically.'
					: 'Check the configured executable and repository folder.',
			};
		}
	}

	async getLineBlame(filePath: string, lineNumber: number, fileLineCount: number): Promise<GitLineResult> {
		const settings = this.settings();
		if (!settings.enableGitBlame) return { state: 'disabled', record: null };
		if (this.isMobile) return { state: 'mobile', record: null, detail: 'Git commands are disabled on mobile.' };
		if (!this.vaultRoot) return { state: 'unavailable', record: null, detail: 'This vault does not expose a desktop filesystem path.' };
		const availability = await this.isAvailable();
		if (!availability.available) return { state: 'unavailable', record: null, detail: availability.detail };

		let headCommit: string;
		try {
			headCommit = await this.getHeadCommit();
		} catch (error) {
			return { state: 'not-repository', record: null, detail: this.errorMessage(error) };
		}

		let gitFilePath: string;
		try {
			gitFilePath = this.getGitFilePath(filePath);
		} catch (error) {
			return { state: 'error', record: null, detail: this.errorMessage(error) };
		}

		if (!await this.isTracked(gitFilePath)) {
			return { state: 'untracked', record: null, detail: 'The current file is not tracked by Git.' };
		}

		try {
			const shouldCacheWholeFile = settings.gitBlameMode === 'whole-file-cache' && fileLineCount <= settings.maxFileLinesForAutoBlame;
			if (shouldCacheWholeFile) {
				let cached = this.fileCache.get(filePath);
				if (!cached || cached.headCommit !== headCommit) {
					const records = await this.runFileBlame(filePath, gitFilePath);
					cached = { headCommit, records };
					this.fileCache.set(filePath, cached);
					void this.metadata.writeBlameCache(filePath, headCommit, records).catch(error => {
						console.warn('Line Last Modified: failed to write synced blame cache', error);
					});
				}
				return { state: 'ok', record: cached.records.get(lineNumber) ?? null };
			}
			const records = await this.runCurrentLineBlame(filePath, gitFilePath, lineNumber);
			return { state: 'ok', record: records.get(lineNumber) ?? null };
		} catch (error) {
			return { state: 'error', record: null, detail: this.errorMessage(error) };
		}
	}

	private async isAvailable(): Promise<{ available: boolean; detail?: string }> {
		if (this.availabilityCache && Date.now() - this.availabilityCache.checkedAt < 60_000) return this.availabilityCache;
		try {
			await this.runExecutable(['--version'], false);
			this.availabilityCache = { available: true, checkedAt: Date.now() };
		} catch (error) {
			this.availabilityCache = { available: false, checkedAt: Date.now(), detail: this.errorMessage(error) };
		}
		return this.availabilityCache;
	}

	private async getHeadCommit(): Promise<string> {
		if (this.headCache && Date.now() - this.headCache.checkedAt < 5_000) return this.headCache.value;
		const value = (await this.runGit(['rev-parse', 'HEAD'])).trim();
		this.headCache = { value, checkedAt: Date.now() };
		return value;
	}

	private async isTracked(gitFilePath: string): Promise<boolean> {
		const cached = this.trackedCache.get(gitFilePath);
		if (cached && Date.now() - cached.checkedAt < 5_000) return cached.value;
		try {
			await this.runGit(['ls-files', '--error-unmatch', '--', gitFilePath]);
			this.trackedCache.set(gitFilePath, { value: true, checkedAt: Date.now() });
			return true;
		} catch {
			this.trackedCache.set(gitFilePath, { value: false, checkedAt: Date.now() });
			return false;
		}
	}

	private async runFileBlame(filePath: string, gitFilePath: string): Promise<Map<number, GitBlameRecord>> {
		const key = `${this.headCache?.value ?? ''}\u0000${gitFilePath}`;
		const active = this.fileRequests.get(key);
		if (active) return active;
		const request = this.runFileBlameCommand(filePath, gitFilePath).finally(() => this.fileRequests.delete(key));
		this.fileRequests.set(key, request);
		return request;
	}

	private async runFileBlameCommand(filePath: string, gitFilePath: string): Promise<Map<number, GitBlameRecord>> {
		const args = ['blame', '--line-porcelain'];
		if (this.settings().ignoreWhitespaceInBlame) args.push('-w');
		args.push('--', gitFilePath);
		return parseGitBlamePorcelain(await this.runGit(args), filePath);
	}

	private async runCurrentLineBlame(filePath: string, gitFilePath: string, lineNumber: number): Promise<Map<number, GitBlameRecord>> {
		return this.withCurrentLineSlot(async () => {
			const args = ['blame', '--line-porcelain'];
			if (this.settings().ignoreWhitespaceInBlame) args.push('-w');
			args.push('-L', `${lineNumber},${lineNumber}`, '--', gitFilePath);
			return parseGitBlamePorcelain(await this.runGit(args), filePath);
		});
	}

	private async withCurrentLineSlot<T>(task: () => Promise<T>): Promise<T> {
		if (this.activeCurrentLineRequests >= 2) await new Promise<void>(resolve => this.currentLineWaiters.push(resolve));
		this.activeCurrentLineRequests += 1;
		try {
			return await task();
		} finally {
			this.activeCurrentLineRequests -= 1;
			this.currentLineWaiters.shift()?.();
		}
	}

	private runGit(args: string[]): Promise<string> {
		return this.runExecutable(['-C', this.getRepositoryRoot(), ...args], true);
	}

	private getRepositoryRoot(): string {
		return this.settings().gitRepositoryPath.trim() || this.vaultRoot as string;
	}

	private getGitFilePath(filePath: string): string {
		const runtimeRequire = this.getRuntimeRequire();
		const path = runtimeRequire('path') as {
			join: (...parts: string[]) => string;
			relative: (from: string, to: string) => string;
			isAbsolute: (value: string) => boolean;
		};
		const absoluteFile = path.join(this.vaultRoot as string, filePath);
		const relative = path.relative(this.getRepositoryRoot(), absoluteFile).replace(/\\/g, '/');
		if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
			throw new Error('The configured Git repository folder does not contain the current Vault file. Configure the repository folder separately on this device.');
		}
		return relative;
	}

	private sameFilesystemPath(left: string, right: string): boolean {
		const runtimeRequire = this.getRuntimeRequire();
		const path = runtimeRequire('path') as { resolve: (value: string) => string };
		const normalize = (value: string) => path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
		return normalize(left) === normalize(right);
	}

	private runExecutable(args: string[], useVaultCwd: boolean): Promise<string> {
		return new Promise((resolve, reject) => {
			let runtimeRequire: (id: string) => unknown;
			try {
				runtimeRequire = this.getRuntimeRequire();
			} catch (error) {
				reject(error);
				return;
			}
			const childProcess = runtimeRequire('child_process') as {
				execFile: (
					file: string,
					args: string[],
					options: Record<string, unknown>,
					callback: (error: GitCommandError | null, stdout: string, stderr: string) => void,
				) => void;
			};
			childProcess.execFile(this.settings().gitExecutablePath || 'git', args, {
				cwd: useVaultCwd ? this.getRepositoryRoot() : undefined,
				encoding: 'utf8',
				windowsHide: true,
				maxBuffer: 32 * 1024 * 1024,
				timeout: 15_000,
			}, (error, stdout, stderr) => {
				if (error) {
					error.stderr = stderr;
					reject(error);
				} else resolve(stdout);
			});
		});
	}

	private getRuntimeRequire(): (id: string) => unknown {
		const runtimeRequire = typeof require === 'function'
			? require as (id: string) => unknown
			: (globalThis as unknown as { require?: (id: string) => unknown }).require;
		if (!runtimeRequire) throw new Error('Node.js runtime is unavailable on this device.');
		return runtimeRequire;
	}

	private errorMessage(error: unknown): string {
		if (!error || typeof error !== 'object') return String(error);
		const commandError = error as GitCommandError;
		return this.redactLocalPaths(commandError.stderr?.trim() || commandError.message || 'Unknown Git error');
	}

	private redactLocalPaths(message: string): string {
		let redacted = message;
		const replacements = ([
			[this.settings().gitRepositoryPath.trim(), '<configured Git folder>'],
			[this.vaultRoot ?? '', '<Vault folder>'],
			[this.settings().gitExecutablePath, '<Git executable>'],
		] as Array<readonly [string, string]>).sort((a, b) => b[0].length - a[0].length);
		for (const [value, replacement] of replacements) {
			if (!value || value === 'git') continue;
			for (const variant of new Set([value, value.replace(/\\/g, '/'), value.replace(/\//g, '\\')])) {
				const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				redacted = redacted.replace(new RegExp(escaped, 'gi'), replacement);
			}
		}
		return redacted;
	}
}
