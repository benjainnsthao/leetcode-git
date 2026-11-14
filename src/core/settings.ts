// User settings. Stored in chrome.storage.local; the token never leaves the
// browser except in requests to api.github.com made by the background worker.

export interface Settings {
  /** GitHub personal access token. */
  token: string;
  /** "owner/name" of the solutions repo. */
  repo: string;
  /** Branch to sync with. Empty means the repo's default branch. */
  branch: string;
  /** Folder inside the repo that holds the problem folders. Empty = root. */
  baseDir: string;
  /** Commit work in progress shortly after typing stops. */
  syncDrafts: boolean;
  /** When both sides changed, load the repo version instead of asking. */
  gitAlwaysWins: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  token: '',
  repo: '',
  branch: '',
  baseDir: 'problems',
  syncDrafts: true,
  gitAlwaysWins: false,
};

export const SETTINGS_KEY = 'settings';

export interface RepoRef {
  owner: string;
  repo: string;
}

/** Accepts "owner/name", an https URL, or an ssh remote. */
export function parseRepo(input: string): RepoRef | null {
  let s = input.trim();
  s = s.replace(/^git@github\.com:/i, '').replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '');
  s = s.replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], repo: m[2] };
}

export function isConfigured(s: Settings): boolean {
  return s.token.trim() !== '' && parseRepo(s.repo) !== null;
}

export function mergeSettings(stored: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    const s = stored as Record<string, unknown>;
    if (typeof s.token === 'string') out.token = s.token;
    if (typeof s.repo === 'string') out.repo = s.repo;
    if (typeof s.branch === 'string') out.branch = s.branch;
    if (typeof s.baseDir === 'string') out.baseDir = s.baseDir;
    if (typeof s.syncDrafts === 'boolean') out.syncDrafts = s.syncDrafts;
    if (typeof s.gitAlwaysWins === 'boolean') out.gitAlwaysWins = s.gitAlwaysWins;
  }
  return out;
}

/** Minimal slice of chrome.storage.StorageArea, so it can be faked in tests. */
export interface KeyValueStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadSettings(store: KeyValueStore): Promise<Settings> {
  const got = await store.get(SETTINGS_KEY);
  return mergeSettings(got[SETTINGS_KEY]);
}

export async function saveSettings(store: KeyValueStore, settings: Settings): Promise<void> {
  await store.set({ [SETTINGS_KEY]: settings });
}
