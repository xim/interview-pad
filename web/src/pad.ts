import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { initVimMode } from 'monaco-vim';
import { MonacoBinding } from 'y-monaco';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { $, type Me } from './main';
import { setupRun } from './run';

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
};

export const LANGS = {
  c: { label: 'C', monaco: 'c', file: 'main.c', flags: '-std=c2y -O2 -Wall -Wextra' },
  cpp: { label: 'C++', monaco: 'cpp', file: 'main.cpp', flags: '-std=c++26 -O2 -Wall -Wextra' },
  python: { label: 'Python', monaco: 'python', file: 'main.py' },
  ts: { label: 'TypeScript', monaco: 'typescript', file: 'main.ts' },
} as const;
export type Lang = keyof typeof LANGS;

const COLORS = ['#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d19a66'];
// derived locally rather than taken from awareness, so remote state never reaches the stylesheet unescaped
const colorOf = (clientId: number) => COLORS[clientId % COLORS.length];
const cssString = (s: string) => `"${s.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;

type User = { name: string };

export function startPad(me: Me) {
  const doc = new Y.Doc();
  const url = new URL('ws', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const provider = new WebsocketProvider(url.href, 'pad', doc);
  const { awareness } = provider;
  awareness.setLocalStateField('user', { name: me.name } satisfies User);

  const editor = monaco.editor.create($('editor'), {
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    padding: { top: 16 }, // room for remote cursor labels on line 1
    fontSize: 14,
  });
  const models = {} as Record<Lang, monaco.editor.ITextModel>;
  for (const [lang, l] of Object.entries(LANGS) as [Lang, (typeof LANGS)[Lang]][]) {
    models[lang] = monaco.editor.createModel('', l.monaco, monaco.Uri.file(l.file));
    new MonacoBinding(doc.getText(`code:${lang}`), models[lang], new Set([editor]), awareness);
  }

  const state = doc.getMap('state');
  const currentLang = () => {
    const lang = state.get('lang') as Lang;
    return lang in LANGS ? lang : 'cpp';
  };
  const defaultFlags = (lang: Lang) => (LANGS[lang] as { flags?: string }).flags;
  const flags = (lang: Lang) => (state.get(`flags:${lang}`) as string | undefined) ?? defaultFlags(lang) ?? '';
  const runner = setupRun({ me, doc, awareness, editor, currentLang, model: (lang) => models[lang], flags });

  const flagsInput = $<HTMLInputElement>('flags');
  flagsInput.onchange = () => state.set(`flags:${currentLang()}`, flagsInput.value.trim() || defaultFlags(currentLang()));
  const applyFlags = () => {
    const lang = currentLang();
    flagsInput.hidden = defaultFlags(lang) === undefined;
    if (document.activeElement !== flagsInput) flagsInput.value = flags(lang);
  };
  state.observe(applyFlags);

  const select = $<HTMLSelectElement>('lang');
  select.replaceChildren(...Object.entries(LANGS).map(([lang, l]) => new Option(l.label, lang)));
  select.onchange = () => state.set('lang', select.value);
  const applyLang = () => {
    const lang = currentLang();
    select.value = lang;
    applyFlags();
    if (editor.getModel() === models[lang]) return;
    editor.setModel(models[lang]);
    runner.preload(lang);
  };
  state.observe(applyLang);
  applyLang();

  const vimBox = $<HTMLInputElement>('vim');
  let vim: { dispose(): void } | undefined;
  const applyVim = () => {
    vim?.dispose();
    vim = vimBox.checked ? initVimMode(editor, $('vim-status')) : undefined;
    $('vim-status').hidden = !vimBox.checked;
    try {
      localStorage.setItem('vim', vimBox.checked ? '1' : '0');
    } catch {}
  };
  try {
    vimBox.checked = localStorage.getItem('vim') === '1';
  } catch {}
  vimBox.onchange = applyVim;
  applyVim();

  const style = document.head.appendChild(document.createElement('style'));
  const renderPeers = () => {
    const users = [...awareness.getStates()].filter(([, s]) => s.user).map(([id, s]) => [id, s.user as User] as const);
    style.textContent = users
      .map(([id, u]) => `
        .yRemoteSelection-${id} { background-color: ${colorOf(id)}40; }
        .yRemoteSelectionHead-${id} { border-left: 2px solid ${colorOf(id)}; }
        .yRemoteSelectionHead-${id}::after { content: ${cssString(u.name)}; background: ${colorOf(id)}; }`)
      .join('');
    $('participants').replaceChildren(...users.map(([id, u]) => {
      const span = document.createElement('span');
      span.className = 'participant';
      span.style.setProperty('--color', colorOf(id));
      span.textContent = id === doc.clientID ? `${u.name} (you)` : u.name;
      return span;
    }));
  };
  awareness.on('change', renderPeers);
  renderPeers();

  provider.on('status', ({ status }) => {
    $('conn').textContent = status === 'connected' ? '' : status;
  });
}
