import { beforeEach, describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError } from '../src/background/github';
import { handleRequest, type ServiceDeps } from '../src/background/service';
import type { PullResponse, PushResponse, TestResponse } from '../src/core/messages';
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from '../src/core/settings';
import { hashCode } from '../src/core/text';
import { FakeGitHub, MemoryStore } from './fake-github';

const cfg = { token: 'tok', owner: 'octo', repo: 'sols', branch: '' };

describe('GitHubClient', () => {
  let gh: FakeGitHub;
  let client: GitHubClient;
  beforeEach(() => {
    gh = new FakeGitHub();
    client = new GitHubClient(cfg, gh.fetch);
  });

  it('returns null for a missing file', async () => {
    expect(await client.getFile('problems/0001-two-sum/solution.py')).toBeNull();
  });

  it('creates, reads and updates a file', async () => {
    const created = await client.putFile('a/b.py', 'print("hé")\n', 'draft: x', null);
    expect(await client.getFile('a/b.py')).toEqual({ content: 'print("hé")\n', sha: created.sha });
    const updated = await client.putFile('a/b.py', 'v2\n', 'draft: y', created.sha);
    expect(updated.sha).not.toBe(created.sha);
    expect(gh.commits.map((c) => c.message)).toEqual(['draft: x', 'draft: y']);
  });

  it('sends the token, bypasses the HTTP cache and encodes paths', async () => {
    await client.getFile('dir with space/solution.py');
    const req = gh.requests[0];
    expect(req.headers.Authorization).toBe('Bearer tok');
    expect(req.cache).toBe('no-store');
    expect(req.url).toBe('https://api.github.com/repos/octo/sols/contents/dir%20with%20space/solution.py');
  });

  it('targets the configured branch', async () => {
    const onBranch = new GitHubClient({ ...cfg, branch: 'work/a' }, gh.fetch);
    await onBranch.getFile('x.py');
    expect(gh.requests[0].url).toMatch(/\?ref=work%2Fa$/);
  });

  it('reports a stale sha as a conflict', async () => {
    const { sha } = await client.putFile('a.py', 'one\n', 'm', null);
    gh.commitElsewhere('a.py', 'two\n');
    await expect(client.putFile('a.py', 'three\n', 'm', sha)).rejects.toMatchObject({ kind: 'conflict' });
    // ...and so is creating a file that already exists.
    await expect(client.putFile('a.py', 'three\n', 'm', null)).rejects.toMatchObject({ kind: 'conflict' });
    expect(gh.files.get('a.py')?.content).toBe('two\n');
  });

  it('classifies failures', async () => {
    gh.failWith = { status: 401, message: 'Bad credentials' };
    await expect(client.getFile('a.py')).rejects.toMatchObject({ kind: 'auth' });
    gh.failWith = { status: 403, message: 'Resource not accessible by personal access token' };
    await expect(client.putFile('a.py', 'x', 'm', null)).rejects.toMatchObject({ kind: 'forbidden' });
    gh.failWith = { status: 403, message: 'API rate limit exceeded', headers: { 'x-ratelimit-remaining': '0' } };
    await expect(client.getFile('a.py')).rejects.toMatchObject({ kind: 'rate-limit' });
    gh.failWith = { status: 404 };
    await expect(client.putFile('a.py', 'x', 'm', null)).rejects.toMatchObject({ kind: 'not-found' });
    gh.failWith = { status: 500 };
    await expect(client.getRepo()).rejects.toMatchObject({ kind: 'other' });
    gh.failWith = null;
    gh.offline = true;
    await expect(client.getFile('a.py')).rejects.toBeInstanceOf(GitHubError);
    await expect(client.getFile('a.py')).rejects.toMatchObject({ kind: 'network' });
  });

  it('describes the repo', async () => {
    expect(await client.getRepo()).toEqual({
      fullName: 'octo/sols',
      private: true,
      canPush: true,
      defaultBranch: 'main',
    });
  });
});

describe('background service', () => {
  let gh: FakeGitHub;
  let store: MemoryStore;
  let deps: ServiceDeps;
  let opened: number;
  const settings: Settings = { ...DEFAULT_SETTINGS, token: 'tok', repo: 'octo/sols' };
  const meta = { frontendId: '1', title: 'Two Sum' };
  const path = 'problems/0001-two-sum/solution.py';

  beforeEach(() => {
    gh = new FakeGitHub();
    store = new MemoryStore();
    store.data[SETTINGS_KEY] = settings;
    opened = 0;
    deps = { store, fetch: gh.fetch, openOptions: () => void opened++ };
  });

  const pull = () => handleRequest({ type: 'pull', slug: 'two-sum', lang: 'python3', meta }, deps) as Promise<PullResponse>;
  const push = (content: string, expectedSha: string | null, extra: object = {}) =>
    handleRequest(
      { type: 'push', slug: 'two-sum', lang: 'python3', meta, content, kind: 'draft', expectedSha, ...extra },
      deps,
    ) as Promise<PushResponse>;

  it('says so when not set up, without calling GitHub', async () => {
    store.data[SETTINGS_KEY] = DEFAULT_SETTINGS;
    expect(await pull()).toEqual({ ok: true, configured: false });
    expect(gh.requests).toHaveLength(0);
  });

  it('pulls a missing file as null', async () => {
    expect(await pull()).toEqual({
      ok: true,
      configured: true,
      remote: null,
      baseHash: null,
      syncDrafts: true,
      gitAlwaysWins: false,
      fileUrl: `https://github.com/octo/sols/blob/HEAD/${path}`,
    });
  });

  it('pushes a draft, records it as the base, and pulls it back', async () => {
    const res = await push('class Solution: pass', null);
    expect(res.ok).toBe(true);
    expect(gh.files.get(path)?.content).toBe('class Solution: pass\n');
    expect(gh.commits[0].message).toBe('draft: 1. Two Sum (python3)');
    const pulled = await pull();
    expect(pulled).toMatchObject({
      remote: { content: 'class Solution: pass\n' },
      baseHash: await hashCode('class Solution: pass'),
    });
  });

  it('words accepted commits with stats', async () => {
    await push('x', null, { kind: 'accepted', stats: { runtime: '3 ms', memory: '12 MB' } });
    expect(gh.commits[0].message).toBe('accepted: 1. Two Sum (python3) - 3 ms, 12 MB');
  });

  it('reports a conflict instead of overwriting newer repo content', async () => {
    const first = await push('one', null);
    gh.commitElsewhere(path, 'from another computer\n');
    const res = await push('two', first.ok ? first.sha : null);
    expect(res).toEqual({ ok: false, conflict: true });
    expect(gh.files.get(path)?.content).toBe('from another computer\n');
  });

  it('force-pushes by looking up the current sha first', async () => {
    gh.commitElsewhere(path, 'old\n');
    expect((await push('new', null, { force: true })).ok).toBe(true);
    expect(gh.files.get(path)?.content).toBe('new\n');
  });

  it('honours the folder and branch settings', async () => {
    store.data[SETTINGS_KEY] = { ...settings, baseDir: '', branch: 'main' };
    await push('x', null);
    expect([...gh.files.keys()]).toEqual(['0001-two-sum/solution.py']);
    expect((await pull()) as object).toMatchObject({
      fileUrl: 'https://github.com/octo/sols/blob/main/0001-two-sum/solution.py',
    });
  });

  it('rejects malformed requests from the page', async () => {
    const bad = (await handleRequest(
      { type: 'push', slug: '../../x', lang: 'python3', meta, content: 'x', kind: 'draft', expectedSha: null },
      deps,
    )) as PushResponse;
    expect(bad.ok).toBe(false);
    const noMeta = (await handleRequest(
      { type: 'pull', slug: 'two-sum', lang: 'python3', meta: { frontendId: '', title: 'x' } },
      deps,
    )) as PullResponse;
    expect(noMeta.ok).toBe(false);
    expect(gh.requests).toHaveLength(0);
  });

  it('surfaces GitHub errors as readable text', async () => {
    gh.failWith = { status: 401 };
    const res = await pull();
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.error).toMatch(/token/i);
  });

  it('records the base on markBase', async () => {
    await handleRequest({ type: 'markBase', slug: 'two-sum', lang: 'python3', content: 'abc\n' }, deps);
    expect(store.data['base:two-sum:python3']).toBe(await hashCode('abc'));
  });

  it('tests a connection with candidate settings', async () => {
    const ok = (await handleRequest({ type: 'test', settings }, deps)) as TestResponse;
    expect(ok).toEqual({ ok: true, fullName: 'octo/sols', private: true, canPush: true, defaultBranch: 'main' });
    const badBranch = (await handleRequest({ type: 'test', settings: { ...settings, branch: 'nope' } }, deps)) as TestResponse;
    expect(badBranch).toMatchObject({ ok: false });
    const badRepo = (await handleRequest({ type: 'test', settings: { ...settings, repo: 'x' } }, deps)) as TestResponse;
    expect(badRepo).toMatchObject({ ok: false });
  });

  it('opens the options page on request', async () => {
    await handleRequest({ type: 'openOptions' }, deps);
    expect(opened).toBe(1);
  });
});
