// Settings page.

import type { TestResponse } from '../core/messages';
import { normalizeBaseDir } from '../core/paths';
import {
  clampNotesGap,
  loadSettings,
  parseRepo,
  saveSettings,
  type KeyValueStore,
  type Settings,
} from '../core/settings';

const store: KeyValueStore = {
  get: (key) => chrome.storage.local.get(key),
  set: (items) => chrome.storage.local.set(items),
};

function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

const fields = {
  repo: input('repo'),
  token: input('token'),
  branch: input('branch'),
  baseDir: input('baseDir'),
  syncDrafts: input('syncDrafts'),
  gitAlwaysWins: input('gitAlwaysWins'),
  notesGapMinutes: input('notesGapMinutes'),
};
const note = document.getElementById('note') as HTMLElement;
const example = document.getElementById('example') as HTMLElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const testBtn = document.getElementById('test') as HTMLButtonElement;

function say(text: string, tone: 'ok' | 'warn' | 'bad' | '' = ''): void {
  note.textContent = text;
  note.className = `note ${tone}`;
}

function read(): Settings {
  return {
    repo: fields.repo.value.trim(),
    token: fields.token.value.trim(),
    branch: fields.branch.value.trim(),
    baseDir: fields.baseDir.value.trim(),
    syncDrafts: fields.syncDrafts.checked,
    gitAlwaysWins: fields.gitAlwaysWins.checked,
    notesGapMinutes: clampNotesGap(fields.notesGapMinutes.value),
  };
}

function fill(s: Settings): void {
  fields.repo.value = s.repo;
  fields.token.value = s.token;
  fields.branch.value = s.branch;
  fields.baseDir.value = s.baseDir;
  fields.syncDrafts.checked = s.syncDrafts;
  fields.gitAlwaysWins.checked = s.gitAlwaysWins;
  fields.notesGapMinutes.value = String(s.notesGapMinutes);
  updateExample();
}

function updateExample(): void {
  const dir = normalizeBaseDir(fields.baseDir.value);
  example.textContent = `${dir ? `${dir}/` : ''}0001-two-sum/solution.py`;
}

/** Returns a message describing what is wrong, or null if the form is valid. */
function validate(s: Settings): string | null {
  if (!parseRepo(s.repo)) return 'Enter the repository as owner/name, for example octocat/leetcode-solutions.';
  if (!s.token) return 'Paste a personal access token.';
  if (normalizeBaseDir(s.baseDir) === null) return 'The folder is not a valid path.';
  return null;
}

function describe(res: TestResponse): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!res.ok) return { text: res.error, tone: 'bad' };
  const visibility = res.private ? 'private' : 'public';
  if (!res.canPush) {
    return {
      text: `Found ${res.fullName} (${visibility}), but this account cannot write to it.`,
      tone: 'warn',
    };
  }
  return { text: `Connected to ${res.fullName} (${visibility}).`, tone: 'ok' };
}

async function test(s: Settings): Promise<TestResponse> {
  return (await chrome.runtime.sendMessage({ type: 'test', settings: s })) as TestResponse;
}

async function withBusy(fn: () => Promise<void>): Promise<void> {
  saveBtn.disabled = testBtn.disabled = true;
  try {
    await fn();
  } catch (e) {
    say(e instanceof Error ? e.message : 'Something went wrong.', 'bad');
  } finally {
    saveBtn.disabled = testBtn.disabled = false;
  }
}

saveBtn.addEventListener('click', () =>
  withBusy(async () => {
    const s = read();
    const problem = validate(s);
    if (problem) return say(problem, 'bad');
    const ref = parseRepo(s.repo);
    if (ref) s.repo = `${ref.owner}/${ref.repo}`;
    s.baseDir = normalizeBaseDir(s.baseDir) ?? '';
    await saveSettings(store, s);
    fill(s);
    say('Saved. Checking the connection…');
    const d = describe(await test(s));
    say(d.tone === 'ok' ? `Saved. ${d.text} Open a LeetCode problem to start syncing.` : `Saved, but: ${d.text}`, d.tone);
  }),
);

testBtn.addEventListener('click', () =>
  withBusy(async () => {
    const s = read();
    const problem = validate(s);
    if (problem) return say(problem, 'bad');
    say('Checking…');
    const d = describe(await test(s));
    say(d.text, d.tone);
  }),
);

fields.baseDir.addEventListener('input', updateExample);

void loadSettings(store).then(fill);
