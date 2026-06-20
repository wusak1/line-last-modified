import { App, Modal, TFile } from 'obsidian';
import type { JournalMigrationCandidate } from './journal-migration-model';

export interface JournalMigrationLabels {
	title: string; empty: string; possible: string; confirmed: string; from: string; to: string; reason: string; open: string;
}

export class JournalMigrationModal extends Modal {
	constructor(app: App, private readonly labels: JournalMigrationLabels, private readonly candidates: JournalMigrationCandidate[]) { super(app); }
	onOpen(): void {
		this.setTitle(this.labels.title);
		if (!this.candidates.length) { this.contentEl.createEl('p', { text: this.labels.empty }); return; }
		for (const candidate of this.candidates) {
			const row = this.contentEl.createDiv({ cls: 'llm-impact-row' });
			row.createEl('strong', { text: candidate.confidence === 'confirmed-move' ? this.labels.confirmed : this.labels.possible });
			row.createEl('div', { text: `${this.labels.from}: ${candidate.sourceDate} · ${candidate.sourcePath}:${candidate.sourceLine}` });
			row.createEl('div', { text: `${this.labels.to}: ${candidate.targetDate} · ${candidate.targetPath}:${candidate.targetLine}` });
			row.createEl('div', { cls: 'llm-history-meta', text: `${this.labels.reason}: ${candidate.reason}` });
			row.createEl('button', { text: this.labels.open }).addEventListener('click', async () => {
				const file = this.app.vault.getAbstractFileByPath(candidate.targetPath);
				if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
			});
		}
	}
	onClose(): void { this.contentEl.empty(); }
}
