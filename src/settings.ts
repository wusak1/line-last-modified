import { AbstractInputSuggest, App, getLanguage, Notice, PluginSettingTab, setIcon, Setting } from 'obsidian';
import type LineLastModifiedPlugin from './main';
import type { SettingsChangeScope } from './main';
import {
	detectCommonLocalFonts,
	mergeFontFamilies,
	OBSIDIAN_FONT_CHOICES,
	scanLocalFontFamilies,
} from './font-options';
import type { AbsoluteTimeAfterUnit, DisplayMode, GitBlameMode, GitRepositoryState, JournalHistoryProtection, PrivacyMode, TimestampLanguage, TimestampPlacement } from './types';
import { validateSyncMetadataDir } from './utils';
import { createTranslator, type TranslationKey } from './i18n';

interface SearchableFontOption {
	value: string;
	label: string;
}

type DocumentModePreset = 'auto' | 'journal' | 'knowledge' | 'simple';

class FontInputSuggest extends AbstractInputSuggest<SearchableFontOption> {
	private showAll = false;

	constructor(
		app: App,
		private readonly input: HTMLInputElement,
		private options: SearchableFontOption[],
		private readonly choose: (option: SearchableFontOption) => void,
	) {
		super(app, input);
		this.limit = 0;
	}

	protected getSuggestions(query: string): SearchableFontOption[] {
		if (this.showAll) return this.options;
		const normalized = query.trim().toLowerCase();
		return this.options.filter(option => !normalized || option.label.toLowerCase().includes(normalized));
	}

	openAll(): void {
		this.showAll = true;
		this.input.focus();
		this.input.dispatchEvent(new Event('input', { bubbles: true }));
		window.setTimeout(() => { this.showAll = false; }, 0);
		window.requestAnimationFrame(() => window.requestAnimationFrame(() => this.fitVisiblePopover()));
	}

	setOptions(options: SearchableFontOption[]): void {
		this.options = options;
	}

	private fitVisiblePopover(): void {
		const containers = Array.from(document.querySelectorAll<HTMLElement>('.suggestion-container'))
			.filter(container => container.offsetParent !== null);
		const container = containers[containers.length - 1];
		if (!container) return;
		const anchor = this.input.closest<HTMLElement>('.line-last-modified-font-combobox') ?? this.input;
		const anchorRect = anchor.getBoundingClientRect();
		const rect = container.getBoundingClientRect();
		const available = Math.max(128, window.innerHeight - rect.top - 8);
		const compactHeight = Math.min(240, available);
		const currentLeft = Number.parseFloat(window.getComputedStyle(container).left);
		if (Number.isFinite(currentLeft)) container.style.left = `${currentLeft + anchorRect.left - rect.left}px`;
		container.style.width = `${anchorRect.width}px`;
		container.style.minWidth = `${anchorRect.width}px`;
		container.style.maxWidth = `${anchorRect.width}px`;
		container.style.maxHeight = `${compactHeight}px`;
		container.style.overflowY = 'auto';
	}

	renderSuggestion(option: SearchableFontOption, el: HTMLElement): void {
		el.setText(option.label);
		el.style.fontFamily = option.value;
	}

	selectSuggestion(option: SearchableFontOption): void {
		this.setValue(option.label);
		this.choose(option);
		this.close();
	}
}

export class LineLastModifiedSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: LineLastModifiedPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const t = createTranslator(getLanguage());
		containerEl.empty();
		containerEl.addClass('line-last-modified-settings');
		containerEl.createEl('h2', { text: 'Line Last Modified' });
		containerEl.createEl('p', {
			text: t('intro'),
		});
		const status = containerEl.createDiv({ cls: 'line-last-modified-settings-status', attr: { 'aria-label': t('setupStatus') } });
		this.addStatusPill(status, t('statusTimestamp'), this.plugin.settings.enabled, t);
		this.addStatusPill(status, t('statusLocalHistory'), this.plugin.settings.enableLocalEditTracking, t);
		this.addStatusPill(status, t('statusCrossDevice'), this.plugin.settings.enableSyncMetadata, t);

		const basicBody = this.createSettingsCard(containerEl, t('startHere'), t('startHereDesc'));
		const usageBody = this.createSettingsCard(containerEl, t('documentModes'), t('modeBeginnerIntro'));

		new Setting(basicBody).setName(t('enableTimestamp')).setDesc(t('enableTimestampDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.enabled)
			.onChange(async value => { this.plugin.settings.enabled = value; await this.plugin.saveSettings(); this.display(); }));
		new Setting(basicBody).setName(t('minimumChangedCharacters')).setDesc(t('minimumChangedCharactersDesc')).addText(text => {
			text.inputEl.type = 'number';
			text.inputEl.min = '1';
			text.inputEl.step = '1';
			text.setValue(String(this.plugin.settings.minimumChangedCharacters)).onChange(async raw => {
				const value = Number(raw);
				if (!Number.isFinite(value)) return;
				this.plugin.settings.minimumChangedCharacters = Math.max(1, Math.floor(value));
				await this.plugin.saveSettings();
			});
		});

		new Setting(basicBody).setName(t('displayTime')).setDesc(t('displayTimeDesc')).addDropdown(dropdown => dropdown
			.addOption('relative', t('relative'))
			.addOption('absolute', t('absolute'))
			.addOption('both', t('both'))
			.setValue(this.plugin.settings.displayMode)
			.onChange(async value => { this.plugin.settings.displayMode = value as DisplayMode; await this.plugin.saveSettings(); this.display(); }));
		new Setting(basicBody).setName(t('timestampPlacement')).setDesc(t('timestampPlacementDesc')).addDropdown(dropdown => dropdown
			.addOption('inline', t('placementInline'))
			.addOption('gutter', t('placementGutter'))
			.addOption('status-bar', t('placementStatusBar'))
			.setValue(this.plugin.settings.timestampPlacement)
			.onChange(async value => { this.plugin.settings.timestampPlacement = value as TimestampPlacement; await this.plugin.saveSettings(); }));
		new Setting(basicBody).setName(t('timestampLanguage')).setDesc(t('timestampLanguageDesc')).addDropdown(dropdown => dropdown
			.addOption('auto', t('languageAuto'))
			.addOption('zh-CN', t('languageChinese'))
			.addOption('en', t('languageEnglish'))
			.setValue(this.plugin.settings.timestampLanguage)
			.onChange(async value => { this.plugin.settings.timestampLanguage = value as TimestampLanguage; await this.plugin.saveSettings(); }));

		if (this.plugin.settings.displayMode === 'relative') {
		const absoluteAfterSetting = new Setting(basicBody)
			.setName(t('absoluteAfter'))
			.setDesc(t('absoluteAfterDesc'))
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.step = '1';
				text.setValue(String(this.plugin.settings.absoluteTimeAfter)).onChange(async raw => {
					const value = Number(raw);
					if (!Number.isFinite(value)) return;
					this.plugin.settings.absoluteTimeAfter = Math.max(0, value);
					await this.plugin.saveSettings();
				});
			})
			.addDropdown(dropdown => dropdown
				.addOption('hours', t('hours'))
				.addOption('days', t('days'))
				.setValue(this.plugin.settings.absoluteTimeAfterUnit)
				.onChange(async value => {
					this.plugin.settings.absoluteTimeAfterUnit = value as AbsoluteTimeAfterUnit;
					await this.plugin.saveSettings();
				}));
		absoluteAfterSetting.settingEl.addClass('line-last-modified-time-threshold-setting');
		}

		const appearanceBody = this.createCollapsibleSection(containerEl, t('appearance'), t('appearanceSectionDesc'));
		const detectedFonts = detectCommonLocalFonts();
		const fontLabels: Record<string, string> = {
			'var(--font-interface)': t('interfaceFont'),
			'var(--font-text)': t('textFont'),
			'var(--font-monospace)': t('monospaceFont'),
		};
		const currentFont = this.plugin.settings.timestampFontFamily;
		const buildFontOptions = (families: string[]): SearchableFontOption[] => [
			...OBSIDIAN_FONT_CHOICES.map(choice => ({ value: choice.value, label: fontLabels[choice.value] ?? choice.label })),
			...mergeFontFamilies(families, fontLabels[currentFont] ? [] : [currentFont]).map(family => ({ value: family, label: family })),
		];
		let fontOptions = buildFontOptions(detectedFonts);
		let fontsLoaded = false;
		const currentFontLabel = fontOptions.find(option => option.value === currentFont)?.label ?? currentFont;
		const fontSetting = new Setting(appearanceBody)
			.setName(t('fontFamily'))
			.setDesc(t('fontDesc'))
			.addText(text => {
				text.setPlaceholder(t('searchFonts')).setValue(currentFontLabel);
				const suggest = new FontInputSuggest(this.app, text.inputEl, fontOptions, option => {
					this.plugin.settings.timestampFontFamily = option.value;
					void this.plugin.saveSettings();
				});
				const parent = text.inputEl.parentElement;
				if (parent) {
					const combobox = document.createElement('div');
					combobox.className = 'line-last-modified-font-combobox';
					parent.insertBefore(combobox, text.inputEl);
					combobox.appendChild(text.inputEl);
					const openButton = document.createElement('button');
					openButton.type = 'button';
					openButton.className = 'line-last-modified-font-open';
					openButton.setAttribute('aria-label', t('openFontList'));
					setIcon(openButton, 'chevron-down');
					openButton.addEventListener('click', async event => {
						event.preventDefault();
						if (!fontsLoaded) {
							openButton.disabled = true;
							openButton.addClass('is-loading');
							const result = await scanLocalFontFamilies();
							fontOptions = buildFontOptions(result.families);
							suggest.setOptions(fontOptions);
							fontsLoaded = true;
							openButton.removeClass('is-loading');
							openButton.disabled = false;
						}
						suggest.openAll();
					});
					combobox.appendChild(openButton);
				}
				text.inputEl.addEventListener('focus', () => text.inputEl.select());
				text.inputEl.addEventListener('blur', () => window.setTimeout(() => suggest.setValue(
					fontOptions.find(option => option.value === this.plugin.settings.timestampFontFamily)?.label ?? currentFontLabel,
				), 150));
			});
		fontSetting.settingEl.addClass('line-last-modified-font-setting');
		this.addNumberSetting(appearanceBody, t('fontSize'), this.plugin.settings.timestampFontSizePx, value => {
			this.plugin.settings.timestampFontSizePx = value;
		}, 'display', t('fontSizeDesc'));
		new Setting(appearanceBody).setName(t('showTooltip')).setDesc(t('showTooltipDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.showTooltipDetails)
			.onChange(async value => { this.plugin.settings.showTooltipDetails = value; await this.plugin.saveSettings(); }));

		const currentPreset: DocumentModePreset = !this.plugin.settings.enableDocumentModes
			? 'simple'
			: this.plugin.settings.defaultDocumentMode === 'journal'
				? 'journal'
				: this.plugin.settings.defaultDocumentMode === 'knowledge'
					? 'knowledge'
					: 'auto';
		new Setting(usageBody).setName(t('modePreset')).setDesc(t('modePresetDesc')).addDropdown(dropdown => dropdown
			.addOption('auto', t('modePresetAuto'))
			.addOption('journal', t('modePresetJournal'))
			.addOption('knowledge', t('modePresetKnowledge'))
			.addOption('simple', t('modePresetSimple'))
			.setValue(currentPreset)
			.onChange(async value => {
				const preset = value as DocumentModePreset;
				this.plugin.settings.enableDocumentModes = preset !== 'simple';
				this.plugin.settings.defaultDocumentMode = preset === 'simple' ? 'auto' : preset;
				await this.plugin.saveSettings();
				this.display();
			}));
		if (this.plugin.settings.enableDocumentModes) {
			this.addListSetting(usageBody, t('journalFolderSimple'), t('journalFolderSimpleDesc'), this.plugin.settings.journalModeFolders, value => { this.plugin.settings.journalModeFolders = value; }, t('journalFolderPlaceholder'));
			this.addListSetting(usageBody, t('knowledgeFolderSimple'), t('knowledgeFolderSimpleDesc'), this.plugin.settings.knowledgeModeFolders, value => { this.plugin.settings.knowledgeModeFolders = value; }, t('knowledgeFolderPlaceholder'));
		}
		const activeFile = this.app.workspace.getActiveFile();
		const currentMode = new Setting(usageBody).setName(t('currentMode'));
		if (!this.plugin.settings.enableDocumentModes) currentMode.setDesc(t('modeSimpleStatus'));
		else if (!activeFile) currentMode.setDesc(t('noActiveNote'));
		else {
			const context = this.plugin.getDocumentContext(activeFile.path);
			const modeLabels = { normal: t('modeNormal'), knowledge: t('modeKnowledge'), journal: t('modeJournal'), off: t('modeOff') };
			const reasonLabels = { frontmatter: t('reasonFrontmatter'), folder: t('reasonFolder'), 'journal-date': t('reasonJournalDate'), default: t('reasonDefault') };
			currentMode.setDesc(t('modeStatus', { mode: modeLabels[context.mode], reason: reasonLabels[context.modeReason] }));
		}

		const advancedBody = this.createCollapsibleSection(containerEl, t('advancedModeRules'), t('advancedModeRulesDesc'));
		const detectionBody = this.createNestedSection(advancedBody, t('detectionRules'), t('detectionRulesDesc'));
		this.addListSetting(detectionBody, t('offFolders'), t('folderListDesc'), this.plugin.settings.offModeFolders, value => { this.plugin.settings.offModeFolders = value; });
		this.addListSetting(detectionBody, t('journalDateFields'), t('journalDateFieldsDesc'), this.plugin.settings.journalDateFields, value => { this.plugin.settings.journalDateFields = value; });
		new Setting(detectionBody).setName(t('journalFilenameFormat')).setDesc(t('journalFilenameFormatDesc')).addText(text => text
			.setValue(this.plugin.settings.journalFilenameFormat)
			.onChange(async value => { this.plugin.settings.journalFilenameFormat = value.trim() || 'YYYY-MM-DD'; await this.plugin.saveSettings(); }));
		if (currentPreset === 'auto' || currentPreset === 'journal') {
		const journalBody = this.createNestedSection(advancedBody, t('journalFeatures'), t('journalFeaturesDesc'));
		this.addNumberSetting(journalBody, t('journalRetrospectiveAfter'), this.plugin.settings.journalRetrospectiveAfterDays, value => { this.plugin.settings.journalRetrospectiveAfterDays = Math.max(1, value); }, 'display', t('journalRetrospectiveAfterDesc'));
		this.addNumberSetting(journalBody, t('oldJournalNoticeAfter'), this.plugin.settings.oldJournalNoticeAfterDays, value => { this.plugin.settings.oldJournalNoticeAfterDays = Math.max(0, value); }, 'display', t('oldJournalNoticeAfterDesc'));
		this.addNumberSetting(journalBody, t('journalTimezoneOffset'), this.plugin.settings.journalTimezoneOffsetMinutes, value => { this.plugin.settings.journalTimezoneOffsetMinutes = Math.max(-840, Math.min(840, value)); }, 'display', t('journalTimezoneOffsetDesc'));
		new Setting(journalBody).setName(t('journalHistoryProtection')).setDesc(t('journalHistoryProtectionDesc')).addDropdown(dropdown => dropdown
			.addOption('off', t('journalProtectionOff')).addOption('notice', t('journalProtectionNoticeOnly'))
			.addOption('confirm', t('journalProtectionConfirmFirst')).addOption('local-snapshot', t('journalProtectionSnapshot'))
			.setValue(this.plugin.settings.journalHistoryProtection)
			.onChange(async value => { this.plugin.settings.journalHistoryProtection = value as JournalHistoryProtection; await this.plugin.saveSettings(); }));
		this.addNumberSetting(journalBody, t('journalSnapshotRetention'), this.plugin.settings.journalSnapshotRetentionDays,
			value => { this.plugin.settings.journalSnapshotRetentionDays = Math.max(1, value); }, 'display', t('journalSnapshotRetentionDesc'));
		}
		const insightBody = this.createNestedSection(advancedBody, t('insightFeatures'), t('insightFeaturesDesc'));
		new Setting(insightBody).setName(t('localInsights')).setDesc(t('localInsightsDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.enableLocalInsights)
			.onChange(async value => { this.plugin.settings.enableLocalInsights = value; await this.plugin.saveSettings(); }));
		if (currentPreset === 'auto' || currentPreset === 'knowledge') {
		const knowledgeBody = this.createNestedSection(advancedBody, t('knowledgeFeatures'), t('knowledgeFeaturesDesc'));
		this.addNumberSetting(knowledgeBody, t('knowledgeReviewAfter'), this.plugin.settings.knowledgeReviewAfterDays, value => { this.plugin.settings.knowledgeReviewAfterDays = Math.max(0, value); }, 'display', t('knowledgeReviewAfterDesc'));
		this.addNumberSetting(knowledgeBody, t('knowledgeExpiresAfter'), this.plugin.settings.knowledgeExpiresAfterDays, value => { this.plugin.settings.knowledgeExpiresAfterDays = Math.max(this.plugin.settings.knowledgeReviewAfterDays, value); }, 'display', t('knowledgeExpiresAfterDesc'));
		}
		new Setting(advancedBody).setName(t('restoreModeDefaults')).setDesc(t('restoreModeDefaultsDesc')).addButton(button => button
			.setButtonText(t('restore'))
			.onClick(async () => {
				this.plugin.settings.enableDocumentModes = true;
				this.plugin.settings.defaultDocumentMode = 'auto';
				this.plugin.settings.knowledgeModeFolders = [];
				this.plugin.settings.journalModeFolders = [];
				this.plugin.settings.offModeFolders = ['Templates'];
				this.plugin.settings.journalDateFields = ['date', 'journal_date'];
				this.plugin.settings.journalFilenameFormat = 'YYYY-MM-DD';
				this.plugin.settings.journalRetrospectiveAfterDays = 7;
				this.plugin.settings.oldJournalNoticeAfterDays = 30;
				this.plugin.settings.journalTimezoneOffsetMinutes = -new Date().getTimezoneOffset();
				this.plugin.settings.journalHistoryProtection = 'off';
				this.plugin.settings.journalSnapshotRetentionDays = 30;
				this.plugin.settings.enableLocalInsights = false;
				this.plugin.settings.knowledgeReviewAfterDays = 90;
				this.plugin.settings.knowledgeExpiresAfterDays = 365;
				await this.plugin.saveSettings();
				this.display();
			}));

		const gitBody = this.createCollapsibleSection(containerEl, t('gitHistory'), t('gitSectionDesc'));
		gitBody.createEl('p', {
			cls: 'line-last-modified-settings-guidance',
			text: t('gitGuidance'),
		});
		const gitStatus = new Setting(gitBody)
			.setName(t('gitStatus'))
			.setDesc(t('checkingGit'))
			.addButton(button => button.setButtonText(t('refreshStatus')).onClick(async () => {
				button.setDisabled(true);
				await this.refreshGitStatus(gitStatus, gitGuide);
				button.setDisabled(false);
			}));
		gitStatus.settingEl.addClass('line-last-modified-git-status');
		const gitGuide = new Setting(gitBody).setName(t('gitGuide')).setDesc(t('checkingGit'));
		gitGuide.settingEl.addClass('line-last-modified-git-guide');
		void this.refreshGitStatus(gitStatus, gitGuide);
		new Setting(gitBody).setName(t('enableGit')).setDesc(t('enableGitDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.enableGitBlame)
			.onChange(async value => { this.plugin.settings.enableGitBlame = value; await this.plugin.saveSettings('git'); this.display(); }));
		if (this.plugin.settings.enableGitBlame) {
		const gitAdvancedBody = this.createNestedSection(gitBody, t('gitAdvanced'), t('gitAdvancedDesc'));
		new Setting(gitAdvancedBody).setName(t('gitExecutable'))
			.setDesc(t('gitExecutableDesc'))
			.addText(text => text
			.setValue(this.plugin.settings.gitExecutablePath)
			.onChange(async value => { this.plugin.settings.gitExecutablePath = value.trim() || 'git'; await this.plugin.saveSettings('git'); }));
		new Setting(gitAdvancedBody).setName(t('gitRepository'))
			.setDesc(t('gitRepositoryDesc'))
			.addText(text => text
				.setPlaceholder(t('useVault'))
				.setValue(this.plugin.settings.gitRepositoryPath)
				.onChange(async value => { this.plugin.settings.gitRepositoryPath = value.trim(); await this.plugin.saveSettings('git'); }));
		new Setting(gitAdvancedBody).setName(t('gitInitReview')).setDesc(t('gitInitReviewDesc')).addButton(button => button
			.setButtonText(t('gitInitButton'))
			.onClick(async () => { await this.plugin.openGitInitConfirmation(); }));
		new Setting(gitAdvancedBody).setName(t('blameMode')).setDesc(t('blameModeDesc')).addDropdown(dropdown => dropdown
			.addOption('whole-file-cache', t('wholeFile'))
			.addOption('current-line', t('currentLine'))
			.setValue(this.plugin.settings.gitBlameMode)
			.onChange(async value => { this.plugin.settings.gitBlameMode = value as GitBlameMode; await this.plugin.saveSettings('git'); }));
		new Setting(gitAdvancedBody).setName(t('ignoreWhitespace')).setDesc(t('ignoreWhitespaceDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.ignoreWhitespaceInBlame)
			.onChange(async value => { this.plugin.settings.ignoreWhitespaceInBlame = value; await this.plugin.saveSettings('git'); }));
		new Setting(gitAdvancedBody).setName(t('showAuthor')).setDesc(t('showAuthorDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.showAuthor)
			.onChange(async value => { this.plugin.settings.showAuthor = value; await this.plugin.saveSettings(); }));
		new Setting(gitAdvancedBody).setName(t('showCommit')).setDesc(t('showCommitDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.showCommitHash)
			.onChange(async value => { this.plugin.settings.showCommitHash = value; await this.plugin.saveSettings(); }));
		gitAdvancedBody.createEl('p', {
			cls: 'line-last-modified-settings-guidance',
			text: t('privacyGuidance'),
		});
		gitAdvancedBody.createEl('p', { cls: 'line-last-modified-settings-guidance', text: t('gitSyncGuidance') });
		}

		const syncBody = this.createCollapsibleSection(containerEl, t('localSync'), t('syncSectionDesc'));
		new Setting(syncBody).setName(t('trackLocal')).setDesc(t('trackLocalDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.enableLocalEditTracking)
			.onChange(async value => { this.plugin.settings.enableLocalEditTracking = value; await this.plugin.saveSettings(); }));
		new Setting(syncBody).setName(t('writeSync')).setDesc(t('writeSyncDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.enableSyncMetadata)
			.onChange(async value => { this.plugin.settings.enableSyncMetadata = value; await this.plugin.saveSettings('metadata'); this.display(); }));
		if (this.plugin.settings.enableSyncMetadata) {
		const syncAdvancedBody = this.createNestedSection(syncBody, t('syncAdvanced'), t('syncAdvancedDesc'));
		new Setting(syncAdvancedBody).setName(t('syncDir'))
			.setDesc(t('syncDirDesc'))
			.addText(text => text.setValue(this.plugin.settings.syncMetadataDir).onChange(async value => {
				const validation = validateSyncMetadataDir(value);
				if (!validation.valid) {
					new Notice(t('invalidSyncDir', { reason: t('invalidPathReason') }));
					return;
				}
				this.plugin.settings.syncMetadataDir = validation.normalized;
				await this.plugin.saveSettings('metadata');
			}));
		new Setting(syncAdvancedBody).setName(t('hideMetadata')).setDesc(t('hideMetadataDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.hideMetadataFolder)
			.onChange(async value => { this.plugin.settings.hideMetadataFolder = value; await this.plugin.saveSettings(); }));
		const privacyBody = this.createNestedSection(syncBody, t('privacySettings'), t('privacySettingsDesc'));
		new Setting(privacyBody).setName(t('deviceName')).setDesc(t('deviceNameDesc')).addText(text => text
			.setValue(this.plugin.settings.deviceName)
			.onChange(async value => { this.plugin.settings.deviceName = value.trim() || t('unnamedDevice'); await this.plugin.saveSettings('metadata'); }));
		new Setting(privacyBody).setName(t('showDevice')).setDesc(t('showDeviceDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.showDeviceName)
			.onChange(async value => { this.plugin.settings.showDeviceName = value; await this.plugin.saveSettings(); }));
		new Setting(privacyBody).setName(t('privacyMode')).setDesc(t('privacyModeDesc')).addDropdown(dropdown => dropdown
			.addOption('full', t('privacyFull'))
			.addOption('hide-author-device', t('privacyHide'))
			.addOption('timestamp-only', t('privacyTimestamp'))
			.setValue(this.plugin.settings.privacyMode)
			.onChange(async value => { this.plugin.settings.privacyMode = value as PrivacyMode; await this.plugin.saveSettings('metadata'); }));
		new Setting(privacyBody).setName(t('storePreview')).setDesc(t('storePreviewDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.storeLinePreview)
			.onChange(async value => { this.plugin.settings.storeLinePreview = value; await this.plugin.saveSettings(); }));
		new Setting(privacyBody).setName(t('storeHashes')).setDesc(t('storeHashesDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.storeContentHash)
			.onChange(async value => { this.plugin.settings.storeContentHash = value; await this.plugin.saveSettings(); }));
		const securityBody = this.createNestedSection(syncBody, t('securitySettings'), t('securitySettingsDesc'));
		new Setting(securityBody).setName(t('deviceTrust')).setDesc(t('deviceTrustDesc')).addToggle(toggle => toggle
			.setValue(this.plugin.settings.enableDeviceTrust)
			.onChange(async value => { this.plugin.settings.enableDeviceTrust = value; await this.plugin.saveSettings('metadata'); this.display(); }));
		if (this.plugin.settings.enableDeviceTrust) new Setting(securityBody).setName(t('deviceTrustManage')).setDesc(t('deviceTrustThreat')).addButton(button => button
			.setButtonText(t('deviceTrustManage')).onClick(async () => { await this.plugin.openDeviceTrust(); }));
		new Setting(securityBody).setName(t('contentHashMode')).setDesc(t('contentHashModeDesc')).addDropdown(dropdown => dropdown
			.addOption('sha256', t('contentHashStandard')).addOption('hmac-sha256', t('contentHashKeyed'))
			.setValue(this.plugin.settings.contentHashMode)
			.onChange(async value => {
				this.plugin.settings.contentHashMode = value as 'sha256' | 'hmac-sha256';
				if (value === 'hmac-sha256' && !this.plugin.settings.contentHashKey) this.plugin.settings.contentHashKey = this.plugin.generateContentHashKey();
				await this.plugin.saveSettings('metadata'); this.display();
			}));
		if (this.plugin.settings.contentHashMode === 'hmac-sha256') new Setting(securityBody).setName(t('contentHashKey')).setDesc(t('contentHashKeyDesc')).addText(text => {
			text.inputEl.type = 'password';
			text.setValue(this.plugin.settings.contentHashKey).onChange(async value => { this.plugin.settings.contentHashKey = value.trim(); await this.plugin.saveSettings('metadata'); });
		});
		if (this.plugin.settings.contentHashMode === 'hmac-sha256' && !this.plugin.settings.contentHashKey) {
			const warning = securityBody.createDiv({ cls: 'line-last-modified-setting-warning', text: t('contentHashKeyMissing') });
			warning.setAttribute('role', 'alert');
		}
		}

		const performanceBody = this.createCollapsibleSection(containerEl, t('performance'), t('performanceSectionDesc'));
		this.addNumberSetting(performanceBody, t('cursorDebounce'), this.plugin.settings.cursorDebounceMs, value => { this.plugin.settings.cursorDebounceMs = value; }, 'display', t('cursorDebounceDesc'));
		this.addNumberSetting(performanceBody, t('flushDebounce'), this.plugin.settings.editFlushDebounceMs, value => { this.plugin.settings.editFlushDebounceMs = value; }, 'display', t('flushDebounceDesc'));
		this.addNumberSetting(performanceBody, t('blameLimit'), this.plugin.settings.maxFileLinesForAutoBlame, value => { this.plugin.settings.maxFileLinesForAutoBlame = value; }, 'git', t('blameLimitDesc'));
		this.addNumberSetting(performanceBody, t('maxLogSize'), this.plugin.settings.maxEventLogSizeMB, value => { this.plugin.settings.maxEventLogSizeMB = value; }, 'display', t('maxLogSizeDesc'));
		new Setting(performanceBody).setName(t('excludedFolders')).setDesc(t('excludedFoldersDesc')).addText(text => text
			.setValue(this.plugin.settings.excludedFolders.join(', '))
			.onChange(async value => {
				this.plugin.settings.excludedFolders = value.split(',').map(item => item.trim()).filter(Boolean);
				await this.plugin.saveSettings();
			}));
		new Setting(performanceBody).setName(t('excludedFiles')).setDesc(t('excludedFilesDesc')).addText(text => text
			.setValue(this.plugin.settings.excludedFiles.join(', '))
			.onChange(async value => {
				this.plugin.settings.excludedFiles = value.split(',').map(item => item.trim()).filter(Boolean);
				await this.plugin.saveSettings();
			}));

	}

	private async refreshGitStatus(setting: Setting, guide: Setting): Promise<void> {
		const t = createTranslator(getLanguage());
		try {
			const status = await this.plugin.getGitOnboardingStatus();
			const repositoryLabels: Record<GitRepositoryState, TranslationKey> = {
				mobile: 'repoMobile', unavailable: 'repoUnavailable', none: 'repoNone', vault: 'repoVault',
				parent: 'repoParent', configured: 'repoConfigured', error: 'repoError',
			};
			const recommendation = status.repositoryState === 'mobile' ? t('gitMobileFallback')
				: status.repositoryState === 'none' ? t('gitManualInit')
					: status.repositoryState === 'error' || status.repositoryState === 'unavailable' ? t('gitCheckConfig')
						: status.hasRemote ? t('gitReady') : t('gitNoRemote');
			setting.setDesc([
				`${t('platform')}: ${status.platform}`,
				`${t('nativeGit')}: ${status.nativeGitAvailable ? t('available') : t('unavailable')}`,
				`${t('repository')}: ${t(repositoryLabels[status.repositoryState])}`,
				`${t('remote')}: ${status.hasRemote ? t('configured') : t('notConfigured')}`,
				`Obsidian Git: ${status.obsidianGitEnabled ? t('enabled') : status.obsidianGitInstalled ? t('installedDisabled') : t('notDetected')}`,
				recommendation,
				...(status.repositoryState === 'error' ? [status.detail] : []),
			].join('\n'));
			const guideKeys: Record<GitRepositoryState, TranslationKey> = {
				mobile: 'gitGuideMobile', unavailable: 'gitGuideUnavailable', none: 'gitGuideNone',
				vault: status.hasRemote ? 'gitGuideReady' : 'gitGuideRemote',
				parent: 'gitGuideParent', configured: status.hasRemote ? 'gitGuideReady' : 'gitGuideRemote',
				error: 'gitGuideError',
			};
			guide.setDesc(t(guideKeys[status.repositoryState]));
		} catch (error) {
			setting.setDesc(t('gitStatusFailed', { reason: error instanceof Error ? error.message : String(error) }));
			guide.setDesc(t('gitGuideError'));
		}
	}

	private createCollapsibleSection(container: HTMLElement, title: string, description: string): HTMLElement {
		const section = container.createEl('details', { cls: 'line-last-modified-collapsible-section' });
		const summary = section.createEl('summary');
		summary.createSpan({ cls: 'line-last-modified-collapsible-title', text: title });
		summary.createSpan({ cls: 'line-last-modified-collapsible-description', text: description });
		return section.createDiv({ cls: 'line-last-modified-collapsible-body' });
	}

	private createSettingsCard(container: HTMLElement, title: string, description: string): HTMLElement {
		const card = container.createDiv({ cls: 'line-last-modified-settings-card' });
		card.createEl('h3', { text: title });
		card.createEl('p', { cls: 'line-last-modified-settings-card-description', text: description });
		return card.createDiv({ cls: 'line-last-modified-settings-card-body' });
	}

	private createNestedSection(container: HTMLElement, title: string, description: string): HTMLElement {
		const section = container.createEl('details', { cls: 'line-last-modified-nested-section' });
		const summary = section.createEl('summary');
		summary.createSpan({ cls: 'line-last-modified-nested-title', text: title });
		summary.createSpan({ cls: 'line-last-modified-nested-description', text: description });
		return section.createDiv({ cls: 'line-last-modified-nested-body' });
	}

	private addStatusPill(container: HTMLElement, label: string, enabled: boolean, t: (key: TranslationKey) => string): void {
		const pill = container.createSpan({ cls: `line-last-modified-status-pill ${enabled ? 'is-on' : 'is-off'}` });
		pill.createSpan({ text: label });
		pill.createSpan({ cls: 'line-last-modified-status-value', text: enabled ? t('settingOn') : t('settingOff') });
	}

	private addNumberSetting(container: HTMLElement, name: string, current: number, update: (value: number) => void, scope: SettingsChangeScope = 'display', description?: string): void {
		const setting = new Setting(container).setName(name);
		if (description) setting.setDesc(description);
		setting.addText(text => {
			text.inputEl.type = 'number';
			text.setValue(String(current)).onChange(async raw => {
				const value = Number(raw);
				if (!Number.isFinite(value)) return;
				update(value);
				await this.plugin.saveSettings(scope);
			});
		});
	}

	private addListSetting(container: HTMLElement, name: string, description: string, current: string[], update: (value: string[]) => void, placeholder = ''): void {
		new Setting(container).setName(name).setDesc(description).addText(text => text
			.setPlaceholder(placeholder)
			.setValue(current.join(', '))
			.onChange(async raw => {
				update(raw.split(',').map(value => value.trim()).filter(Boolean));
				await this.plugin.saveSettings();
			}));
	}
}
