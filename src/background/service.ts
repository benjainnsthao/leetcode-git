// Handles requests from the content script, popup and options page.
// Everything that needs the token happens here.

import type {
  BgRequest,
  MetaInput,
  PullResponse,
  PushResponse,
  SimpleResponse,
  TestResponse,
} from '../core/messages';
import {
  commitMessage,
  isValidLang,
  isValidSlug,
  normalizeBaseDir,
  solutionPath,
  type ProblemMeta,
} from '../core/paths';
import { isConfigured, loadSettings, parseRepo, type KeyValueStore, type Settings } from '../core/settings';
import { hashCode, toFileContent } from '../core/text';
import { GitHubClient, GitHubError } from './github';

export interface ServiceDeps {
  store: KeyValueStore;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  openOptions: () => void;
}

const MAX_CONTENT = 400_000;

function baseKey(slug: string, lang: string): string {
  return `base:${slug}:${lang}`;
}

function errorText(e: unknown): string {
  if (e instanceof GitHubError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Unexpected error.';
}

function checkMeta(slug: unknown, lang: unknown, meta: unknown): ProblemMeta {
  if (!isValidSlug(slug) || !isValidLang(lang)) throw new Error('Invalid problem or language.');
  const m = meta as MetaInput | undefined;
  if (
    !m ||
    typeof m.frontendId !== 'string' ||
    typeof m.title !== 'string' ||
    m.frontendId.trim() === '' ||
    m.frontendId.length > 20 ||
    m.title.length > 300
  ) {
    throw new Error('Invalid problem details.');
  }
  return { slug, frontendId: m.frontendId, title: m.title };
}

interface Target {
  client: GitHubClient;
  path: string;
  fileUrl: string;
}

function target(settings: Settings, meta: ProblemMeta, lang: string, deps: ServiceDeps): Target {
  const ref = parseRepo(settings.repo);
  if (!ref) throw new Error('The solutions repo setting is not valid.');
  const baseDir = normalizeBaseDir(settings.baseDir);
  if (baseDir === null) throw new Error('The base folder setting is not a valid path.');
  const branch = settings.branch.trim();
  const path = solutionPath(baseDir, meta, lang);
  const client = new GitHubClient({ token: settings.token.trim(), ...ref, branch }, deps.fetch);
  const fileUrl = `https://github.com/${ref.owner}/${ref.repo}/blob/${encodeURIComponent(branch || 'HEAD')}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  return { client, path, fileUrl };
}

async function pull(req: Extract<BgRequest, { type: 'pull' }>, deps: ServiceDeps): Promise<PullResponse> {
  try {
    const meta = checkMeta(req.slug, req.lang, req.meta);
    const settings = await loadSettings(deps.store);
    if (!isConfigured(settings)) return { ok: true, configured: false };
    const t = target(settings, meta, req.lang, deps);
    const remote = await t.client.getFile(t.path);
    const key = baseKey(meta.slug, req.lang);
    const stored = (await deps.store.get(key))[key];
    return {
      ok: true,
      configured: true,
      remote,
      baseHash: typeof stored === 'string' ? stored : null,
      syncDrafts: settings.syncDrafts,
      gitAlwaysWins: settings.gitAlwaysWins,
      fileUrl: t.fileUrl,
    };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

async function push(req: Extract<BgRequest, { type: 'push' }>, deps: ServiceDeps): Promise<PushResponse> {
  try {
    const meta = checkMeta(req.slug, req.lang, req.meta);
    if (typeof req.content !== 'string' || req.content.length > MAX_CONTENT) {
      throw new Error('Code is missing or too large to sync.');
    }
    const kind = req.kind === 'accepted' ? 'accepted' : 'draft';
    const settings = await loadSettings(deps.store);
    if (!isConfigured(settings)) throw new Error('Git sync is not set up yet.');
    const t = target(settings, meta, req.lang, deps);

    let sha = typeof req.expectedSha === 'string' ? req.expectedSha : null;
    if (req.force) sha = (await t.client.getFile(t.path))?.sha ?? null;

    const message = commitMessage(kind, meta, req.lang, req.stats);
    const result = await t.client.putFile(t.path, toFileContent(req.content), message, sha);
    await deps.store.set({ [baseKey(meta.slug, req.lang)]: await hashCode(req.content) });
    return { ok: true, sha: result.sha };
  } catch (e) {
    if (e instanceof GitHubError && e.kind === 'conflict') return { ok: false, conflict: true };
    return { ok: false, error: errorText(e) };
  }
}

async function markBase(req: Extract<BgRequest, { type: 'markBase' }>, deps: ServiceDeps): Promise<SimpleResponse> {
  try {
    if (!isValidSlug(req.slug) || !isValidLang(req.lang) || typeof req.content !== 'string') {
      throw new Error('Invalid request.');
    }
    await deps.store.set({ [baseKey(req.slug, req.lang)]: await hashCode(req.content) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

async function test(req: Extract<BgRequest, { type: 'test' }>, deps: ServiceDeps): Promise<TestResponse> {
  try {
    const s = req.settings;
    if (!s || typeof s.token !== 'string' || s.token.trim() === '') throw new Error('Enter a token first.');
    const ref = parseRepo(String(s.repo ?? ''));
    if (!ref) throw new Error('Enter the repo as owner/name, for example octocat/leetcode-solutions.');
    if (normalizeBaseDir(String(s.baseDir ?? '')) === null) throw new Error('The base folder is not a valid path.');
    const branch = String(s.branch ?? '').trim();
    const client = new GitHubClient({ token: s.token.trim(), ...ref, branch }, deps.fetch);
    const info = await client.getRepo();
    if (branch && !(await client.branchExists())) {
      throw new Error(`Branch "${branch}" does not exist in ${info.fullName}. Create it first, or leave the branch empty.`);
    }
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function handleRequest(req: BgRequest, deps: ServiceDeps): Promise<unknown> {
  switch (req?.type) {
    case 'pull':
      return pull(req, deps);
    case 'push':
      return push(req, deps);
    case 'markBase':
      return markBase(req, deps);
    case 'test':
      return test(req, deps);
    case 'openOptions':
      deps.openOptions();
      return { ok: true } satisfies SimpleResponse;
    default:
      return { ok: false, error: 'Unknown request.' } satisfies SimpleResponse;
  }
}
