// In-page UI: a small status pill and the "both sides changed" prompt.
// Rendered inside a shadow root so LeetCode's styles and ours never collide.

import type { Status, StatusKind } from '../core/messages';
import type { ConflictHandlers } from './controller';

const STYLE = `
:host { all: initial; }
.wrap {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  pointer-events: none;
}
.pill, .card { pointer-events: auto; color: #e8eaed; background: #24292f;
  border: 1px solid rgba(255,255,255,.14); box-shadow: 0 2px 10px rgba(0,0,0,.28); }
.pill {
  display: none; align-items: center; gap: 6px; max-width: 260px;
  padding: 4px 10px 4px 8px; border-radius: 999px; cursor: default;
  opacity: .82; transition: opacity .15s;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pill:hover { opacity: 1; }
.pill.show { display: inline-flex; }
.pill.clickable { cursor: pointer; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #8b949e; }
.k-synced .dot, .k-saved .dot, .k-loaded .dot { background: #3fb950; }
.k-saving .dot, .k-checking .dot { background: #58a6ff; animation: pulse 1s ease-in-out infinite; }
.k-conflict .dot, .k-unconfigured .dot { background: #d29922; }
.k-error .dot { background: #f85149; }
@keyframes pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
.card { display: none; width: 280px; padding: 12px; border-radius: 10px; }
.card.show { display: block; }
.card h2 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
.card p { margin: 0 0 10px; color: #b1bac4; }
.row { display: flex; gap: 8px; align-items: center; }
button {
  font: inherit; font-weight: 600; padding: 5px 10px; border-radius: 6px; cursor: pointer;
  color: #e8eaed; background: #373e47; border: 1px solid rgba(255,255,255,.16);
}
button:hover { background: #444c56; }
button.primary { background: #238636; border-color: #2ea043; }
button.primary:hover { background: #2ea043; }
button.ghost { margin-left: auto; background: none; border-color: transparent; color: #b1bac4; font-weight: 400; }
button:focus-visible, .pill:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
`;

export interface UiCallbacks {
  /** The pill was clicked while in the given state. */
  onPillClick(kind: StatusKind, status: Status): void;
}

export class SyncUi {
  private readonly pill: HTMLElement;
  private readonly label: HTMLElement;
  private readonly card: HTMLElement;
  private readonly useGitBtn: HTMLButtonElement;
  private readonly keepMineBtn: HTMLButtonElement;
  private status: Status = { kind: 'hidden', text: '' };
  private handlers: ConflictHandlers | null = null;

  constructor(callbacks: UiCallbacks) {
    const host = document.createElement('div');
    host.id = 'lcgit-root';
    // Open so browser tests can reach it; the page gains nothing it could not
    // already do by editing its own code box.
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;

    const wrap = el('div', 'wrap');

    this.card = el('div', 'card');
    this.card.setAttribute('role', 'alertdialog');
    this.card.setAttribute('aria-label', 'Git sync conflict');
    const title = el('h2', '', 'This problem differs from git');
    const body = el('p', '', 'The code box and your repo both changed since the last sync. Which version do you want?');
    const row = el('div', 'row');
    this.useGitBtn = button('Use git', 'primary');
    this.keepMineBtn = button('Keep mine');
    const later = button('Later', 'ghost');
    row.append(this.useGitBtn, this.keepMineBtn, later);
    this.card.append(title, body, row);

    this.pill = el('div', 'pill');
    this.pill.setAttribute('role', 'status');
    this.pill.tabIndex = 0;
    this.label = el('span');
    this.pill.append(el('span', 'dot'), this.label);

    wrap.append(this.card, this.pill);
    root.append(style, wrap);

    this.useGitBtn.addEventListener('click', () => this.handlers?.useGit());
    this.keepMineBtn.addEventListener('click', () => this.handlers?.keepMine());
    later.addEventListener('click', () => this.card.classList.remove('show'));
    const activate = (): void => callbacks.onPillClick(this.status.kind, this.status);
    this.pill.addEventListener('click', activate);
    this.pill.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });

    (document.body ?? document.documentElement).append(host);
  }

  setStatus(status: Status): void {
    this.status = status;
    const clickable =
      status.kind === 'unconfigured' || status.kind === 'conflict' || status.kind === 'error' || !!status.fileUrl;
    this.pill.className = `pill k-${status.kind}${status.kind === 'hidden' ? '' : ' show'}${clickable ? ' clickable' : ''}`;
    this.label.textContent = status.text;
    const hint =
      status.kind === 'unconfigured' || status.kind === 'error'
        ? ''
        : status.kind === 'conflict'
          ? ' Click to choose.'
          : status.fileUrl
            ? ' Click to open the file on GitHub.'
            : '';
    this.pill.title = `LeetCode Git Sync: ${status.detail ?? status.text}${hint}`;
  }

  showConflict(handlers: ConflictHandlers | null): void {
    this.handlers = handlers;
    this.card.classList.toggle('show', handlers !== null);
  }
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(text: string, className = ''): HTMLButtonElement {
  const b = el('button', className, text) as HTMLButtonElement;
  b.type = 'button';
  return b;
}
