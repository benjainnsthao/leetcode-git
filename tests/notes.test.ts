import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, type ServiceDeps } from '../src/background/service';
import type {
  NotesDraftResponse,
  NotesGetResponse,
  NotesListResponse,
  NotesPutResponse,
} from '../src/core/messages';
import { DEFAULT_SETTINGS, SETTINGS_KEY, clampNotesGap, mergeSettings, type Settings } from '../src/core/settings';
import { isValidNoteName, notesCommitMessage, notesDir } from '../src/core/paths';
import { NotesController, type HistoryEntry, type NotesStatus, type NotesView } from '../src/notes/controller';
import {
  EMPTY_DOC,
  History,
  addShapes,
  bounds,
  boundsOf,
  duplicate,
  eraseAt,
  moveShapes,
  pick,
  removeShapes,
  restyle,
  shapesInBox,
  simplify,
  validateShape,
  validateShapes,
  type Doc,
  type Shape,
} from '../src/notes/model';
import { freeNoteFileName, noteFileName, noteLabel, shouldContinue, sortNotes } from '../src/notes/session';
import { elementsFor, fromSvg, toSvg } from '../src/notes/svg';
import { FakeGitHub, MemoryStore } from './fake-github';

const style = { color: '#1f2328', width: 4 };
const rect = (id: string, x: number, y: number, w = 100, h = 60): Shape => ({ id, type: 'rect', x, y, w, h, ...style });
const line = (id: string, x1: number, y1: number, x2: number, y2: number): Shape => ({
  id,
  type: 'line',
  x1,
  y1,
  x2,
  y2,
  ...style,
});
const docOf = (...shapes: Shape[]): Doc => ({ shapes });

describe('drawing model', () => {
  it('computes bounds for each kind of shape', () => {
    expect(bounds(rect('a', 10, 20))).toEqual({ x: 10, y: 20, w: 100, h: 60 });
    expect(bounds(line('b', 50, 80, 10, 20))).toEqual({ x: 10, y: 20, w: 40, h: 60 });
    expect(bounds({ id: 'c', type: 'pen', points: [[5, 5], [15, 0], [10, 30]], ...style })).toEqual({
      x: 5,
      y: 0,
      w: 10,
      h: 30,
    });
    expect(boundsOf([rect('a', 0, 0), rect('b', 200, 100)])).toEqual({ x: 0, y: 0, w: 300, h: 160 });
    expect(boundsOf([])).toBeNull();
  });

  it('picks by outline first, then by the smallest shape containing the point', () => {
    const outer = rect('outer', 0, 0, 400, 300);
    const cell = rect('cell', 100, 100, 50, 50);
    const stroke = line('stroke', 0, 150, 400, 150);
    const doc = docOf(outer, cell, stroke);
    expect(pick(doc, 300, 150, 5)?.id).toBe('stroke'); // on the line
    expect(pick(doc, 100, 110, 5)?.id).toBe('cell'); // on the cell's edge
    expect(pick(doc, 120, 120, 5)?.id).toBe('cell'); // inside both: smallest wins
    expect(pick(doc, 300, 50, 5)?.id).toBe('outer'); // inside the outer only
    expect(pick(doc, 900, 900, 5)).toBeNull();
  });

  it('picks ellipses by their curve, not their bounding box', () => {
    const doc = docOf({ id: 'e', type: 'ellipse', x: 0, y: 0, w: 200, h: 100, ...style });
    expect(pick(doc, 100, 0, 4)?.id).toBe('e'); // top of the curve
    expect(pick(doc, 100, 50, 4)?.id).toBe('e'); // centre
    expect(pick(doc, 3, 3, 4)).toBeNull(); // corner of the box, outside the ellipse
  });

  it('box-selects only shapes entirely inside the box', () => {
    const doc = docOf(rect('a', 10, 10, 50, 50), rect('b', 100, 10, 50, 50), rect('c', 140, 10, 100, 50));
    expect(shapesInBox(doc, { x: 0, y: 0, w: 160, h: 100 }).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('moves, removes and restyles by id without touching other shapes', () => {
    const a = rect('a', 0, 0);
    const b = rect('b', 200, 0);
    const doc = docOf(a, b);
    const moved = moveShapes(doc, new Set(['a']), 15, -5);
    expect(moved.shapes[0]).toMatchObject({ x: 15, y: -5 });
    expect(moved.shapes[1]).toBe(b);
    expect(moveShapes(doc, new Set(['a']), 0, 0)).toBe(doc);
    expect(removeShapes(doc, new Set(['b'])).shapes).toEqual([a]);
    expect(removeShapes(doc, new Set(['zzz']))).toBe(doc);
    expect(restyle(doc, new Set(['a']), { color: '#cf222e' }).shapes[0].color).toBe('#cf222e');
    expect(restyle(doc, new Set(['a']), { color: a.color })).toBe(doc);
  });

  it('duplicates with fresh ids and an offset, for copy and paste', () => {
    const originals = [rect('a', 0, 0), line('b', 0, 0, 10, 10)];
    const copies = duplicate(originals, 24, 24);
    expect(copies).toHaveLength(2);
    expect(copies[0]).toMatchObject({ type: 'rect', x: 24, y: 24, w: 100, h: 60 });
    expect(copies[1]).toMatchObject({ type: 'line', x1: 24, y1: 24, x2: 34, y2: 34 });
    expect(new Set([...copies.map((s) => s.id), 'a', 'b']).size).toBe(4);
    expect(addShapes(docOf(...originals), copies).shapes).toHaveLength(4);
  });

  it('erases whole shapes the eraser touches', () => {
    const doc = docOf(rect('a', 0, 0, 100, 100), line('b', 300, 0, 300, 100));
    expect(eraseAt(doc, 0, 50, 6).shapes.map((s) => s.id)).toEqual(['b']); // on the rectangle's edge
    expect(eraseAt(doc, 50, 50, 6)).toBe(doc); // inside the rectangle: nothing drawn there
  });

  it('thins freehand strokes but keeps both ends', () => {
    const dense: [number, number][] = Array.from({ length: 101 }, (_, i) => [i * 0.2, 0]);
    const thin = simplify(dense);
    expect(thin.length).toBeLessThan(20);
    expect(thin[0]).toEqual([0, 0]);
    expect(thin[thin.length - 1]).toEqual([20, 0]);
    expect(simplify([[5, 5]])).toEqual([[5, 5]]);
  });

  it('undoes and redoes', () => {
    const h = new History();
    const one = docOf(rect('a', 0, 0));
    const two = addShapes(one, [rect('b', 10, 10)]);
    expect(h.commit(one)).toBe(true);
    expect(h.commit(one)).toBe(false);
    h.commit(two);
    expect(h.undo()).toBe(true);
    expect(h.doc).toBe(one);
    expect(h.redo()).toBe(true);
    expect(h.doc).toBe(two);
    h.undo();
    h.commit(EMPTY_DOC); // a new edit discards the redo branch
    expect(h.canRedo).toBe(false);
    h.undo();
    h.undo();
    expect(h.doc).toBe(EMPTY_DOC);
    expect(h.undo()).toBe(false);
  });

  it('rejects malformed shape data', () => {
    expect(validateShape(rect('a', 0, 0))).toEqual(rect('a', 0, 0));
    expect(validateShape({ ...rect('a', 0, 0), color: 'red' })).toBeNull();
    expect(validateShape({ ...rect('a', 0, 0), color: '#fff"><script>' })).toBeNull();
    expect(validateShape({ ...rect('a', 0, 0), id: '<b>' })).toBeNull();
    expect(validateShape({ ...rect('a', 0, 0), x: Infinity })).toBeNull();
    expect(validateShape({ ...rect('a', 0, 0), w: -1 })).toBeNull();
    expect(validateShape({ ...rect('a', 0, 0), width: 500 })).toBeNull();
    expect(validateShape({ ...rect('a', 0, 0), type: 'script' })).toBeNull();
    expect(validateShape({ id: 'p', type: 'pen', points: [], ...style })).toBeNull();
    expect(validateShape({ id: 'p', type: 'pen', points: [[1, 'x']], ...style })).toBeNull();
    expect(validateShape(null)).toBeNull();
    expect(validateShapes([rect('a', 0, 0), { junk: true }, rect('a', 5, 5), rect('b', 1, 1)])).toEqual([
      rect('a', 0, 0),
      rect('b', 1, 1),
    ]);
    expect(validateShapes('nope')).toBeNull();
  });
});

describe('note files', () => {
  const meta = { startedAt: '2026-11-14T09:35:00.000Z', savedAt: '2026-11-14T09:50:00.000Z' };
  const everything = docOf(
    rect('r', 10, 20),
    { id: 'e', type: 'ellipse', x: 200, y: 20, w: 80, h: 40, ...style },
    line('l', 0, 0, 50, 50),
    { id: 'a', type: 'arrow', x1: 0, y1: 100, x2: 120, y2: 100, color: '#0969da', width: 2 },
    { id: 'p', type: 'pen', points: [[1, 2], [3.5, 4], [10, 12]], ...style },
    { id: 'dot', type: 'pen', points: [[40, 40]], ...style },
  );

  it('round-trips a drawing exactly', () => {
    const note = fromSvg(toSvg(everything, meta));
    expect(note).toEqual({ doc: everything, meta });
  });

  it('is a plain SVG picture that image viewers can show', () => {
    const svg = toSvg(everything, meta);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000"')).toBe(true);
    expect(svg).toContain('<rect width="1600" height="1000" fill="#ffffff"/>');
    for (const tag of ['<rect x="10"', '<ellipse cx="240"', '<line x1="0"', '<polygon points="120,100', '<path d="M1 2L3.5 4L10 12"']) {
      expect(svg).toContain(tag);
    }
    // A single dot is drawn as a zero-length segment so round caps show it.
    expect(svg).toContain('<path d="M40 40L40 40"');
    expect(svg.endsWith('</svg>\n')).toBe(true);
    // The embedded data never breaks out of its element.
    const inner = /<metadata id="lcgit-notes">([\s\S]*?)<\/metadata>/.exec(svg)![1];
    expect(inner).not.toMatch(/[<>]/);
  });

  it('draws arrows as a shaft plus a filled head', () => {
    const parts = elementsFor({ id: 'a', type: 'arrow', x1: 0, y1: 0, x2: 100, y2: 0, ...style });
    expect(parts.map((p) => p.tag)).toEqual(['line', 'polygon']);
    expect(parts[1].attrs.fill).toBe(style.color);
  });

  it('writes an empty note as a blank page', () => {
    expect(fromSvg(toSvg(EMPTY_DOC, meta))).toEqual({ doc: EMPTY_DOC, meta });
  });

  it('refuses files it did not write and drops unusable shapes', () => {
    expect(fromSvg('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>')).toBeNull();
    expect(fromSvg('<svg><metadata id="lcgit-notes">{not json</metadata></svg>')).toBeNull();
    expect(fromSvg('<svg><metadata id="lcgit-notes">{"v":2,"shapes":[]}</metadata></svg>')).toBeNull();
    expect(fromSvg('<svg><metadata id="lcgit-notes">{"v":1,"startedAt":"x","savedAt":"y","shapes":[]}</metadata></svg>')).toBeNull();
    const original = toSvg(everything, meta);
    const tampered = original.replace('&quot;id&quot;:&quot;r&quot;', '&quot;id&quot;:&quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;');
    expect(tampered).not.toBe(original);
    const note = fromSvg(tampered);
    expect(note?.doc.shapes.map((s) => s.id)).toEqual(['e', 'l', 'a', 'p', 'dot']);
    expect(fromSvg('x'.repeat(2_000_001))).toBeNull();
  });
});

describe('sessions', () => {
  it('names files by local start time', () => {
    const d = new Date(2026, 10, 4, 9, 5, 59);
    expect(noteFileName(d)).toBe('2026-11-04_09-05.svg');
    expect(noteFileName(d, 2)).toBe('2026-11-04_09-05-2.svg');
    expect(isValidNoteName(noteFileName(d))).toBe(true);
    expect(isValidNoteName(noteFileName(d, 3))).toBe(true);
    expect(isValidNoteName('../x.svg')).toBe(false);
    expect(isValidNoteName('2026-11-04_09-05.png')).toBe(false);
  });

  it('avoids names that are taken', () => {
    const d = new Date(2026, 10, 4, 9, 5);
    expect(freeNoteFileName(d, new Set())).toBe('2026-11-04_09-05.svg');
    expect(freeNoteFileName(d, new Set(['2026-11-04_09-05.svg', '2026-11-04_09-05-2.svg']))).toBe(
      '2026-11-04_09-05-3.svg',
    );
  });

  it('labels and sorts notes newest first', () => {
    expect(noteLabel('2026-11-04_09-05.svg')).toBe('2026-11-04 09:05');
    expect(noteLabel('2026-11-04_09-05-2.svg')).toBe('2026-11-04 09:05 (2)');
    expect(noteLabel('README.md')).toBeNull();
    const names = ['2026-11-04_09-05.svg', 'README.md', '2026-11-16_21-10.svg', '2026-11-04_09-05-2.svg', '2025-12-31_23-59.svg'];
    expect(sortNotes(names.map((name) => ({ name }))).map((f) => f.name)).toEqual([
      '2026-11-16_21-10.svg',
      '2026-11-04_09-05-2.svg',
      '2026-11-04_09-05.svg',
      '2025-12-31_23-59.svg',
    ]);
  });

  it('continues a note saved less than the gap ago, otherwise starts a new one', () => {
    const now = new Date('2026-11-14T12:00:00Z');
    expect(shouldContinue('2026-11-14T11:00:01Z', now, 60)).toBe(true);
    expect(shouldContinue('2026-11-14T11:00:00Z', now, 60)).toBe(false);
    expect(shouldContinue('2026-11-14T11:30:00Z', now, 15)).toBe(false);
    expect(shouldContinue(undefined, now, 60)).toBe(false);
    expect(shouldContinue('garbage', now, 60)).toBe(false);
    expect(shouldContinue('2026-11-14T12:05:00Z', now, 60)).toBe(true); // small clock skew
    expect(shouldContinue('2026-11-20T12:00:00Z', now, 60)).toBe(false); // nonsense future date
  });

  it('keeps the gap setting within sane limits', () => {
    expect(clampNotesGap(60)).toBe(60);
    expect(clampNotesGap('90')).toBe(90);
    expect(clampNotesGap(0)).toBe(1);
    expect(clampNotesGap(1e9)).toBe(10080);
    expect(clampNotesGap('abc')).toBe(60);
    expect(mergeSettings({ notesGapMinutes: 15 }).notesGapMinutes).toBe(15);
    expect(mergeSettings({ notesGapMinutes: 'x' }).notesGapMinutes).toBe(60);
  });

  it('places notes beside the solutions', () => {
    const meta = { slug: 'two-sum', frontendId: '1', title: 'Two Sum' };
    expect(notesDir('problems', meta)).toBe('problems/0001-two-sum/notes');
    expect(notesDir('', meta)).toBe('0001-two-sum/notes');
    expect(notesCommitMessage(meta, '2026-11-14_09-35.svg')).toBe('notes: 1. Two Sum (2026-11-14 09:35)');
  });
});

// ---------------------------------------------------------------------------

const DIR = 'problems/0001-two-sum/notes';
const metaInput = { frontendId: '1', title: 'Two Sum' };

describe('background notes requests', () => {
  let gh: FakeGitHub;
  let store: MemoryStore;
  let deps: ServiceDeps;
  const svg = toSvg(docOf(rect('a', 0, 0)), { startedAt: '2026-11-14T09:35:00Z', savedAt: '2026-11-14T09:36:00Z' });

  beforeEach(() => {
    gh = new FakeGitHub();
    store = new MemoryStore();
    store.data[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, token: 'tok', repo: 'octo/sols' };
    deps = { store, fetch: gh.fetch, openOptions: () => undefined };
  });

  const list = () => handleRequest({ type: 'notes/list', slug: 'two-sum', meta: metaInput }, deps) as Promise<NotesListResponse>;
  const put = (name: string, content: string, expectedSha: string | null) =>
    handleRequest({ type: 'notes/put', slug: 'two-sum', meta: metaInput, name, content, expectedSha }, deps) as Promise<NotesPutResponse>;
  const get = (name: string) =>
    handleRequest({ type: 'notes/get', slug: 'two-sum', meta: metaInput, name }, deps) as Promise<NotesGetResponse>;

  it('lists nothing for a problem without notes, and says when not set up', async () => {
    expect(await list()).toEqual({
      ok: true,
      configured: true,
      files: [],
      gapMinutes: 60,
      dirUrl: `https://github.com/octo/sols/tree/HEAD/${DIR}`,
    });
    store.data[SETTINGS_KEY] = DEFAULT_SETTINGS;
    expect(await list()).toEqual({ ok: true, configured: false });
  });

  it('saves, lists and reads back a note', async () => {
    const res = await put('2026-11-14_09-35.svg', svg, null);
    expect(res.ok).toBe(true);
    expect(gh.commits[0]).toMatchObject({
      path: `${DIR}/2026-11-14_09-35.svg`,
      message: 'notes: 1. Two Sum (2026-11-14 09:35)',
      content: svg,
    });
    gh.commitElsewhere(`${DIR}/README.md`, 'not a note');
    const listed = await list();
    expect(listed.ok && listed.configured && listed.files.map((f) => f.name)).toEqual(['2026-11-14_09-35.svg']);
    const got = await get('2026-11-14_09-35.svg');
    expect(got.ok && got.file?.content).toBe(svg);
    expect(await get('2020-01-01_00-00.svg')).toEqual({ ok: true, file: null });
  });

  it('reports a conflict instead of overwriting', async () => {
    const first = await put('2026-11-14_09-35.svg', svg, null);
    expect(await put('2026-11-14_09-35.svg', svg, null)).toEqual({ ok: false, conflict: true }); // name taken
    gh.commitElsewhere(`${DIR}/2026-11-14_09-35.svg`, 'changed elsewhere');
    expect(await put('2026-11-14_09-35.svg', svg, first.ok ? first.sha : null)).toEqual({ ok: false, conflict: true });
    expect(gh.files.get(`${DIR}/2026-11-14_09-35.svg`)?.content).toBe('changed elsewhere');
  });

  it('refuses unsafe names and non-SVG content', async () => {
    expect((await put('../../README.md', svg, null)).ok).toBe(false);
    expect((await put('notes.svg', svg, null)).ok).toBe(false);
    expect((await put('2026-11-14_09-35.svg', 'hello', null)).ok).toBe(false);
    expect((await get('../solution.py')).ok).toBe(false);
    expect(gh.requests).toHaveLength(0);
  });

  it('keeps a local draft per problem', async () => {
    const draft = (op: 'get' | 'set', value?: string | null) =>
      handleRequest({ type: 'notes/draft', slug: 'two-sum', op, value }, deps) as Promise<NotesDraftResponse>;
    expect(await draft('get')).toEqual({ ok: true, value: null });
    await draft('set', '{"x":1}');
    expect(await draft('get')).toEqual({ ok: true, value: '{"x":1}' });
    await draft('set', null);
    expect(await draft('get')).toEqual({ ok: true, value: null });
    expect((await draft('set', 'x'.repeat(1_500_001))).ok).toBe(false);
    expect(gh.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

declare function setImmediate(callback: (value?: unknown) => void): unknown;

class FakeView implements NotesView {
  opened = false;
  loading = false;
  current: { doc: Doc; label: string } | null = null;
  past: { doc: Doc; label: string } | null = null;
  history: HistoryEntry[] = [];
  label = '';
  status: NotesStatus = { text: '', tone: '' };
  isOpen = () => this.opened;
  open = () => void (this.opened = true);
  close = () => void (this.opened = false);
  setLoading = (v: boolean) => void (this.loading = v);
  loadCurrent = (doc: Doc, label: string) => {
    this.current = { doc, label };
    this.label = label;
    this.past = null;
  };
  showPast = (doc: Doc, label: string) => void (this.past = { doc, label });
  showCurrent = () => void (this.past = null);
  setHistory = (entries: HistoryEntry[], currentLabel: string) => {
    this.history = entries;
    this.label = currentLabel;
  };
  setStatus = (s: NotesStatus) => void (this.status = s);
}

/** A shared wall clock, so several simulated browsers agree on the time. */
const clock = { ms: 0 };

/** One page load in one browser. Pass `store` to simulate a reload in the same browser. */
function page(gh: FakeGitHub, store = new MemoryStore(), settings: Partial<Settings> = {}) {
  if (!(SETTINGS_KEY in store.data)) {
    store.data[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, token: 'tok', repo: 'octo/sols', ...settings };
  }
  const deps: ServiceDeps = { store, fetch: gh.fetch, openOptions: () => undefined };
  const view = new FakeView();
  const notes = new NotesController({
    list: (r) => handleRequest({ type: 'notes/list', ...r }, deps) as Promise<NotesListResponse>,
    get: (r) => handleRequest({ type: 'notes/get', ...r }, deps) as Promise<NotesGetResponse>,
    put: (r) => handleRequest({ type: 'notes/put', ...r }, deps) as Promise<NotesPutResponse>,
    draft: (r) => handleRequest({ type: 'notes/draft', ...r }, deps) as Promise<NotesDraftResponse>,
    getMeta: async (slug) =>
      slug === 'two-sum' ? { frontendId: '1', title: 'Two Sum' } : { frontendId: '2', title: 'Add Two Numbers' },
    view,
    now: () => new Date(clock.ms),
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
      await notes.whenIdle();
    }
  };
  return {
    store,
    view,
    notes,
    settle,
    async advance(ms: number) {
      clock.ms += ms;
      await vi.advanceTimersByTimeAsync(ms);
      await settle();
    },
    /** Opens the problem and the notes panel. */
    async open(slug = 'two-sum') {
      notes.setProblem(slug);
      notes.toggle();
      await settle();
    },
    /** The user draws: the panel reports a new drawing. */
    draw(...shapes: Shape[]) {
      const doc = addShapes(view.current!.doc, shapes);
      view.current = { doc, label: view.label };
      notes.onDocChange(doc);
      return doc;
    },
    async close() {
      notes.toggle();
      await settle();
    },
  };
}

const MIN = 60_000;

describe('NotesController', () => {
  let gh: FakeGitHub;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    gh = new FakeGitHub();
    clock.ms = new Date(2026, 10, 14, 9, 35, 0).getTime();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const noteFiles = () => [...gh.files.keys()].filter((p) => p.includes('/notes/')).sort();
  const writes = () => gh.requests.filter((r) => r.method === 'PUT').length;
  const shapesIn = (path: string) => fromSvg(gh.files.get(path)!.content)!.doc.shapes.map((s) => s.id);
  const FIRST = `${DIR}/2026-11-14_09-35.svg`;

  it('starts with a blank page and creates no file until something is drawn', async () => {
    const p = page(gh);
    await p.open();
    expect(p.view.opened).toBe(true);
    expect(p.view.current).toEqual({ doc: EMPTY_DOC, label: 'New note' });
    expect(p.view.history).toEqual([]);
    await p.advance(5 * MIN);
    await p.close();
    expect(writes()).toBe(0);
  });

  it('saves 30s after drawing stops, named by when the session started', async () => {
    const p = page(gh);
    await p.open();
    p.draw(rect('a', 0, 0));
    await p.advance(20_000);
    p.draw(rect('b', 200, 0));
    await p.advance(29_000);
    expect(writes()).toBe(0);
    await p.advance(1_000);
    expect(noteFiles()).toEqual([FIRST]);
    expect(shapesIn(FIRST)).toEqual(['a', 'b']);
    expect(gh.commits[0].message).toBe('notes: 1. Two Sum (2026-11-14 09:35)');
    expect(p.view.label).toBe('2026-11-14 09:35');
    expect(p.view.status.tone).toBe('ok');
  });

  it('saves immediately when the panel is closed, the tab is hidden or the problem is left', async () => {
    const p = page(gh);
    await p.open();
    p.draw(rect('a', 0, 0));
    await p.close();
    expect(shapesIn(FIRST)).toEqual(['a']);

    p.notes.toggle();
    await p.settle();
    p.draw(rect('b', 0, 0));
    p.notes.onHidden();
    await p.settle();
    expect(shapesIn(FIRST)).toEqual(['a', 'b']);

    p.draw(rect('c', 0, 0));
    p.notes.setProblem('add-two-numbers');
    await p.settle();
    expect(shapesIn(FIRST)).toEqual(['a', 'b', 'c']);
    // The panel stays open and now shows the other problem's (empty) notes.
    expect(p.view.current).toEqual({ doc: EMPTY_DOC, label: 'New note' });
  });

  it('keeps one file per session however many times it saves', async () => {
    const p = page(gh);
    await p.open();
    for (const id of ['a', 'b', 'c']) {
      p.draw(rect(id, 0, 0));
      await p.advance(30_000);
    }
    expect(noteFiles()).toEqual([FIRST]);
    expect(writes()).toBe(3);
    expect(shapesIn(FIRST)).toEqual(['a', 'b', 'c']);
  });

  it('continues the same note when reopened within the hour', async () => {
    const first = page(gh);
    await first.open();
    first.draw(rect('a', 0, 0));
    await first.close();

    clock.ms += 59 * MIN;
    const reload = page(gh, first.store);
    await reload.open();
    expect(reload.view.current!.doc.shapes.map((s) => s.id)).toEqual(['a']);
    expect(reload.view.label).toBe('2026-11-14 09:35');
    expect(reload.view.history).toEqual([]);
    reload.draw(rect('b', 0, 0));
    await reload.close();
    expect(noteFiles()).toEqual([FIRST]);
    expect(shapesIn(FIRST)).toEqual(['a', 'b']);
  });

  it('starts a new blank note after a longer break and keeps the old one in the history', async () => {
    const first = page(gh);
    await first.open();
    first.draw(rect('a', 0, 0));
    await first.close();
    const firstContent = gh.files.get(FIRST)!.content;

    clock.ms += 61 * MIN;
    const later = page(gh, first.store);
    await later.open();
    expect(later.view.current).toEqual({ doc: EMPTY_DOC, label: 'New note' });
    expect(later.view.history).toEqual([{ name: '2026-11-14_09-35.svg', label: '2026-11-14 09:35' }]);
    expect(writes()).toBe(1); // opening alone creates nothing

    later.draw(rect('b', 0, 0));
    await later.close();
    const SECOND = `${DIR}/2026-11-14_10-36.svg`;
    expect(noteFiles()).toEqual([FIRST, SECOND]);
    expect(shapesIn(SECOND)).toEqual(['b']);
    expect(gh.files.get(FIRST)!.content).toBe(firstContent); // the earlier note is untouched
    expect(later.view.label).toBe('2026-11-14 10:36');
  });

  it('honours the "new note after" setting', async () => {
    const first = page(gh, undefined, { notesGapMinutes: 5 });
    await first.open();
    first.draw(rect('a', 0, 0));
    await first.close();
    clock.ms += 6 * MIN;
    const later = page(gh, first.store);
    await later.open();
    expect(later.view.current!.doc).toBe(EMPTY_DOC);
    expect(later.view.history).toHaveLength(1);
  });

  it('starts a new note when the panel is reopened after a long break without a reload', async () => {
    const p = page(gh);
    await p.open();
    p.draw(rect('a', 0, 0));
    await p.close();
    await p.advance(30 * MIN);
    p.notes.toggle();
    await p.settle();
    expect(p.view.current!.doc.shapes).toHaveLength(1); // still the same session
    await p.close();
    await p.advance(2 * 60 * MIN);
    p.notes.toggle();
    await p.settle();
    expect(p.view.current).toEqual({ doc: EMPTY_DOC, label: 'New note' });
    expect(p.view.history.map((h) => h.label)).toEqual(['2026-11-14 09:35']);
  });

  it('shows earlier notes read-only and returns to the current one', async () => {
    const first = page(gh);
    await first.open();
    first.draw(rect('a', 0, 0), rect('b', 200, 0));
    await first.close();
    gh.commitElsewhere(`${DIR}/2026-01-01_00-00.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');

    clock.ms += 3 * 60 * MIN;
    const later = page(gh, first.store);
    await later.open();
    later.notes.pickHistory('2026-11-14_09-35.svg');
    await later.settle();
    expect(later.view.past?.label).toBe('2026-11-14 09:35');
    expect(later.view.past?.doc.shapes.map((s) => s.id)).toEqual(['a', 'b']);
    later.notes.pickHistory(null);
    expect(later.view.past).toBeNull();

    // A file that is not one of ours is refused, not rendered.
    later.notes.pickHistory('2026-01-01_00-00.svg');
    await later.settle();
    expect(later.view.past).toBeNull();
    expect(later.view.status.tone).toBe('bad');
    expect(writes()).toBe(1); // looking at history never writes
  });

  it('never overwrites a note changed from another computer: the drawing goes to a new file', async () => {
    const a = page(gh);
    await a.open();
    a.draw(rect('a1', 0, 0));
    await a.close();

    clock.ms += 10 * MIN;
    const b = page(gh); // another computer, same repo
    await b.open();
    expect(b.view.current!.doc.shapes.map((s) => s.id)).toEqual(['a1']); // continues A's note

    a.notes.toggle();
    await a.settle();
    a.draw(rect('a2', 0, 0));
    await a.close();

    b.draw(rect('b1', 0, 0));
    await b.close();
    const SECOND = `${DIR}/2026-11-14_09-45.svg`;
    expect(noteFiles()).toEqual([FIRST, SECOND]);
    expect(shapesIn(FIRST)).toEqual(['a1', 'a2']);
    expect(shapesIn(SECOND)).toEqual(['a1', 'b1']);
    expect(b.view.label).toBe('2026-11-14 09:45');
    expect(b.view.history.map((h) => h.label)).toEqual(['2026-11-14 09:35']);
  });

  it('adds a suffix when two sessions start in the same minute', async () => {
    const a = page(gh);
    const b = page(gh);
    await a.open();
    await b.open(); // both see an empty folder
    a.draw(rect('a', 0, 0));
    await a.close();
    b.draw(rect('b', 0, 0));
    await b.close();
    expect(noteFiles()).toEqual([`${DIR}/2026-11-14_09-35-2.svg`, FIRST]);
    expect(shapesIn(`${DIR}/2026-11-14_09-35-2.svg`)).toEqual(['b']);
    expect(b.view.label).toBe('2026-11-14 09:35 (2)');
  });

  it('restores unsaved strokes after the page dies, and saves them', async () => {
    const p = page(gh);
    await p.open();
    p.draw(rect('a', 0, 0));
    await p.advance(2_000); // local copy written; the 30s commit has not happened
    expect(writes()).toBe(0);

    clock.ms += 5 * MIN; // browser crashed; reopened a few minutes later
    const reload = page(gh, p.store);
    await reload.open();
    expect(reload.view.current!.doc.shapes.map((s) => s.id)).toEqual(['a']);
    expect(shapesIn(FIRST)).toEqual(['a']);
    expect(reload.store.data['notesDraft:two-sum']).toBeNull();
  });

  it('files unsaved strokes from an old session as their own note before starting fresh', async () => {
    const p = page(gh);
    await p.open();
    p.draw(rect('a', 0, 0));
    await p.advance(2_000);

    clock.ms += 3 * 60 * MIN;
    const later = page(gh, p.store);
    await later.open();
    expect(shapesIn(FIRST)).toEqual(['a']); // filed under its own start time
    expect(later.view.current).toEqual({ doc: EMPTY_DOC, label: 'New note' });
    expect(later.view.history.map((h) => h.label)).toEqual(['2026-11-14 09:35']);
    expect(later.store.data['notesDraft:two-sum']).toBeNull();
  });

  it('works without a repo, keeping the drawing in the browser, and saves once a repo is connected', async () => {
    const store = new MemoryStore();
    store.data[SETTINGS_KEY] = DEFAULT_SETTINGS;
    const p = page(gh, store);
    await p.open();
    expect(p.view.status).toMatchObject({ tone: 'warn', opensSettings: true });
    p.draw(rect('a', 0, 0));
    await p.close();
    expect(gh.requests).toHaveLength(0);

    clock.ms += 24 * 60 * MIN; // even much later, the only copy is kept
    const reload = page(gh, store);
    await reload.open();
    expect(reload.view.current!.doc.shapes.map((s) => s.id)).toEqual(['a']);
    reload.draw(rect('b', 0, 0));
    await reload.close();

    store.data[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, token: 'tok', repo: 'octo/sols' };
    reload.notes.toggle();
    await reload.settle();
    expect(noteFiles()).toHaveLength(1);
    expect(shapesIn(noteFiles()[0])).toEqual(['a', 'b']);
    expect(reload.view.status.tone).toBe('ok');
  });

  it('keeps the work when GitHub fails and saves on the next attempt', async () => {
    const p = page(gh);
    await p.open();
    gh.failWith = { status: 500 };
    p.draw(rect('a', 0, 0));
    await p.advance(30_000);
    expect(p.view.status.tone).toBe('bad');
    expect(typeof p.store.data['notesDraft:two-sum']).toBe('string'); // still safe locally
    gh.failWith = null;
    p.draw(rect('b', 0, 0));
    await p.advance(30_000);
    expect(shapesIn(FIRST)).toEqual(['a', 'b']);
    expect(p.view.status.tone).toBe('ok');
  });

  it('creates no file for something drawn and erased again before saving', async () => {
    const p = page(gh);
    await p.open();
    p.draw(rect('a', 0, 0));
    p.view.current = { doc: EMPTY_DOC, label: p.view.label };
    p.notes.onDocChange(EMPTY_DOC);
    await p.close();
    expect(writes()).toBe(0);
    expect(p.store.data['notesDraft:two-sum']).toBeNull();
  });

  it('keeps each problem to its own notes folder', async () => {
    const p = page(gh);
    await p.open('add-two-numbers');
    p.draw(rect('x', 0, 0));
    await p.close();
    expect(noteFiles()).toEqual(['problems/0002-add-two-numbers/notes/2026-11-14_09-35.svg']);
    expect(gh.commits[0].message).toBe('notes: 2. Add Two Numbers (2026-11-14 09:35)');
  });

  it('closes the panel when leaving problem pages', async () => {
    const p = page(gh);
    await p.open();
    p.notes.setProblem(null);
    expect(p.view.opened).toBe(false);
    p.notes.toggle(); // nothing to open it for
    expect(p.view.opened).toBe(false);
  });
});
