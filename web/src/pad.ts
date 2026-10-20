import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { MonacoBinding } from 'y-monaco';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { $, type Me } from './main';

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
};

export const LANGS = {
  cpp: { label: 'C++', monaco: 'cpp', file: 'main.cpp' },
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
    fontSize: 14,
  });
  const models = {} as Record<Lang, monaco.editor.ITextModel>;
  for (const [lang, l] of Object.entries(LANGS) as [Lang, (typeof LANGS)[Lang]][]) {
    models[lang] = monaco.editor.createModel('', l.monaco, monaco.Uri.file(l.file));
    new MonacoBinding(doc.getText(`code:${lang}`), models[lang], new Set([editor]), awareness);
  }

  const state = doc.getMap('state');
  const select = $<HTMLSelectElement>('lang');
  select.replaceChildren(...Object.entries(LANGS).map(([lang, l]) => new Option(l.label, lang)));
  select.onchange = () => state.set('lang', select.value);
  const applyLang = () => {
    const lang = (state.get('lang') ?? 'cpp') as Lang;
    if (!(lang in LANGS)) return;
    select.value = lang;
    if (editor.getModel() !== models[lang]) editor.setModel(models[lang]);
  };
  state.observe(applyLang);
  applyLang();

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
