// Service worker entry point: wires chrome APIs to the request handler.

import type { BgRequest } from '../core/messages';
import { handleRequest, type ServiceDeps } from './service';

// Keep the token out of reach of content scripts: only extension pages and
// this worker may read chrome.storage.local.
void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

const deps: ServiceDeps = {
  store: {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
  },
  fetch: (input, init) => fetch(input, init),
  openOptions: () => void chrome.runtime.openOptionsPage(),
};

chrome.runtime.onMessage.addListener((message: BgRequest, sender, sendResponse) => {
  // Only this extension's own pages and content scripts may talk to us.
  if (sender.id !== chrome.runtime.id) return false;
  // Settings tests carry a token, so they must come from an extension page.
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL('')) === true;
  if (message?.type === 'test' && !fromExtensionPage) {
    sendResponse({ ok: false, error: 'Not allowed.' });
    return false;
  }
  handleRequest(message, deps).then(sendResponse, () =>
    sendResponse({ ok: false, error: 'Unexpected error.' }),
  );
  return true; // response is sent asynchronously
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void chrome.runtime.openOptionsPage();
});
