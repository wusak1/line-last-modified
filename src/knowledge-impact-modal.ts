import { App, Modal, TFile } from 'obsidian';
import type { KnowledgeImpactTask } from './knowledge-impact-model';

export interface KnowledgeImpactLabels {
	title: string;
	empty: string;
	affected: string;
	changed: string;
	relation: string;
	lag: string;
	unknown: string;
	reasonNewer: string;
	reasonUnknown: string;
	open: string;
}

export class KnowledgeImpactModal extends Modal {
	constructor(app: App, private readonly labels: KnowledgeImpactLabels, private readonly tasks: KnowledgeImpactTask[]) { super(app); }

	onOpen(): void {
		this.modalEl.addClass('llm-knowledge-impact-modal');
		this.setTitle(this.labels.title);
		if (!this.tasks.length) { this.contentEl.createEl('p', { text: this.labels.empty }); return; }
		const list = this.contentEl.createDiv({ cls: 'llm-impact-list' });
		for (const task of this.tasks) {
			const row = list.createDiv({ cls: 'llm-impact-row' });
			row.createEl('strong', { text: `${this.labels.affected}: ${task.affectedPath}` });
			row.createEl('div', { cls: 'llm-history-meta', text: `${this.labels.changed}: ${task.changedPath}` });
			row.createEl('div', { cls: 'llm-history-meta', text: `${this.labels.relation}: ${task.relation} · ${this.labels.lag}: ${task.lagDays === null ? this.labels.unknown : Math.floor(task.lagDays)}` });
			row.createEl('div', { text: task.reason === 'target-newer' ? this.labels.reasonNewer : this.labels.reasonUnknown });
			const button = row.createEl('button', { text: this.labels.open });
			button.addEventListener('click', async () => {
				const file = this.app.vault.getAbstractFileByPath(task.affectedPath);
				if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
			});
		}
	}

	onClose(): void { this.contentEl.empty(); }
}
