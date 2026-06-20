import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { editorInfoField } from 'obsidian';
import {
	Decoration,
	type DecorationSet,
	EditorView,
	GutterMarker,
	type PluginValue,
	type ViewUpdate,
	ViewPlugin,
	WidgetType,
	gutter,
} from '@codemirror/view';
import type { DisplayInfo, LineLastModifiedSettings, LineQuery } from './types';
import { timestampFontFamily, timestampFontSizePx } from './utils';
import { nextTimestampRefreshDelay } from './refresh-scheduler';
import { compactGutterLabel } from './placement-display';

interface DisplayPayload {
	lineNumber: number;
	info: DisplayInfo;
}

export interface LineTimestampHost {
	settings: () => LineLastModifiedSettings;
	getFilePath: (view: EditorView) => string | null;
	resolve: (query: LineQuery, lineCount: number) => Promise<DisplayInfo>;
	onDocumentChanged: (update: ViewUpdate, filePath: string) => void;
	onDisplay?: (view: EditorView, info: DisplayInfo | null) => void;
	onOpenHistory?: (view: EditorView) => void;
	beforeDocumentChange?: (filePath: string, previousContent: string) => boolean;
}

const setDisplayEffect = StateEffect.define<DisplayPayload | null>();
export const refreshLineTimestampEffect = StateEffect.define<null>();

const displayField = StateField.define<DisplayPayload | null>({
	create: () => null,
	update(value, transaction) {
		for (const effect of transaction.effects) if (effect.is(setDisplayEffect)) return effect.value;
		return value;
	},
});

class LineTimestampWidget extends WidgetType {
	constructor(
		private readonly info: DisplayInfo,
		private readonly fontFamily: string,
		private readonly fontSizePx: number,
		private readonly openHistory?: () => void,
	) { super(); }

	eq(other: LineTimestampWidget): boolean {
		return this.info.text === other.info.text && this.info.tooltip === other.info.tooltip &&
			this.info.source === other.info.source && this.info.modeLabel === other.info.modeLabel &&
			this.info.modeState === other.info.modeState && this.fontFamily === other.fontFamily &&
			this.fontSizePx === other.fontSizePx;
	}

	toDOM(): HTMLElement {
		const element = document.createElement('span');
		element.className = `llm-current-line-timestamp llm-source-${this.info.source}`;
		if (this.info.potentialConflict) element.classList.add('llm-conflict');
		if (this.info.timeUncertain || this.info.source === 'error') element.classList.add('llm-error');
		if (this.info.modeLabel) {
			const badge = element.createSpan({ cls: `llm-mode-badge llm-mode-${this.info.modeState ?? 'default'}` });
			badge.setText(this.info.modeLabel);
		}
		const timestamp = element.createSpan({ cls: 'llm-timestamp-text' });
		timestamp.setText(this.info.text);
		element.setAttribute('aria-label', this.info.tooltip || this.info.text);
		if (this.openHistory) {
			element.classList.add('is-clickable');
			element.setAttribute('role', 'button');
			element.tabIndex = 0;
			element.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); this.openHistory?.(); });
			element.addEventListener('keydown', event => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				this.openHistory?.();
			});
		}
		element.setAttribute('contenteditable', 'false');
		element.style.fontFamily = this.fontFamily;
		element.style.fontSize = `${this.fontSizePx}px`;
		return element;
	}

	ignoreEvent(): boolean { return true; }
}

function buildDecorations(view: EditorView, settings: LineLastModifiedSettings, openHistory?: () => void): DecorationSet {
	if (settings.timestampPlacement !== 'inline') return Decoration.none;
	const payload = view.state.field(displayField);
	if (!payload?.info.text) return Decoration.none;
	const cursorLine = view.state.doc.lineAt(view.state.selection.main.head);
	if (payload.lineNumber !== cursorLine.number) return Decoration.none;
	return Decoration.set([
		Decoration.widget({
			widget: new LineTimestampWidget(
				payload.info,
				timestampFontFamily(settings),
				timestampFontSizePx(settings),
				openHistory,
			),
			side: 1,
		}).range(cursorLine.to),
	]);
}

class LineHistoryGutterMarker extends GutterMarker {
	constructor(private readonly info: DisplayInfo, private readonly openHistory?: () => void) { super(); }

	eq(other: LineHistoryGutterMarker): boolean { return this.info.tooltip === other.info.tooltip && this.info.text === other.info.text; }

	toDOM(): HTMLElement {
		const element = document.createElement('span');
		element.className = 'llm-gutter-marker';
		element.textContent = compactGutterLabel(this.info);
		element.setAttribute('role', 'button');
		element.tabIndex = 0;
		element.setAttribute('aria-label', this.info.tooltip || this.info.text);
		element.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); this.openHistory?.(); });
		element.addEventListener('keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			this.openHistory?.();
		});
		return element;
	}
}

const historyGutter = (settings: () => LineLastModifiedSettings, openHistory?: (view: EditorView) => void) => gutter({
	class: 'llm-history-gutter',
	lineMarker(view, line) {
		if (settings().timestampPlacement !== 'gutter') return null;
		const payload = view.state.field(displayField);
		if (!payload?.info.text) return null;
		const cursorLine = view.state.doc.lineAt(view.state.selection.main.head);
		return payload.lineNumber === cursorLine.number && line.from === cursorLine.from ? new LineHistoryGutterMarker(payload.info, () => openHistory?.(view)) : null;
	},
});

function queryFor(view: EditorView, filePath: string): LineQuery {
	const document = view.state.doc;
	const line = document.lineAt(view.state.selection.main.head);
	return {
		filePath,
		lineNumber: line.number,
		lineText: line.text,
		beforeLine: line.number > 1 ? document.line(line.number - 1).text : undefined,
		afterLine: line.number < document.lines ? document.line(line.number + 1).text : undefined,
	};
}

export function createLineTimestampExtension(host: LineTimestampHost): Extension {
	const protectionFilter = EditorState.transactionFilter.of(transaction => {
		if (!transaction.docChanged || !host.beforeDocumentChange) return transaction;
		const isUserEdit = transaction.isUserEvent('input') || transaction.isUserEvent('delete') ||
			transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.isUserEvent('move');
		if (!isUserEdit) return transaction;
		const file = transaction.startState.field(editorInfoField, false)?.file;
		return !file || host.beforeDocumentChange(file.path, transaction.startState.doc.toString()) ? transaction : [];
	});
	const plugin = ViewPlugin.fromClass(class implements PluginValue {
		decorations: DecorationSet;
		private timer: number | undefined;
		private boundaryTimer: number | undefined;
		private requestSerial = 0;
		private destroyed = false;

		constructor(private readonly view: EditorView) {
			this.decorations = buildDecorations(view, host.settings(), () => host.onOpenHistory?.(view));
			this.scheduleResolve();
		}

		update(update: ViewUpdate): void {
			const filePath = host.getFilePath(update.view);
			if (update.docChanged && filePath) {
				try {
					host.onDocumentChanged(update, filePath);
				} catch (error) {
					console.error('Line Last Modified: failed to track document change', error);
				}
			}
			const refreshRequested = update.transactions.some(transaction =>
				transaction.effects.some(effect => effect.is(refreshLineTimestampEffect))
			);
			const displayChanged = update.transactions.some(transaction =>
				transaction.effects.some(effect => effect.is(setDisplayEffect))
			);
			if (update.selectionSet || update.docChanged || refreshRequested) this.scheduleResolve();
			if (update.selectionSet || update.docChanged || displayChanged || refreshRequested) {
				this.decorations = buildDecorations(update.view, host.settings(), () => host.onOpenHistory?.(update.view));
			}
		}

		destroy(): void {
			this.destroyed = true;
			this.requestSerial++;
			if (this.timer !== undefined) window.clearTimeout(this.timer);
			if (this.boundaryTimer !== undefined) window.clearTimeout(this.boundaryTimer);
			host.onDisplay?.(this.view, null);
		}

		private scheduleResolve(): void {
			if (this.timer !== undefined) window.clearTimeout(this.timer);
			if (this.boundaryTimer !== undefined) { window.clearTimeout(this.boundaryTimer); this.boundaryTimer = undefined; }
			const serial = ++this.requestSerial;
			this.timer = window.setTimeout(() => {
				this.timer = undefined;
				void this.resolve(serial);
			}, Math.max(0, host.settings().cursorDebounceMs));
		}

		private async resolve(serial: number): Promise<void> {
			const filePath = host.getFilePath(this.view);
			if (!filePath) return;
			const query = queryFor(this.view, filePath);
			try {
				const info = await host.resolve(query, this.view.state.doc.lines);
				if (this.destroyed || serial !== this.requestSerial) return;
				const current = queryFor(this.view, filePath);
				if (current.lineNumber !== query.lineNumber || current.lineText !== query.lineText) return;
				this.view.dispatch({ effects: setDisplayEffect.of({ lineNumber: query.lineNumber, info }) });
				host.onDisplay?.(this.view, info);
				const delay = nextTimestampRefreshDelay(info, host.settings());
				if (delay !== null) this.boundaryTimer = window.setTimeout(() => {
					this.boundaryTimer = undefined;
					this.scheduleResolve();
				}, delay);
			} catch (error) {
				console.error('Line Last Modified: failed to resolve current line', error);
			}
		}
	}, { decorations: value => value.decorations });

	return [displayField, protectionFilter, historyGutter(host.settings, host.onOpenHistory), plugin];
}
