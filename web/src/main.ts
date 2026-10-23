export type Me = { name: string; role: 'interviewer' | 'candidate' | 'demo'; status: 'pending' | 'admitted' | 'denied' | 'ended' };
type Pending = { id: string; name: string };

const POLL_MS = 1000;

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let hasSession = false;

// Sent besides the cookie: code we run (always in workers) can't read localStorage, so it can't act as the user.
const TOKEN = 'token';
let token = '';
try {
  token = localStorage.getItem(TOKEN) ?? '';
} catch {}
function setToken(value: string) {
  token = value;
  try {
    localStorage.setItem(TOKEN, value);
  } catch {}
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`api/${path}`, {
    headers: { 'X-Pad-Token': token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
  });
  // sessions live in server memory, so a restart (or cleared cookie) silently invalidates ours
  if (hasSession && (r.status === 401 || r.status === 403)) sessionLost();
  if (!r.ok) throw new ApiError(r.status, await r.text());
  const data = await r.json();
  if (data.token) setToken(data.token);
  return data;
}

export const forgetToken = () => setToken('');

const NOTICE = 'notice';

function sessionLost() {
  forgetToken();
  try {
    sessionStorage.setItem(NOTICE, 'Your session ended (the server may have restarted). Please join or log in again.');
  } catch {}
  location.reload();
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function show(id: 'landing' | 'waiting' | 'pad') {
  for (const s of document.querySelectorAll('body > section')) (s as HTMLElement).hidden = s.id !== id;
}

export function route(me: Me) {
  hasSession = true;
  if (me.status === 'admitted') return enterPad(me);
  show('waiting');
  if (me.status === 'denied' || me.status === 'ended') {
    $('waiting-text').textContent = me.status === 'denied' ? 'The interviewer did not let you in.' : 'The interview has ended.';
    return;
  }
  $('waiting-text').textContent = `Hi ${me.name}, waiting for the interviewer to let you in…`;
  setTimeout(() => api<Me>('me').then(route, () => route(me)), POLL_MS);
}

async function enterPad(me: Me) {
  show('pad');
  (await import('./pad')).startPad(me);
  if (me.role === 'interviewer') pollRequests();
}

let shownRequests = '';
// Only the first request(s) get a modal; later ones are banners, so join spam can't keep popping modals.
let modalUsed = false;

async function pollRequests() {
  setTimeout(pollRequests, POLL_MS);
  const pending = await api<Pending[]>('pending').catch(() => [] as Pending[]);
  document.title = pending.length ? `(${pending.length}) Join request — interview-pad` : 'interview-pad';
  const ids = pending.map((p) => p.id).join();
  if (ids === shownRequests) return;
  shownRequests = ids;
  const dialog = $<HTMLDialogElement>('requests-dialog');
  const box = modalUsed ? $('request-banners') : $('requests');
  if (!pending.length) {
    $('request-banners').replaceChildren();
    return dialog.close();
  }
  box.replaceChildren(...pending.map(({ id, name }) => {
    const row = document.createElement('div');
    row.className = 'request';
    const label = document.createElement('span');
    label.textContent = `${name} wants to join`;
    const button = (text: string, admit: boolean) => {
      const b = document.createElement('button');
      b.textContent = text;
      if (!admit) b.className = 'secondary';
      b.onclick = async () => {
        row.remove();
        if (!modalUsed && !box.children.length) dialog.close();
        await api(`admit/${encodeURIComponent(id)}`, { admit });
      };
      return b;
    };
    row.append(label, button('Admit', true), button('Deny', false));
    return row;
  }));
  if (!modalUsed && !dialog.open) dialog.showModal();
}

for (const b of document.querySelectorAll<HTMLButtonElement>('button.about')) {
  b.onclick = () => $<HTMLDialogElement>('about-dialog').showModal();
}

$('requests-dialog').addEventListener('close', () => {
  modalUsed = true;
  shownRequests = ''; // re-render anything still pending as banners
});

function onSubmit(formId: string, submit: (data: FormData) => Promise<Me>) {
  $<HTMLFormElement>(formId).onsubmit = async (e) => {
    e.preventDefault();
    try {
      route(await submit(new FormData(e.target as HTMLFormElement)));
    } catch (err) {
      $('landing-error').textContent = err instanceof ApiError ? err.message : String(err);
    }
  };
}

onSubmit('join-form', (d) => api<Me>('join', { name: d.get('name') }));
onSubmit('login-form', (d) => api<Me>('login', { name: d.get('name'), password: d.get('password') }));
$('demo').onclick = async () => route(await api<Me>('demo', {}));

api<Me>('me').then(route, () => {
  show('landing');
  try {
    $('landing-error').textContent = sessionStorage.getItem(NOTICE) ?? '';
    sessionStorage.removeItem(NOTICE);
  } catch {}
});
