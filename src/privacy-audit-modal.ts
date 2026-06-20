import { App, Modal } from 'obsidian';

export interface PrivacyAuditSummary {
	files: number;
	events: number;
	deviceNames: number;
	previews: number;
	identityFields: number;
}

export interface PrivacyAuditLabels {
	title: string;
	summary: string;
	warning: string;
	rewrite: string;
	cancel: string;
}

export class PrivacyAuditModal extends Modal {
	constructor(app: App, private readonly labels: PrivacyAuditLabels, private readonly summary: PrivacyAuditSummary, private readonly onRewrite: () => Promise<void>) { super(app); }

	onOpen(): void {
		this.setTitle(this.labels.title);
		this.contentEl.createEl('p', { text: this.labels.summary
			.replace('{files}', String(this.summary.files)).replace('{events}', String(this.summary.events))
			.replace('{names}', String(this.summary.deviceNames)).replace('{previews}', String(this.summary.previews))
			.replace('{identity}', String(this.summary.identityFields)) });
		this.contentEl.createEl('p', { cls: 'mod-warning', text: this.labels.warning });
		const actions = this.contentEl.createDiv({ cls: 'modal-button-container' });
		actions.createEl('button', { text: this.labels.cancel }).addEventListener('click', () => this.close());
		const rewrite = actions.createEl('button', { cls: 'mod-cta', text: this.labels.rewrite });
		rewrite.addEventListener('click', async () => { rewrite.disabled = true; await this.onRewrite(); this.close(); });
	}

	onClose(): void { this.contentEl.empty(); }
}
