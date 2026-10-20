export type Me = { name: string; role: 'interviewer' | 'candidate'; status: 'pending' | 'admitted' | 'denied' };
type Pending = { id: string; name: string };

const POLL_MS = 1000;

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`api/${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new ApiError(r.status, await r.text());
  return r.json();
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function show(id: 'landing' | 'waiting' | 'pad') {
  for (const s of document.querySelectorAll('body > section')) (s as HTMLElement).hidden = s.id !== id;
}

function route(me: Me) {
  if (me.status === 'admitted') return enterPad(me);
  show('waiting');
  if (me.status === 'denied') {
    $('waiting-text').textContent = 'The interviewer did not let you in.';
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

async function pollRequests() {
  setTimeout(pollRequests, POLL_MS);
  const pending = await api<Pending[]>('pending').catch(() => [] as Pending[]);
  const ids = pending.map((p) => p.id).join();
  if (ids === shownRequests) return;
  shownRequests = ids;
  document.title = pending.length ? `(${pending.length}) Join request — interview-pad` : 'interview-pad';
  const dialog = $<HTMLDialogElement>('requests-dialog');
  if (!pending.length) return dialog.close();
  $('requests').replaceChildren(...pending.map(({ id, name }) => {
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
        if (!$('requests').children.length) dialog.close();
        await api(`admit/${encodeURIComponent(id)}`, { admit });
      };
      return b;
    };
    row.append(label, button('Admit', true), button('Deny', false));
    return row;
  }));
  if (!dialog.open) dialog.showModal();
}

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

api<Me>('me').then(route, () => show('landing'));
