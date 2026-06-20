import { App, Modal, TFile } from 'obsidian';
import {
	filterAndSortKnowledgeDashboard,
	type KnowledgeDashboardFilter,
	type KnowledgeDashboardItem,
	type KnowledgeDashboardSort,
} from './knowledge-dashboard-model';
import type { KnowledgeFreshness } from './knowledge-policy';

export interface KnowledgeDashboardLabels {
	title: string;
	search: string;
	all: string;
	stale: string;
	conflict: string;
	lowConfidence: string;
	sortOverdue: string;
	sortBacklinks: string;
	empty: string;
	overdue: string;
	backlinks: string;
	lineHeatmap: string;
	lineLabel: string;
	less: string;
	more: string;
	characterCount: string;
	over5000: string;
	open: string;
	lastEdited: string;
	lastReviewed: string;
	statuses: Record<KnowledgeFreshness, string>;
}

const STATUS_ORDER: KnowledgeFreshness[] = ['conflict', 'possibly-stale', 'review-due', 'uncertain', 'review-soon', 'fresh'];

export class KnowledgeDashboardModal extends Modal {
	private query = '';
	private filter: KnowledgeDashboardFilter = 'all';
	private sort: KnowledgeDashboardSort = 'overdue';
	private board!: HTMLElement;

	constructor(app: App, private readonly labels: KnowledgeDashboardLabels, private readonly items: KnowledgeDashboardItem[]) { super(app); }

	onOpen(): void {
		this.modalEl.addClass('llm-knowledge-dashboard-modal');
		this.setTitle(this.labels.title);
		const controls = this.contentEl.createDiv({ cls: 'llm-dashboard-controls' });
		const search = controls.createEl('input', { type: 'search', placeholder: this.labels.search });
		search.setAttribute('aria-label', this.labels.search);
		search.addEventListener('input', () => { this.query = search.value.trim().toLowerCase(); this.render(); });
		const filter = controls.createEl('select');
		filter.setAttribute('aria-label', this.labels.all);
		for (const [value, text] of [['all', this.labels.all], ['stale', this.labels.stale], ['conflict', this.labels.conflict], ['low-confidence', this.labels.lowConfidence]]) filter.createEl('option', { value, text });
		filter.addEventListener('change', () => { this.filter = filter.value as KnowledgeDashboardFilter; this.render(); });
		const sort = controls.createEl('select');
		sort.setAttribute('aria-label', this.labels.sortOverdue);
		sort.createEl('option', { value: 'overdue', text: this.labels.sortOverdue });
		sort.createEl('option', { value: 'backlinks', text: this.labels.sortBacklinks });
		sort.addEventListener('change', () => { this.sort = sort.value as KnowledgeDashboardSort; this.render(); });
		this.board = this.contentEl.createDiv({ cls: 'llm-knowledge-board' });
		this.render();
	}

	private render(): void {
		this.board.empty();
		const items = filterAndSortKnowledgeDashboard(this.items, this.filter, this.sort)
			.filter(item => !this.query || item.path.toLowerCase().includes(this.query));
		if (!items.length) { this.board.createEl('p', { cls: 'llm-review-empty', text: this.labels.empty }); return; }
		for (const status of STATUS_ORDER) {
			const values = items.filter(item => item.status === status);
			if (!values.length) continue;
			const column = this.board.createDiv({ cls: 'llm-knowledge-column' });
			column.createEl('h3', { text: `${this.labels.statuses[status]} (${values.length})` });
			for (const item of values) this.renderCard(column, item);
		}
	}

	private renderCard(container: HTMLElement, item: KnowledgeDashboardItem): void {
		const card = container.createDiv({ cls: `llm-knowledge-card llm-mode-${item.status}` });
		card.createEl('div', { cls: 'llm-review-path', text: item.path });
		const meta = card.createDiv({ cls: 'llm-review-meta' });
		meta.createSpan({ text: `${this.labels.overdue}: ${item.overdueDays ?? '—'}` });
		meta.createSpan({ text: `${this.labels.backlinks}: ${item.backlinksCount}` });
		meta.createSpan({ text: `${this.labels.lastEdited}: ${item.lastEditedAt ? new Date(item.lastEditedAt).toLocaleString() : '—'}` });
		meta.createSpan({ text: `${this.labels.lastReviewed}: ${item.lastReviewedAt ? new Date(item.lastReviewedAt).toLocaleString() : '—'}` });
		if (item.lowConfidence) meta.createEl('strong', { text: this.labels.lowConfidence });
		if (item.conflict) meta.createEl('strong', { text: this.labels.conflict });
		if (item.lines.length) {
			card.createEl('div', { cls: 'llm-line-heatmap-title', text: this.labels.lineHeatmap });
			const heatmap = card.createDiv({ cls: 'llm-line-heatmap' });
			heatmap.setAttribute('role', 'list');
			for (const line of item.lines) {
				const label = this.labels.lineLabel
					.replace('{line}', String(line.lineNumber)).replace('{status}', this.labels.statuses[line.status])
					.replace('{days}', line.ageDays === null ? '—' : String(Math.floor(line.ageDays)))
					.replace('{confidence}', line.confidence) + ` · ${this.labels.characterCount.replace('{count}', String(line.characterCount))}${line.emphasized ? ` · ${this.labels.over5000}` : ''}`;
				const cell = heatmap.createEl('span', { cls: `llm-contribution-cell level-${line.intensityLevel}${line.conflict ? ' is-conflict' : ''}${line.confidence === 'low' ? ' is-low-confidence' : ''}${line.emphasized ? ' is-overflow' : ''}` });
				cell.setAttribute('role', 'listitem');
				cell.setAttribute('aria-label', label);
			}
			const legend = card.createDiv({ cls: 'llm-contribution-legend llm-line-legend' });
			legend.createSpan({ text: this.labels.less });
			for (let level = 0; level <= 10; level++) legend.createSpan({ cls: `llm-contribution-cell level-${level}`, attr: { 'aria-hidden': 'true' } });
			legend.createSpan({ text: this.labels.more });
		}
		const button = card.createEl('button', { text: this.labels.open });
		button.addEventListener('click', async () => {
			const file = this.app.vault.getAbstractFileByPath(item.path);
			if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
		});
	}

	onClose(): void { this.contentEl.empty(); }
}
