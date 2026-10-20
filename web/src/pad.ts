import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { MonacoBinding } from 'y-monaco';
import { WebsocketProvider } from 'y-websocket';
import { removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { $, api, route, type Me } from './main';
import { setupRun } from './run';
import { registerPythonIntelligence } from './completion';
import { settings, setupSettings } from './settings';

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
};

const COMMON_FLAGS = '-O2 -Wall -Wextra';

export const LANGS = {
  c: { label: 'C', monaco: 'c', file: 'main.c', flags: `-std=c2y ${COMMON_FLAGS}` },
  cpp: {
    label: 'C++',
    monaco: 'cpp',
    file: 'main.cpp',
    flags: `-std=c++26 ${COMMON_FLAGS}`,
  },
  python: { label: 'Python', monaco: 'python', file: 'main.py' },
  ts: { label: 'TypeScript', monaco: 'typescript', file: 'main.ts' },
} as const;
export type Lang = keyof typeof LANGS;

const INTERVIEWER_COLOR = '#98c379';
const CANDIDATE_COLORS = ['#61afef', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#e06c75'];
const cssString = (s: string) => `"${s.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;

type User = { name: string; role: Me['role'] };

export function startPad(me: Me) {
  const doc = new Y.Doc();
  const url = new URL('ws', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const provider = new WebsocketProvider(url.href, 'pad', doc);
  const { awareness } = provider;
  awareness.setLocalStateField('user', { name: me.name, role: me.role } satisfies User);

  const editor = monaco.editor.create($('editor'), {
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    padding: { top: 16 }, // room for remote cursor labels on line 1
    fontSize: 14,
  });
  registerPythonIntelligence(() => settings.completion);
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

  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')];
  const showTab = (name: string) => {
    for (const t of tabs) {
      t.classList.toggle('active', t.dataset.tab === name);
      $(t.dataset.tab!).hidden = t.dataset.tab !== name;
    }
  };
  for (const t of tabs) t.onclick = () => showTab(t.dataset.tab!);
  showTab('output');
  $('run').addEventListener('click', () => showTab('output'));

  const main = document.querySelector('main')!;
  const splitter = $('splitter');
  splitter.onpointerdown = (e) => {
    splitter.setPointerCapture(e.pointerId);
    splitter.onpointermove = (e) => {
      const r = main.getBoundingClientRect();
      $('left').style.flexBasis = `${Math.min(85, Math.max(15, ((e.clientX - r.left) / r.width) * 100))}%`;
    };
  };
  splitter.onpointerup = () => (splitter.onpointermove = null);

  const inputFields = { args: $<HTMLInputElement>('args'), stdin: $<HTMLTextAreaElement>('stdin') };
  for (const [key, field] of Object.entries(inputFields)) field.oninput = () => state.set(key, field.value);
  const applyInput = () => {
    for (const [key, field] of Object.entries(inputFields)) {
      if (document.activeElement !== field) field.value = (state.get(key) as string) ?? '';
    }
    tabs[1].textContent = Object.keys(inputFields).some((k) => state.get(k)) ? 'Input •' : 'Input';
  };
  state.observe(applyInput);
  applyInput();

  setupSettings(editor);

  const style = document.head.appendChild(document.createElement('style'));
  const renderPeers = () => {
    const users = [...awareness.getStates()]
      .filter(([, s]) => s.user)
      .map(([id, s]) => [id, s.user as User] as const)
      .sort(([a], [b]) => a - b);
    // interviewers green, candidates by position among connected candidates (all clients agree, no collisions);
    // derived locally so remote awareness state never reaches the stylesheet unescaped
    const candidates = users.filter(([, u]) => u.role !== 'interviewer').map(([id]) => id);
    const colors = new Map(users.map(([id, u]) => [id, u.role === 'interviewer' ? INTERVIEWER_COLOR : CANDIDATE_COLORS[candidates.indexOf(id) % CANDIDATE_COLORS.length]]));
    const colorOf = (id: number) => colors.get(id)!;
    style.textContent = users
      .map(([id, u]) => `
        .yRemoteSelection-${id} { background-color: ${colorOf(id)}40; }
        .yRemoteSelectionHead-${id} { border-left: 2px solid ${colorOf(id)}; }
        .yRemoteSelectionHead-${id}::after { content: ${cssString(u.name)}; background: ${colorOf(id)}99; }`)
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

  // y-websocket retries silently forever; make a lost connection impossible to miss
  const showOffline = () => ($('offline').hidden = false);
  let offlineTimer = setTimeout(showOffline, 1500);
  provider.on('status', ({ status }) => {
    clearTimeout(offlineTimer);
    if (status === 'connected') $('offline').hidden = true;
    else offlineTimer = setTimeout(showOffline, 1500);
  });
  provider.on('connection-close', async () => {
    const now = await api<Me>('me').catch(() => me);
    if (now.status === 'admitted') return;
    provider.destroy();
    route(now);
  });

  const endButton = $<HTMLButtonElement>('end');
  endButton.hidden = me.role !== 'interviewer';
  endButton.onclick = async () => {
    if (!confirm('End the interview? This disconnects all candidates.')) return;
    await api('end', {});
    // kicked clients can't announce leaving, and the server doesn't track awareness per socket
    const candidates = [...awareness.getStates()].filter(([, s]) => s.user?.role === 'candidate').map(([id]) => id);
    removeAwarenessStates(awareness, candidates, 'end');
  };
}
