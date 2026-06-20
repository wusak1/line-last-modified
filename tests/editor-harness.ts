import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createLineTimestampExtension } from '../src/editor-extension';
import { DEFAULT_SETTINGS } from '../src/types';

const parent = document.querySelector<HTMLElement>('#editor');
const result = document.querySelector<HTMLElement>('#result');
if (!parent || !result) throw new Error('Harness container missing');

let changeCount = 0;
let resolveCount = 0;

const state = EditorState.create({
	doc: 'alpha\nbeta\ngamma',
	selection: { anchor: 6 },
	extensions: createLineTimestampExtension({
		settings: () => ({ ...DEFAULT_SETTINGS, cursorDebounceMs: 0 }),
		getFilePath: () => 'note.md',
		onDocumentChanged: () => { changeCount += 1; },
		resolve: async query => {
			resolveCount += 1;
			return {
				text: `stamp:${query.lineText}`,
				tooltip: `line ${query.lineNumber}`,
				source: 'local',
			};
		},
	}),
});

const view = new EditorView({ state, parent });

function report(): void {
	const widgets = [...document.querySelectorAll<HTMLElement>('.llm-current-line-timestamp')];
	result.textContent = JSON.stringify({
		doc: view.state.doc.toString(),
		cursorLine: view.state.doc.lineAt(view.state.selection.main.head).number,
		widgets: widgets.map(widget => widget.textContent),
		changeCount,
		resolveCount,
	}, null, 2);
}

const observer = new MutationObserver(report);
observer.observe(parent, { childList: true, subtree: true, characterData: true });
window.setInterval(report, 20);
report();
