import * as monaco from 'monaco-editor';
import { initVimMode } from 'monaco-vim';
import { configureClangd } from './clangd';
import { $ } from './main';

// Per viewer, remembered in localStorage.
type Settings = { vim: boolean; completion: boolean; theme: string };

const KEY = 'settings';
const THEMES = { 'vs-dark': 'Dark', vs: 'Light', 'hc-black': 'High contrast dark', 'hc-light': 'High contrast light' };

export const settings: Settings = { vim: false, completion: true, theme: 'vs-dark' };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(KEY) ?? '{}'));
} catch {}

export function setupSettings(editor: monaco.editor.IStandaloneCodeEditor) {
  const dialog = $<HTMLDialogElement>('settings-dialog');
  const vimBox = $<HTMLInputElement>('vim');
  const completionBox = $<HTMLInputElement>('completion');
  const themeSelect = $<HTMLSelectElement>('theme');
  themeSelect.replaceChildren(...Object.entries(THEMES).map(([id, label]) => new Option(label, id)));
  $('settings').onclick = () => dialog.showModal();

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
  themeSelect.onchange = () => update({ theme: themeSelect.value });
  apply();
}
