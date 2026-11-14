// Toolbar popup: shows the sync state of the problem in the current tab.

import type { PopupRequest, PopupStatusResponse } from '../core/messages';
import { isConfigured, loadSettings } from '../core/settings';

const problem = document.getElementById('problem') as HTMLElement;
const state = document.getElementById('state') as HTMLElement;
const repo = document.getElementById('repo') as HTMLElement;
const syncBtn = document.getElementById('sync') as HTMLButtonElement;
const fileBtn = document.getElementById('file') as HTMLButtonElement;
const settingsBtn = document.getElementById('settings') as HTMLButtonElement;

let tabId: number | undefined;
let fileUrl: string | undefined;

async function askTab(request: PopupRequest): Promise<PopupStatusResponse | null> {
  if (tabId === undefined) return null;
  try {
    return (await chrome.tabs.sendMessage(tabId, request)) as PopupStatusResponse;
  } catch {
    return null; // not a LeetCode tab, or the page predates the extension
  }
}

function render(res: PopupStatusResponse | null, configured: boolean): void {
  fileUrl = undefined;
  if (!res || !res.active) {
    problem.textContent = '';
    state.textContent = configured
      ? 'Open a problem on leetcode.com to sync it. If one is already open, reload the page.'
      : 'Not set up yet. Open Settings to connect your solutions repo.';
    syncBtn.hidden = true;
    fileBtn.hidden = true;
    return;
  }
  problem.textContent = `${res.slug} · ${res.lang}`;
  const s = res.status;
  state.textContent = s ? (s.detail ? `${s.text}. ${s.detail}` : s.text) : '';
  syncBtn.hidden = !configured;
  fileUrl = s?.fileUrl;
  fileBtn.hidden = !fileUrl;
}

async function refresh(request: PopupRequest = { type: 'popup/status' }): Promise<void> {
  const settings = await loadSettings({
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
  });
  const configured = isConfigured(settings);
  repo.textContent = configured ? `Repo: ${settings.repo}${settings.branch ? ` (${settings.branch})` : ''}` : '';
  render(await askTab(request), configured);
}

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  state.textContent = 'Syncing…';
  await refresh({ type: 'popup/syncNow' });
  syncBtn.disabled = false;
});
fileBtn.addEventListener('click', () => {
  if (fileUrl) void chrome.tabs.create({ url: fileUrl });
});
settingsBtn.addEventListener('click', () => void chrome.runtime.openOptionsPage());

void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  tabId = tab?.id;
  return refresh();
});
