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

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

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

function enterPad(me: Me) {
  show('pad');
  $('pad-placeholder').textContent = `Welcome, ${me.name} (${me.role}).`;
  if (me.role === 'interviewer') pollRequests();
}

async function pollRequests() {
  const box = $('requests');
  const pending = await api<Pending[]>('pending').catch(() => [] as Pending[]);
  box.replaceChildren(...pending.map(({ id, name }) => {
    const row = document.createElement('div');
    row.className = 'request';
    const label = document.createElement('span');
    label.textContent = `${name} wants to join`;
    const button = (text: string, admit: boolean) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.onclick = async () => {
        row.remove();
        await api(`admit/${encodeURIComponent(id)}`, { admit });
      };
      return b;
    };
    row.append(label, button('Admit', true), button('Deny', false));
    return row;
  }));
  setTimeout(pollRequests, POLL_MS);
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
onSubmit('login-form', (d) => api<Me>('login', { password: d.get('password') }));

api<Me>('me').then(route, () => show('landing'));
