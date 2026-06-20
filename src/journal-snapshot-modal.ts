import { App, Modal, TFile } from 'obsidian';
import type { LocalJournalSnapshot } from './journal-snapshot-store';

export interface JournalSnapshotLabels { title: string; empty: string; restore: string; confirm: string; restored: string; missing: string; size: string }

export class JournalSnapshotModal extends Modal {
	constructor(app: App, private readonly labels: JournalSnapshotLabels, private readonly snapshots: LocalJournalSnapshot[],
		private readonly onRestored: (message: string) => void) { super(app); }
	onOpen(): void {
		this.setTitle(this.labels.title);
		if (!this.snapshots.length) { this.contentEl.createEl('p', { text: this.labels.empty }); return; }
		for (const snapshot of this.snapshots) {
			const row = this.contentEl.createDiv({ cls: 'llm-impact-row' });
			row.createEl('strong', { text: snapshot.filePath });
			row.createEl('time', { text: new Date(snapshot.createdAt).toLocaleString() });
			row.createEl('div', { cls: 'llm-history-meta', text: this.labels.size.replace('{count}', String(snapshot.content.length)) });
			const restore = row.createEl('button', { text: this.labels.restore });
			restore.addEventListener('click', async () => {
				if (!window.confirm(this.labels.confirm)) return;
				const file = this.app.vault.getAbstractFileByPath(snapshot.filePath);
				if (!(file instanceof TFile)) { this.onRestored(this.labels.missing); return; }
				restore.disabled = true;
				await this.app.vault.modify(file, snapshot.content);
				this.onRestored(this.labels.restored);
				this.close();
			});
		}
	}
	onClose(): void { this.contentEl.empty(); }
}
