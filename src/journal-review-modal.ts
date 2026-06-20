import { App, Modal, Notice, TFile } from 'obsidian';
import {
	buildJournalReviewModel,
	journalReviewMarkdown,
	validateJournalExportPath,
	type JournalReviewModel,
	type JournalReviewNoteInput,
	type JournalReviewRange,
} from './journal-review-model';
import type { LineLastModifiedSettings } from './types';

export interface JournalReviewLabels {
	title: string;
	week: string;
	month: string;
	allDevices: string;
	device: string;
	summary: string;
	heatmap: string;
	heatCell: string;
	less: string;
	more: string;
	characterCount: string;
	over5000: string;
	recent: string;
	empty: string;
	delayed: string;
	retrospective: string;
	open: string;
	export: string;
	exportTitle: string;
	exportPath: string;
	exportConfirm: string;
	exportReplace: string;
	exportInvalid: string;
	exportDone: string;
	exportFailed: string;
	cancel: string;
}

export class JournalReviewModal extends Modal {
	private range: JournalReviewRange = 'month';
	private deviceKey = '';
	private body!: HTMLElement;

	constructor(
		app: App,
		private readonly labels: JournalReviewLabels,
		private readonly notes: JournalReviewNoteInput[],
		private readonly settings: LineLastModifiedSettings,
	) { super(app); }

	onOpen(): void {
		this.modalEl.addClass('llm-journal-review-modal');
		this.setTitle(this.labels.title);
		const controls = this.contentEl.createDiv({ cls: 'llm-journal-review-controls' });
		const range = controls.createEl('select');
		range.setAttribute('aria-label', this.labels.title);
		range.createEl('option', { value: 'week', text: this.labels.week });
		range.createEl('option', { value: 'month', text: this.labels.month });
		range.value = this.range;
		range.addEventListener('change', () => { this.range = range.value as JournalReviewRange; this.render(); });
		const device = controls.createEl('select');
		device.setAttribute('aria-label', this.labels.device);
		device.createEl('option', { value: '', text: this.labels.allDevices });
		for (const item of buildJournalReviewModel(this.notes, this.settings, { range: 'month' }).devices) device.createEl('option', { value: item.key, text: item.label });
		device.addEventListener('change', () => { this.deviceKey = device.value; this.render(); });
		this.body = this.contentEl.createDiv();
		this.render();
	}

	private render(): void {
		this.body.empty();
		const model = buildJournalReviewModel(this.notes, this.settings, { range: this.range, deviceKey: this.deviceKey || undefined });
		this.body.createEl('p', { cls: 'llm-review-summary', text: this.labels.summary
			.replace('{notes}', String(model.noteCount)).replace('{delayed}', String(model.delayedCount)).replace('{revisions}', String(model.retrospectiveCount)) });
		this.body.createEl('h3', { text: this.labels.heatmap });
		const heatSection = this.body.createDiv({ cls: 'llm-contribution-section' });
		heatSection.createDiv({ cls: 'llm-contribution-range', text: `${model.startDate} – ${model.endDate}` });
		const heatBody = heatSection.createDiv({ cls: 'llm-contribution-body' });
		const weekdays = heatBody.createDiv({ cls: 'llm-contribution-weekdays' });
		const firstSunday = Date.UTC(2026, 0, 4);
		for (let index = 0; index < 7; index++) weekdays.createSpan({ text: new Intl.DateTimeFormat(undefined, { weekday: 'narrow' }).format(new Date(firstSunday + index * 86_400_000)) });
		const heatmap = heatBody.createDiv({ cls: 'llm-journal-heatmap llm-contribution-grid' });
		heatmap.setAttribute('role', 'list');
		const startWeekday = new Date(`${model.startDate}T00:00:00Z`).getUTCDay();
		for (let index = 0; index < startWeekday; index++) heatmap.createSpan({ cls: 'llm-contribution-spacer' });
		for (const cell of model.heatmap) {
			const label = `${this.labels.heatCell.replace('{date}', cell.date).replace('{delayed}', String(cell.delayed)).replace('{revisions}', String(cell.retrospective))} · ${this.labels.characterCount.replace('{count}', String(cell.characterCount))}${cell.emphasized ? ` · ${this.labels.over5000}` : ''}`;
			const item = heatmap.createSpan({ cls: `llm-contribution-cell level-${cell.intensityLevel}${cell.emphasized ? ' is-overflow' : ''}` });
			item.setAttribute('role', 'listitem');
			item.setAttribute('aria-label', label);
		}
		const legend = heatSection.createDiv({ cls: 'llm-contribution-legend' });
		legend.createSpan({ text: this.labels.less });
		for (let level = 0; level <= 10; level++) legend.createSpan({ cls: `llm-contribution-cell level-${level}`, attr: { 'aria-hidden': 'true' } });
		legend.createSpan({ text: this.labels.more });
		this.body.createEl('h3', { text: this.labels.recent });
		const list = this.body.createDiv({ cls: 'llm-journal-edit-list' });
		const important = model.edits.filter(edit => edit.kind === 'next-day' || edit.kind === 'delayed' || edit.kind === 'retrospective');
		if (!important.length) list.createEl('p', { cls: 'llm-review-empty', text: this.labels.empty });
		for (const edit of important) {
			const row = list.createDiv({ cls: 'llm-review-row' });
			const info = row.createDiv({ cls: 'llm-review-info' });
			info.createEl('div', { cls: 'llm-review-path', text: edit.path });
			info.createEl('div', { cls: 'llm-review-meta', text: `${edit.kind === 'retrospective' ? this.labels.retrospective : this.labels.delayed} · ${new Date(edit.editedAt).toLocaleString()} · ${edit.deviceLabel}` });
			const button = row.createEl('button', { text: this.labels.open });
			button.addEventListener('click', async () => {
				const file = this.app.vault.getAbstractFileByPath(edit.path);
				if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
			});
		}
		const exportButton = this.body.createEl('button', { cls: 'mod-cta llm-journal-export', text: this.labels.export });
		exportButton.addEventListener('click', () => new JournalExportModal(this.app, this.labels, model).open());
	}

	onClose(): void { this.contentEl.empty(); }
}

class JournalExportModal extends Modal {
	constructor(app: App, private readonly labels: JournalReviewLabels, private readonly model: JournalReviewModel) { super(app); }

	onOpen(): void {
		this.setTitle(this.labels.exportTitle);
		this.contentEl.createEl('p', { text: this.labels.exportConfirm });
		const input = this.contentEl.createEl('input', { type: 'text', value: `Journal review ${this.model.endDate}.md` });
		input.setAttribute('aria-label', this.labels.exportPath);
		input.style.width = '100%';
		const replaceRow = this.contentEl.createEl('label', { cls: 'llm-export-replace' });
		const replace = replaceRow.createEl('input', { type: 'checkbox' });
		replaceRow.appendText(this.labels.exportReplace);
		const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = actions.createEl('button', { text: this.labels.cancel });
		cancel.addEventListener('click', () => this.close());
		const confirm = actions.createEl('button', { cls: 'mod-cta', text: this.labels.export });
		confirm.addEventListener('click', async () => {
			const path = validateJournalExportPath(input.value);
			if (!path) { new Notice(this.labels.exportInvalid); return; }
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing && (!(existing instanceof TFile) || !replace.checked)) { new Notice(this.labels.exportReplace); return; }
			try {
				const content = journalReviewMarkdown(this.model, this.labels.title);
				if (existing instanceof TFile) await this.app.vault.modify(existing, content);
				else await this.app.vault.create(path, content);
				new Notice(this.labels.exportDone.replace('{path}', path));
				this.close();
			} catch (error) {
				new Notice(this.labels.exportFailed.replace('{reason}', error instanceof Error ? error.message : String(error)));
			}
		});
	}

	onClose(): void { this.contentEl.empty(); }
}
