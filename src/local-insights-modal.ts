import { App, Modal } from 'obsidian';
import type { LocalInsights } from './local-insights-model';

export interface LocalInsightsLabels {
	title: string; summary: string; topics: string; newTopics: string; journalThemes: string; risks: string; explanation: string; empty: string;
}

export class LocalInsightsModal extends Modal {
	constructor(app: App, private readonly labels: LocalInsightsLabels, private readonly insight: LocalInsights) { super(app); }
	onOpen(): void {
		this.setTitle(this.labels.title);
		this.contentEl.createEl('p', { text: this.labels.summary.replace('{days}', String(this.insight.periodDays)).replace('{notes}', String(this.insight.changedNotes)).replace('{chars}', String(this.insight.visibleCharacters)).replace('{skipped}', String(this.insight.skippedNotes)) });
		this.section(this.labels.topics, this.insight.topTopics.map(value => `${value.topic} (${value.count}, ${value.evidence})`));
		this.section(this.labels.newTopics, this.insight.newTopics);
		this.section(this.labels.journalThemes, this.insight.journalThemes.map(value => `${value.topic} (${value.count})`));
		this.section(this.labels.risks, this.insight.knowledgeRisks.map(value => `${value.path} · ${value.status} · ${value.reason}`));
		this.contentEl.createEl('h3', { text: this.labels.explanation });
		this.contentEl.createEl('p', { cls: 'llm-history-meta', text: this.insight.explanation });
	}
	private section(title: string, values: string[]): void {
		this.contentEl.createEl('h3', { text: title });
		if (!values.length) { this.contentEl.createEl('p', { text: this.labels.empty }); return; }
		const list = this.contentEl.createEl('ul');
		for (const value of values) list.createEl('li', { text: value });
	}
	onClose(): void { this.contentEl.empty(); }
}
