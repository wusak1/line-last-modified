import { App, Modal, Setting } from 'obsidian';
import type { GitInitAssessment } from './types';

export class GitInitModal extends Modal {
	constructor(
		app: App,
		private readonly assessment: GitInitAssessment,
		private readonly labels: {
			title: string; target: string; safety: string; nested: string; confirmNested: string;
			cancel: string; initialize: string; close: string;
		},
		private readonly confirm: (allowNested: boolean) => Promise<void>,
	) { super(app); }

	onOpen(): void {
		this.setTitle(this.labels.title);
		this.contentEl.createEl('p', { text: this.assessment.detail });
		if (this.assessment.targetPath) this.contentEl.createEl('p', { text: `${this.labels.target}: ${this.assessment.targetPath}` });
		this.contentEl.createEl('p', { text: this.labels.safety });
		if (!this.assessment.canInitialize) {
			new Setting(this.contentEl).addButton(button => button.setButtonText(this.labels.close).onClick(() => this.close()));
			return;
		}
		let nestedConfirmed = !this.assessment.requiresNestedConfirmation;
		let initializeButton: { setDisabled: (disabled: boolean) => unknown } | null = null;
		if (this.assessment.requiresNestedConfirmation) {
			this.contentEl.createEl('p', { text: this.labels.nested });
			new Setting(this.contentEl).setName(this.labels.confirmNested).addToggle(toggle => toggle.onChange(value => {
				nestedConfirmed = value;
				initializeButton?.setDisabled(!value);
			}));
		}
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText(this.labels.cancel).onClick(() => this.close()))
			.addButton(button => {
				initializeButton = button;
				button.setWarning().setButtonText(this.labels.initialize).setDisabled(!nestedConfirmed).onClick(async () => {
					button.setDisabled(true);
					await this.confirm(this.assessment.requiresNestedConfirmation);
					this.close();
				});
			});
	}

	onClose(): void { this.contentEl.empty(); }
}
