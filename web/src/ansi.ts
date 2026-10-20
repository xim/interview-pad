// Renders text with ANSI SGR escapes (bold/faint/italic/underline, 16 colors, reset) as spans; other escape
// sequences are dropped. Colors come from CSS (.ansi-fg-N), tuned for the output pane's background.
export function renderAnsi(text: string, into: HTMLElement) {
  const out = document.createDocumentFragment();
  let classes: string[] = [];
  let last = 0;
  const push = (s: string) => {
    if (!s) return;
    if (!classes.length) return void out.append(s);
    const span = document.createElement('span');
    span.className = classes.join(' ');
    span.textContent = s;
    out.append(span);
  };
  for (const m of text.matchAll(/\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]/g)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] === undefined) continue;
    for (const code of (m[1] || '0').split(';').map(Number)) {
      const drop = (prefix: string) => (classes = classes.filter((c) => !c.startsWith(prefix)));
      if (code === 0) classes = [];
      else if (code === 1) classes.push('ansi-bold');
      else if (code === 2) classes.push('ansi-faint');
      else if (code === 3) classes.push('ansi-italic');
      else if (code === 4) classes.push('ansi-underline');
      else if (code === 22) drop('ansi-bold'), drop('ansi-faint');
      else if (code === 23) drop('ansi-italic');
      else if (code === 24) drop('ansi-underline');
      else if (code === 39) drop('ansi-fg');
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        drop('ansi-fg');
        classes.push(`ansi-fg-${code < 90 ? code - 30 : code - 90 + 8}`);
      }
    }
  }
  push(text.slice(last));
  into.replaceChildren(out);
}
