import * as monaco from 'monaco-editor';

declare const __BUILD_TIME__: string; // vite.config.ts
import { initVimMode, VimMode } from 'monaco-vim';
import { configureClangd } from './clangd';
import { $ } from './main';

type CmPos = { line: number; ch: number };
type Cm = { getLine(line: number): string; findMatchingBracket(pos: CmPos): { to: CmPos | null } };
const { Vim, Pos } = VimMode as unknown as {
  Vim: { defineMotion(name: string, fn: (cm: Cm, head: CmPos) => CmPos): void };
  Pos: new (line: number, ch: number) => CmPos;
};

// monaco-vim's % only acts with the cursor on a bracket; Vim scans forward along the line to the first one
// (brackets in strings/comments have no match in Monaco, so they're skipped).
Vim.defineMotion('moveToMatchedSymbol', (cm, head) => {
  const text = cm.getLine(head.line);
  for (let ch = head.ch; ch < text.length; ch++) {
    if (!'()[]{}'.includes(text[ch])) continue;
    const { to } = cm.findMatchingBracket(new Pos(head.line, ch));
    if (to) return to;
  }
  return head;
});

// Per viewer, remembered in localStorage.
type Settings = { vim: boolean; completion: boolean; inlayHints: boolean; theme: string };

const KEY = 'settings';
const THEMES = { 'vs-dark': 'Dark', vs: 'Light', 'hc-black': 'High contrast dark', 'hc-light': 'High contrast light' };

export const settings: Settings = { vim: false, completion: true, inlayHints: false, theme: 'vs-dark' };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(KEY) ?? '{}'));
} catch {}

export function setupSettings(editor: monaco.editor.IStandaloneCodeEditor) {
  const dialog = $<HTMLDialogElement>('settings-dialog');
  const vimBox = $<HTMLInputElement>('vim');
  const completionBox = $<HTMLInputElement>('completion');
  const inlayHintsBox = $<HTMLInputElement>('inlay-hints');
  const themeSelect = $<HTMLSelectElement>('theme');
  themeSelect.replaceChildren(...Object.entries(THEMES).map(([id, label]) => new Option(label, id)));
  $('settings').onclick = () => dialog.showModal();
  $('build').textContent = `Build ${__BUILD_TIME__}`;

  let vim: { dispose(): void } | undefined;
  const apply = () => {
    vim?.dispose();
    vim = settings.vim ? initVimMode(editor, $('vim-status')) : undefined;
    $('vim-status').hidden = !settings.vim;

    const on = settings.completion;
    editor.updateOptions({
      quickSuggestions: on,
      suggestOnTriggerCharacters: on,
      parameterHints: { enabled: on },
      wordBasedSuggestions: on ? 'matchingDocuments' : 'off',
      // e.g. clangd's `v{[0]=1}` and `println(fmt: ...)`
      inlayHints: { enabled: settings.inlayHints ? 'on' : 'off' },
    });
    // Python's providers check settings.completion themselves (completion.ts); clangd's worker drops requests
    configureClangd({ completion: on });
    monaco.typescript.typescriptDefaults.setModeConfiguration({
      ...monaco.typescript.typescriptDefaults.modeConfiguration,
      completionItems: on,
      signatureHelp: on,
    });

    monaco.editor.setTheme(settings.theme);
    vimBox.checked = settings.vim;
    completionBox.checked = settings.completion;
    inlayHintsBox.checked = settings.inlayHints;
    themeSelect.value = settings.theme;
  };
  const update = (patch: Partial<Settings>) => {
    Object.assign(settings, patch);
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {}
    apply();
  };
  vimBox.onchange = () => update({ vim: vimBox.checked });
  completionBox.onchange = () => update({ completion: completionBox.checked });
  inlayHintsBox.onchange = () => update({ inlayHints: inlayHintsBox.checked });
  themeSelect.onchange = () => update({ theme: themeSelect.value });
  apply();
}
