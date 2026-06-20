import { App, Modal } from 'obsidian';
import type { HistoryPanelModel } from './history-model';

export interface HistoryPanelLabels {
	title: string;
	selected: string;
	candidates: string;
	noCandidates: string;
	git: string;
	fileFallback: string;
	metadata: string;
	source: string;
	match: string;
	confidence: string;
	device: string;
	commit: string;
	lastScan: string;
	cacheGenerated: string;
	conflict: string;
	clockWarning: string;
	resolution: string;
	choose: string;
	merge: string;
	dismiss: string;
	resolved: string;
	verification: string;
}

export class HistoryPanelModal extends Modal {
	constructor(app: App, private readonly labels: HistoryPanelLabels, private readonly model: HistoryPanelModel,
		private readonly onResolve?: (eventIds: string[], strategy: 'choose' | 'merge' | 'dismiss', chosenEventId?: string) => Promise<void>) { super(app); }

	onOpen(): void {
		this.modalEl.addClass('llm-history-modal');
		this.setTitle(this.labels.title);
		const selected = this.contentEl.createDiv({ cls: 'llm-history-selected' });
		selected.createEl('h3', { text: this.labels.selected });
		selected.createEl('div', { cls: 'llm-history-selected-value', text: this.model.selectedText });
		selected.createEl('div', { cls: 'llm-history-meta', text: `${this.labels.source}: ${this.model.selectedSource} · ${this.labels.confidence}: ${this.model.selectedConfidence}` });

		this.contentEl.createEl('h3', { text: this.labels.candidates });
		const list = this.contentEl.createDiv({ cls: 'llm-history-list' });
		if (!this.model.candidates.length) list.createEl('p', { text: this.labels.noCandidates });
		for (const item of this.model.candidates) {
			const row = list.createDiv({ cls: 'llm-history-row' });
			row.createEl('time', { text: new Date(item.timestamp).toLocaleString() });
			row.createEl('div', { cls: 'llm-history-meta', text: `${this.labels.source}: ${item.source} · ${this.labels.match}: ${item.matchReason} · ${this.labels.confidence}: ${item.confidence}` });
			if (item.deviceName) row.createEl('div', { cls: 'llm-history-meta', text: `${this.labels.device}: ${item.deviceName}` });
			if (item.verificationStatus) row.createEl('div', { cls: 'llm-history-meta', text: `${this.labels.verification}: ${item.verificationStatus}` });
			if (item.conflict) row.createEl('strong', { cls: 'llm-history-warning', text: this.labels.conflict });
			if (item.timeUncertain) row.createEl('strong', { cls: 'llm-history-warning', text: this.labels.clockWarning });
		}
		for (const resolution of this.model.resolutions) {
			this.contentEl.createEl('p', { cls: 'llm-history-meta', text: `${this.labels.resolved}: ${resolution.strategy} · ${new Date(resolution.resolvedAt).toLocaleString()}` });
		}
		const conflicting = this.model.candidates.filter(item => item.conflict);
		if (this.onResolve && conflicting.length >= 2) {
			const resolution = this.contentEl.createDiv({ cls: 'llm-history-section' });
			resolution.createEl('h3', { text: this.labels.resolution });
			for (const item of conflicting) {
				const choose = resolution.createEl('button', { text: `${this.labels.choose}: ${new Date(item.timestamp).toLocaleString()}` });
				choose.addEventListener('click', async () => { choose.disabled = true; await this.onResolve?.(conflicting.map(value => value.id), 'choose', item.id); this.close(); });
			}
			const merge = resolution.createEl('button', { text: this.labels.merge });
			merge.addEventListener('click', async () => { merge.disabled = true; await this.onResolve?.(conflicting.map(value => value.id), 'merge'); this.close(); });
			const dismiss = resolution.createEl('button', { text: this.labels.dismiss });
			dismiss.addEventListener('click', async () => { dismiss.disabled = true; await this.onResolve?.(conflicting.map(value => value.id), 'dismiss'); this.close(); });
		}
		if (this.model.git) {
			const git = this.contentEl.createDiv({ cls: 'llm-history-section' });
			git.createEl('h3', { text: this.labels.git });
			git.createEl('div', { text: new Date(this.model.git.timestamp).toLocaleString() });
			if (this.model.git.commit) git.createEl('div', { cls: 'llm-history-meta', text: `${this.labels.commit}: ${this.model.git.commit}` });
			if (this.model.git.author) git.createEl('div', { cls: 'llm-history-meta', text: this.model.git.author });
			if (this.model.git.cacheGeneratedAt) git.createEl('div', { cls: 'llm-history-meta', text: `${this.labels.cacheGenerated}: ${new Date(this.model.git.cacheGeneratedAt).toLocaleString()}` });
		}
		if (this.model.fileMtime) this.contentEl.createEl('p', { cls: 'llm-history-meta', text: `${this.labels.fileFallback}: ${new Date(this.model.fileMtime).toLocaleString()}` });
		if (this.model.lastScanAt) this.contentEl.createEl('p', { cls: 'llm-history-meta', text: `${this.labels.metadata} · ${this.labels.lastScan}: ${new Date(this.model.lastScanAt).toLocaleString()}` });
	}

	onClose(): void { this.contentEl.empty(); }
}
