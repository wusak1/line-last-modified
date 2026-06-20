import { App, Modal } from 'obsidian';
import type { DeviceInfo } from './types';

export interface DeviceTrustLabels {
	title: string; threat: string; empty: string; trusted: string; untrusted: string; revoked: string;
	trust: string; revoke: string; rotate: string; rotateConfirm: string; fingerprint: string;
}

export class DeviceTrustModal extends Modal {
	constructor(app: App, private readonly labels: DeviceTrustLabels, private readonly devices: DeviceInfo[],
		private readonly trusted: Set<string>, private readonly revoked: Set<string>,
		private readonly onTrust: (keyId: string) => Promise<void>, private readonly onRevoke: (keyId: string) => Promise<void>,
		private readonly onRotate: () => Promise<void>) { super(app); }
	onOpen(): void {
		this.setTitle(this.labels.title);
		this.contentEl.createEl('p', { cls: 'line-last-modified-settings-guidance', text: this.labels.threat });
		const keys = this.devices.flatMap(device => (device.signingKeys ?? []).map(key => ({ device, key })));
		if (!keys.length) this.contentEl.createEl('p', { text: this.labels.empty });
		for (const { device, key } of keys) {
			const row = this.contentEl.createDiv({ cls: 'llm-impact-row' });
			row.createEl('strong', { text: device.deviceName ?? device.deviceId });
			row.createEl('code', { text: `${this.labels.fingerprint}: ${key.keyId}` });
			const state = this.revoked.has(key.keyId) ? this.labels.revoked : this.trusted.has(key.keyId) ? this.labels.trusted : this.labels.untrusted;
			row.createEl('span', { text: state });
			if (!this.trusted.has(key.keyId) && !this.revoked.has(key.keyId)) row.createEl('button', { text: this.labels.trust }).addEventListener('click', async () => { await this.onTrust(key.keyId); this.close(); });
			if (!this.revoked.has(key.keyId)) row.createEl('button', { text: this.labels.revoke }).addEventListener('click', async () => { await this.onRevoke(key.keyId); this.close(); });
		}
		const rotate = this.contentEl.createEl('button', { text: this.labels.rotate });
		rotate.addEventListener('click', async () => { if (window.confirm(this.labels.rotateConfirm)) { rotate.disabled = true; await this.onRotate(); this.close(); } });
	}
	onClose(): void { this.contentEl.empty(); }
}
