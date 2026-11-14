// Runs in the page's own JavaScript world (MAIN) at document_start.
// This is the only file that touches LeetCode internals:
//   - the Monaco editor instance behind the code box
//   - the network calls LeetCode makes when you submit
// It reports what it sees to the content script and applies "set code"
// requests from it. It holds no settings and no credentials.

import { EXT_TAG, PAGE_TAG, type EditorState, type ExtMessage, type PageMessage } from '../core/messages';
import { parseCheckResponse, parseSubmitBody, submissionIdFromCheckUrl, submitSlugFromUrl } from './submissions';

// ---- minimal Monaco typings (only what is used) --------------------------

interface MonacoModel {
  getValue(): string;
  getLanguageId(): string;
  getFullModelRange(): unknown;
  pushEditOperations(before: unknown, edits: { range: unknown; text: string }[], after: () => null): unknown;
  onDidChangeContent(listener: (e: { isFlush: boolean }) => void): unknown;
  isDisposed(): boolean;
}

interface MonacoEditor {
  getModel(): MonacoModel | null;
  getContainerDomNode(): HTMLElement;
  pushUndoStop?(): void;
}

interface MonacoGlobal {
  editor: { getEditors?(): MonacoEditor[] };
}

declare global {
  interface Window {
    monaco?: MonacoGlobal;
    __lcgitBridge?: boolean;
  }
}

const PROBLEM_PATH = /^\/problems\/([a-z0-9][a-z0-9-]*)(?:\/|$)/;
const LANG_BUTTON = '[data-e2e-locator="lang-selector-button"]';

function post(message: PageMessage): void {
  window.postMessage(message, location.origin);
}

// ---- reading the code box -------------------------------------------------

function currentSlug(): string | null {
  return PROBLEM_PATH.exec(location.pathname)?.[1] ?? null;
}

/** The editor that holds the solution (not the test-case or notes editors). */
function findCodeEditor(): MonacoEditor | null {
  const editors = window.monaco?.editor.getEditors?.() ?? [];
  let best: MonacoEditor | null = null;
  let bestArea = -1;
  for (const ed of editors) {
    const model = ed.getModel();
    const node = ed.getContainerDomNode();
    if (!model || model.isDisposed() || !node.isConnected) continue;
    if (model.getLanguageId() === 'plaintext') continue;
    const rect = node.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = ed;
      bestArea = area;
    }
  }
  return best;
}

function currentLang(model: MonacoModel): string | null {
  const fromButton = document.querySelector(LANG_BUTTON)?.getAttribute('data-e2e-lang');
  const lang = fromButton || model.getLanguageId();
  return /^[a-z0-9]{1,30}$/.test(lang) ? lang : null;
}

function snapshot(): Omit<EditorState, 'flush'> | null {
  const slug = currentSlug();
  if (!slug) return null;
  const editor = findCodeEditor();
  const model = editor?.getModel();
  if (!model) return null;
  const lang = currentLang(model);
  if (!lang) return null;
  return { slug, lang, code: model.getValue() };
}

// ---- reporting changes ----------------------------------------------------

const watched = new WeakSet<MonacoModel>();
let sawUserEdit = false;
let lastSent: string | null | undefined; // undefined = nothing sent yet
let reportTimer: ReturnType<typeof setTimeout> | undefined;

function watchModels(): void {
  for (const ed of window.monaco?.editor.getEditors?.() ?? []) {
    const model = ed.getModel();
    if (!model || watched.has(model)) continue;
    watched.add(model);
    model.onDidChangeContent((e) => {
      if (!e.isFlush) sawUserEdit = true;
      scheduleReport();
    });
  }
}

/** Short trailing delay so the language label and the code are read together. */
function scheduleReport(): void {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(report, 200);
}

function report(force = false): void {
  watchModels();
  const snap = snapshot();
  const fingerprint = snap ? `${snap.slug}\n${snap.lang}\n${snap.code}` : null;
  if (!force && fingerprint === lastSent) {
    sawUserEdit = false;
    return;
  }
  lastSent = fingerprint;
  // A change nobody typed (no non-flush edit seen) came from the page itself.
  const flush = !sawUserEdit;
  sawUserEdit = false;
  post({ tag: PAGE_TAG, type: 'state', state: snap ? { ...snap, flush } : null });
}

// ---- writing the code box -------------------------------------------------

function setCode(slug: string, lang: string, code: string): boolean {
  const editor = findCodeEditor();
  const model = editor?.getModel();
  if (!editor || !model) return false;
  // Never write into a different problem or language than the one requested.
  if (currentSlug() !== slug || currentLang(model) !== lang) return false;
  if (model.getValue() !== code) {
    editor.pushUndoStop?.();
    // An edit operation (not setValue) keeps the change undoable with Ctrl+Z.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: code }], () => null);
    editor.pushUndoStop?.();
  }
  return true;
}

// ---- accepted submissions -------------------------------------------------

interface PendingSubmission {
  slug: string;
  lang: string;
  code: string;
}

const pending = new Map<string, PendingSubmission>();

function onSubmitResponse(slug: string, requestBody: unknown, responseText: string): void {
  let body = parseSubmitBody(requestBody);
  if (!body) {
    // Request body was not readable; the code box still holds what was sent.
    const snap = snapshot();
    if (!snap || snap.slug !== slug) return;
    body = { lang: snap.lang, code: snap.code };
  }
  try {
    const id = (JSON.parse(responseText) as { submission_id?: unknown }).submission_id;
    if (typeof id !== 'number' && typeof id !== 'string') return;
    pending.set(String(id), { slug, ...body });
    if (pending.size > 20) pending.delete(pending.keys().next().value as string);
  } catch {
    // Not JSON (e.g. an error page): nothing was submitted.
  }
}

function onCheckResponse(id: string, responseText: string): void {
  const sub = pending.get(id);
  if (!sub) return; // "Run" results and other people's submissions are ignored
  const result = parseCheckResponse(responseText);
  if (!result.finished) return;
  pending.delete(id);
  if (!result.accepted) return;
  post({
    tag: PAGE_TAG,
    type: 'accepted',
    submission: { ...sub, runtime: result.runtime, memory: result.memory },
  });
}

function inspect(url: string, requestBody: unknown, readResponse: () => Promise<string>): void {
  let path: string;
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin) return;
    path = u.pathname;
  } catch {
    return;
  }
  const slug = submitSlugFromUrl(path);
  const checkId = slug ? null : submissionIdFromCheckUrl(path);
  if (!slug && !checkId) return;
  readResponse().then(
    (text) => {
      try {
        if (slug) onSubmitResponse(slug, requestBody, text);
        else if (checkId) onCheckResponse(checkId, text);
      } catch {
        // Never let our bookkeeping affect the page.
      }
    },
    () => undefined,
  );
}

function hookNetwork(): void {
  const originalFetch = window.fetch;
  window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const result = originalFetch.call(this, input, init) as Promise<Response>;
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body;
      result.then(
        (res) => inspect(url, body, () => res.clone().text()),
        () => undefined,
      );
    } catch {
      // Ignore: the page's request must proceed untouched.
    }
    return result;
  };

  const urls = new WeakMap<XMLHttpRequest, string>();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    try {
      urls.set(this, String(args[1]));
    } catch {
      // ignore
    }
    return (originalOpen as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      const url = urls.get(this);
      if (url) {
        this.addEventListener('load', () => {
          inspect(url, body, async () =>
            this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : this.responseType === 'json'
                ? JSON.stringify(this.response)
                : '',
          );
        });
      }
    } catch {
      // ignore
    }
    return originalSend.call(this, body);
  };
}

// ---- wiring ---------------------------------------------------------------

function onExtMessage(event: MessageEvent): void {
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data as ExtMessage | undefined;
  if (!msg || msg.tag !== EXT_TAG) return;
  if (msg.type === 'hello') {
    report(true);
  } else if (msg.type === 'set') {
    let ok = false;
    try {
      ok = setCode(msg.slug, msg.lang, msg.code);
    } catch {
      ok = false;
    }
    post({ tag: PAGE_TAG, type: 'setResult', id: msg.id, ok });
  }
}

if (!window.__lcgitBridge) {
  window.__lcgitBridge = true;
  hookNetwork();
  window.addEventListener('message', onExtMessage);
  // Monaco events cover typing; the poll covers everything else (the editor
  // appearing, navigation between problems, language switches).
  setInterval(() => report(), 1000);
}
