// End-to-end tests of the sync engine: the real controller and the real
// background service, talking to an in-memory GitHub and a fake code box.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, type ServiceDeps } from '../src/background/service';
import { SyncController, type ConflictHandlers, type QuestionMeta } from '../src/content/controller';
import type { PullResponse, PushResponse, Status } from '../src/core/messages';
import { DEFAULT_SETTINGS, SETTINGS_KEY, type Settings } from '../src/core/settings';
import { FakeGitHub, MemoryStore } from './fake-github';

const PY_TEMPLATE = 'class Solution:\n    def twoSum(self, nums, target):\n        ';
const CPP_TEMPLATE = 'class Solution {\npublic:\n};';
const PY_PATH = 'problems/0001-two-sum/solution.py';
const CPP_PATH = 'problems/0001-two-sum/solution.cpp';

declare function setImmediate(callback: (value?: unknown) => void): unknown;

/** Waits until the controller has finished everything it started. */
async function settle(controller: SyncController): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setImmediate(r));
    await controller.whenIdle();
  }
}

/** One browser: its own storage and code box, pointed at a (possibly shared) GitHub. */
function browser(gh: FakeGitHub, overrides: Partial<Settings> = {}) {
  const store = new MemoryStore();
  store.data[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, token: 'tok', repo: 'octo/sols', ...overrides };
  const deps: ServiceDeps = { store, fetch: gh.fetch, openOptions: () => undefined };
  const editor = { slug: 'two-sum', lang: 'python3', code: PY_TEMPLATE };
  const statuses: Status[] = [];
  let conflict: ConflictHandlers | null = null;
  let clock = 0;

  const controller = new SyncController({
    pull: (r) => handleRequest({ type: 'pull', ...r }, deps) as Promise<PullResponse>,
    push: (r) => handleRequest({ type: 'push', ...r }, deps) as Promise<PushResponse>,
    markBase: (r) => handleRequest({ type: 'markBase', ...r }, deps),
    setCode: async (slug, lang, code) => {
      if (slug !== editor.slug || lang !== editor.lang) return false;
      editor.code = code;
      // The real bridge echoes the change back like any other edit.
      queueMicrotask(() => controller.onEditorState({ ...editor, flush: false }));
      return true;
    },
    getMeta: async (slug): Promise<QuestionMeta> =>
      slug === 'two-sum'
        ? { frontendId: '1', title: 'Two Sum', templates: { python3: PY_TEMPLATE, cpp: CPP_TEMPLATE } }
        : { frontendId: '2', title: 'Add Two Numbers', templates: {} },
    setStatus: (s) => statuses.push(s),
    showConflict: (h) => (conflict = h),
    now: () => clock,
  });

  const advance = async (ms: number): Promise<void> => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await settle(controller);
  };

  return {
    store,
    editor,
    controller,
    advance,
    get status() {
      return statuses[statuses.length - 1];
    },
    get conflict() {
      return conflict;
    },
    /** The page shows the problem; LeetCode has filled the code box. */
    async open(code = editor.code) {
      editor.code = code;
      controller.onEditorState({ ...editor, flush: true });
      await advance(1500);
    },
    /** The user types. */
    type(code: string) {
      editor.code = code;
      controller.onEditorState({ ...editor, flush: false });
    },
    /** LeetCode itself replaces the code (reset, restore). */
    pageSet(code: string) {
      editor.code = code;
      controller.onEditorState({ ...editor, flush: true });
    },
    switchLang(lang: string, code: string) {
      editor.lang = lang;
      editor.code = code;
      controller.onEditorState({ ...editor, flush: true });
    },
  };
}

describe('SyncController', () => {
  let gh: FakeGitHub;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    gh = new FakeGitHub();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const messages = () => gh.commits.map((c) => c.message);
  const writes = () => gh.requests.filter((r) => r.method === 'PUT').length;

  it('loads the repo version into an untouched code box', async () => {
    gh.commitElsewhere(PY_PATH, 'solved = True\n');
    const b = browser(gh);
    await b.open();
    expect(b.editor.code).toBe('solved = True');
    expect(b.status.kind).toBe('loaded');
    expect(writes()).toBe(0);
  });

  it('commits a draft 10s after typing stops, never the starter code', async () => {
    const b = browser(gh);
    await b.open();
    expect(b.status.kind).toBe('idle');

    await b.advance(60_000);
    expect(writes()).toBe(0); // untouched template is not committed

    b.type(PY_TEMPLATE + 'return [0');
    await b.advance(9_000);
    b.type(PY_TEMPLATE + 'return [0, 1]');
    await b.advance(9_000);
    expect(writes()).toBe(0); // typing restarted the wait

    await b.advance(1_000);
    expect(messages()).toEqual(['draft: 1. Two Sum (python3)']);
    expect(gh.files.get(PY_PATH)?.content).toBe(PY_TEMPLATE + 'return [0, 1]\n');
    expect(b.status.kind).toBe('saved');

    await b.advance(60_000);
    expect(writes()).toBe(1); // nothing new, nothing committed
  });

  it('carries work between two computers', async () => {
    const a = browser(gh);
    const b = browser(gh);
    await a.open();
    a.type('v1 from A');
    await a.advance(10_000);

    await b.open(); // fresh computer: starter code in the box
    expect(b.editor.code).toBe('v1 from A');

    b.type('v2 from B');
    await b.advance(10_000);
    expect(gh.files.get(PY_PATH)?.content).toBe('v2 from B\n');

    // A comes back to the tab later.
    a.controller.onVisibilityChange(false);
    await a.advance(20_000);
    a.controller.onVisibilityChange(true);
    await a.advance(0);
    expect(a.editor.code).toBe('v2 from B');
    expect(a.status.kind).toBe('loaded');
    expect(messages()).toEqual(['draft: 1. Two Sum (python3)', 'draft: 1. Two Sum (python3)']);
  });

  it('pushes code-box changes that never got committed', async () => {
    const b = browser(gh);
    await b.open();
    b.type('v1');
    await b.advance(10_000);
    // Typed more, closed the tab before the commit, reopened later:
    const again = browser(gh);
    Object.assign(again.store.data, b.store.data);
    await again.open('v1 plus more');
    expect(gh.files.get(PY_PATH)?.content).toBe('v1 plus more\n');
    expect(again.status.kind).toBe('saved');
  });

  it('asks when both sides changed and writes nothing until answered', async () => {
    const b = browser(gh);
    await b.open();
    b.type('mine v1');
    await b.advance(10_000);
    gh.commitElsewhere(PY_PATH, 'theirs\n');

    const again = browser(gh);
    Object.assign(again.store.data, b.store.data);
    await again.open('mine v2');
    expect(again.status.kind).toBe('conflict');
    expect(again.conflict).not.toBeNull();
    expect(again.editor.code).toBe('mine v2');

    again.type('mine v3');
    await again.advance(30_000);
    expect(gh.files.get(PY_PATH)?.content).toBe('theirs\n'); // untouched while undecided

    again.conflict!.keepMine();
    await again.advance(0);
    expect(gh.files.get(PY_PATH)?.content).toBe('mine v3\n');
    expect(again.conflict).toBeNull();
    expect(again.status.kind).toBe('saved');
  });

  it('"Use git" replaces the code box and ends the conflict', async () => {
    gh.commitElsewhere(PY_PATH, 'theirs\n');
    const b = browser(gh);
    await b.open('something I had typed before installing');
    expect(b.status.kind).toBe('conflict');
    b.conflict!.useGit();
    await b.advance(0);
    expect(b.editor.code).toBe('theirs');
    expect(b.conflict).toBeNull();
    expect(writes()).toBe(0);
    // Edits now flow normally again.
    b.type('theirs, improved');
    await b.advance(10_000);
    expect(gh.files.get(PY_PATH)?.content).toBe('theirs, improved\n');
  });

  it('"Git always wins" loads the repo version without asking', async () => {
    gh.commitElsewhere(PY_PATH, 'theirs\n');
    const b = browser(gh, { gitAlwaysWins: true });
    await b.open('local edits');
    expect(b.editor.code).toBe('theirs');
    expect(b.conflict).toBeNull();
    expect(b.status.kind).toBe('loaded');
  });

  it('detects the repo moving while the problem is open', async () => {
    const b = browser(gh);
    await b.open();
    b.type('v1');
    await b.advance(10_000);
    gh.commitElsewhere(PY_PATH, 'pushed from laptop\n');
    b.type('v2');
    await b.advance(10_000);
    expect(gh.files.get(PY_PATH)?.content).toBe('pushed from laptop\n'); // not overwritten
    expect(b.status.kind).toBe('conflict');
  });

  it('commits accepted submissions with their stats, even if the draft was already saved', async () => {
    const b = browser(gh);
    await b.open();
    b.type('final');
    await b.advance(10_000);
    b.controller.onAccepted({ slug: 'two-sum', lang: 'python3', code: 'final', runtime: '52 ms', memory: '17.1 MB' });
    await b.advance(0);
    expect(messages()).toEqual([
      'draft: 1. Two Sum (python3)',
      'accepted: 1. Two Sum (python3) - 52 ms, 17.1 MB',
    ]);
    expect(b.status.text).toMatch(/Accepted/);
  });

  it('with draft sync off, only accepted submissions are committed', async () => {
    const b = browser(gh, { syncDrafts: false });
    await b.open();
    b.type('wip');
    await b.advance(60_000);
    expect(writes()).toBe(0);
    b.controller.onAccepted({ slug: 'two-sum', lang: 'python3', code: 'wip' });
    await b.advance(0);
    expect(messages()).toEqual(['accepted: 1. Two Sum (python3)']);
  });

  it('remembers an accepted result during a conflict and records it on "Keep mine"', async () => {
    gh.commitElsewhere(PY_PATH, 'theirs\n');
    const b = browser(gh);
    await b.open('mine');
    b.controller.onAccepted({ slug: 'two-sum', lang: 'python3', code: 'mine', runtime: '1 ms' });
    await b.advance(0);
    expect(gh.files.get(PY_PATH)?.content).toBe('theirs\n');
    b.conflict!.keepMine();
    await b.advance(0);
    expect(messages().at(-1)).toBe('accepted: 1. Two Sum (python3) - 1 ms');
  });

  it('commits an accepted result for a problem that is no longer on screen', async () => {
    const b = browser(gh);
    await b.open();
    b.controller.onAccepted({ slug: 'add-two-numbers', lang: 'cpp', code: 'done' });
    await b.advance(0);
    expect(gh.files.get('problems/0002-add-two-numbers/solution.cpp')?.content).toBe('done\n');
  });

  it('keeps each language in its own file and flushes the draft on switch', async () => {
    gh.commitElsewhere(CPP_PATH, '// my c++\n');
    const b = browser(gh);
    await b.open();
    b.type('python wip');
    await b.advance(2_000);
    b.switchLang('cpp', CPP_TEMPLATE);
    await b.advance(1_500);
    expect(gh.files.get(PY_PATH)?.content).toBe('python wip\n'); // flushed, not lost
    expect(b.editor.code).toBe('// my c++'); // and the C++ file was loaded
    expect(gh.files.get(CPP_PATH)?.content).toBe('// my c++\n');
  });

  it('flushes a pending draft when the tab is hidden or the problem is left', async () => {
    const b = browser(gh);
    await b.open();
    b.type('one');
    b.controller.onVisibilityChange(false);
    await b.advance(0);
    expect(gh.files.get(PY_PATH)?.content).toBe('one\n');

    b.type('two');
    b.controller.onEditorState(null); // navigated away from the problem
    await b.advance(0);
    expect(gh.files.get(PY_PATH)?.content).toBe('two\n');
    expect(b.status.kind).toBe('hidden');
  });

  it('does not push or undo a "reset to default code"', async () => {
    const b = browser(gh);
    await b.open();
    b.type('my solution');
    await b.advance(10_000);
    b.pageSet(PY_TEMPLATE);
    await b.advance(30_000);
    expect(b.editor.code).toBe(PY_TEMPLATE);
    expect(gh.files.get(PY_PATH)?.content).toBe('my solution\n');
    // Starting over from the template then saves normally.
    b.type(PY_TEMPLATE + 'pass');
    await b.advance(10_000);
    expect(gh.files.get(PY_PATH)?.content).toBe(PY_TEMPLATE + 'pass\n');
  });

  it('never auto-pushes code the page restored by itself', async () => {
    const b = browser(gh);
    await b.open();
    b.type('synced');
    await b.advance(10_000);
    b.pageSet('stale copy restored by LeetCode');
    await b.advance(30_000);
    expect(gh.files.get(PY_PATH)?.content).toBe('synced\n');
    expect(b.status.kind).toBe('conflict');
  });

  it('waits for the code box to stop changing before the first sync', async () => {
    gh.commitElsewhere(PY_PATH, 'theirs\n');
    const b = browser(gh);
    b.pageSet(''); // editor created, still empty
    await b.advance(1_000);
    b.pageSet(PY_TEMPLATE); // LeetCode fills it in
    await b.advance(1_000);
    expect(gh.requests).toHaveLength(0);
    await b.advance(500);
    expect(b.editor.code).toBe('theirs');
  });

  it('stays quiet and asks for setup when not configured', async () => {
    const b = browser(gh, { token: '' });
    await b.open();
    b.type('x');
    await b.advance(20_000);
    expect(b.status.kind).toBe('unconfigured');
    expect(gh.requests).toHaveLength(0);
  });

  it('reports GitHub failures and recovers on the next edit', async () => {
    const b = browser(gh);
    await b.open();
    gh.failWith = { status: 401 };
    b.type('v1');
    await b.advance(10_000);
    expect(b.status.kind).toBe('error');
    expect(b.status.detail).toMatch(/token/i);
    gh.failWith = null;
    b.type('v2');
    await b.advance(10_000);
    expect(gh.files.get(PY_PATH)?.content).toBe('v2\n');
    expect(b.status.kind).toBe('saved');
  });

  it('"Sync now" commits immediately, even with draft sync off', async () => {
    const b = browser(gh, { syncDrafts: false });
    await b.open();
    b.type('manual save');
    await b.controller.syncNow();
    await settle(b.controller);
    expect(gh.files.get(PY_PATH)?.content).toBe('manual save\n');
    expect(b.controller.describe()).toMatchObject({ active: true, slug: 'two-sum', lang: 'python3' });
  });

  it('treats line-ending and trailing-newline differences as the same code', async () => {
    gh.commitElsewhere(PY_PATH, 'a = 1\r\nb = 2\r\n\r\n');
    const b = browser(gh);
    await b.open('a = 1\nb = 2');
    expect(b.status.kind).toBe('synced');
    expect(b.editor.code).toBe('a = 1\nb = 2');
    expect(writes()).toBe(0);
  });
});
