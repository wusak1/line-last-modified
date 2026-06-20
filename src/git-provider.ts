import type { GitInitAssessment, GitInitResult, GitLineResult, GitOnboardingStatus } from './types';

export interface GitProvider {
	invalidate(filePath?: string): void;
	getOnboardingStatus(): Promise<Omit<GitOnboardingStatus, 'obsidianGitInstalled' | 'obsidianGitEnabled'>>;
	getLineBlame(filePath: string, lineNumber: number, fileLineCount: number): Promise<GitLineResult>;
	assessRepositoryInitialization(): Promise<GitInitAssessment>;
	initializeRepository(confirmed: boolean, allowNested?: boolean): Promise<GitInitResult>;
}
