// Content script entry point (isolated world). Connects the page bridge, the
// background worker and the in-page UI to the sync controller.

import {
  EXT_TAG,
  PAGE_TAG,
  type BgRequest,
  type ExtMessage,
  type PageMessage,
  type PopupRequest,
  type PullResponse,
  type PushResponse,
} from '../core/messages';
import { SyncController, type QuestionMeta } from './controller';
import { fetchQuestionMeta } from './leetcode';
import { SyncUi } from './ui';

// ---- background -----------------------------------------------------------

function ask<T>(request: BgRequest): Promise<T> {
  return chrome.runtime.sendMessage(request) as Promise<T>;
}

// ---- page bridge ----------------------------------------------------------

function toPage(message: ExtMessage): void {
  window.postMessage(message, location.origin);
}

let nextSetId = 1;
const pendingSets = new Map<number, (ok: boolean) => void>();

function setCode(slug: string, lang: string, code: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = nextSetId++;
    const timer = setTimeout(() => {
      pendingSets.delete(id);
      resolve(false);
    }, 3000);
    pendingSets.set(id, (ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
    toPage({ tag: EXT_TAG, type: 'set', id, slug, lang, code });
  });
}

// ---- problem details ------------------------------------------------------

const metaCache = new Map<string, QuestionMeta>();

async function getMeta(slug: string): Promise<QuestionMeta | null> {
  const cached = metaCache.get(slug);
  if (cached) return cached;
  const meta = await fetchQuestionMeta(slug);
  if (meta) metaCache.set(slug, meta);
  return meta;
}

// ---- wiring ---------------------------------------------------------------

const ui = new SyncUi({
  onPillClick(kind, status) {
    if (kind === 'conflict') controller.reopenConflict();
    else if (kind === 'unconfigured' || kind === 'error') void ask({ type: 'openOptions' });
    else if (status.fileUrl) window.open(status.fileUrl, '_blank', 'noopener');
  },
});

const controller = new SyncController({
  pull: (req) => ask<PullResponse>({ type: 'pull', ...req }),
  push: (req) => ask<PushResponse>({ type: 'push', ...req }),
  markBase: (req) => ask({ type: 'markBase', ...req }),
  setCode,
  getMeta,
  setStatus: (status) => ui.setStatus(status),
  showConflict: (handlers) => ui.showConflict(handlers),
});

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data as PageMessage | undefined;
  if (!msg || msg.tag !== PAGE_TAG) return;
  if (msg.type === 'state') {
    const s = msg.state;
    if (
      s === null ||
      (typeof s.slug === 'string' && typeof s.lang === 'string' && typeof s.code === 'string')
    ) {
      controller.onEditorState(s === null ? null : { slug: s.slug, lang: s.lang, code: s.code, flush: s.flush === true });
    }
  } else if (msg.type === 'accepted') {
    const a = msg.submission;
    if (a && typeof a.slug === 'string' && typeof a.lang === 'string' && typeof a.code === 'string') {
      controller.onAccepted({
        slug: a.slug,
        lang: a.lang,
        code: a.code,
        runtime: typeof a.runtime === 'string' ? a.runtime : undefined,
        memory: typeof a.memory === 'string' ? a.memory : undefined,
      });
    }
  } else if (msg.type === 'setResult') {
    const done = pendingSets.get(msg.id);
    if (done) {
      pendingSets.delete(msg.id);
      done(msg.ok === true);
    }
  }
});

document.addEventListener('visibilitychange', () => {
  controller.onVisibilityChange(document.visibilityState === 'visible');
});
window.addEventListener('pagehide', () => controller.onVisibilityChange(false));

chrome.runtime.onMessage.addListener((message: PopupRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'popup/status') {
    sendResponse(controller.describe());
    return false;
  }
  if (message?.type === 'popup/syncNow') {
    controller.syncNow().then(
      () => sendResponse(controller.describe()),
      () => sendResponse(controller.describe()),
    );
    return true;
  }
  return false;
});

// The bridge started before us; ask it to repeat the current state.
toPage({ tag: EXT_TAG, type: 'hello' });
