// Scratch-paper notes: decides which session a drawing belongs to, and keeps
// it saved. Like the sync controller it has no DOM or chrome dependencies;
// the panel and the background worker are injected.

import type {
  NoteFile,
  NotesDraftRequest,
  NotesDraftResponse,
  NotesGetRequest,
  NotesGetResponse,
  NotesListRequest,
  NotesListResponse,
  NotesPutRequest,
  NotesPutResponse,
} from '../core/messages';
import { EMPTY_DOC, validateShapes, type Doc } from './model';
import { freeNoteFileName, noteLabel, shouldContinue, sortNotes } from './session';
import { fromSvg, toSvg } from './svg';

export interface NotesStatus {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | '';
  /** Clicking the status opens the extension settings. */
  opensSettings?: boolean;
}

export interface HistoryEntry {
  name: string;
  label: string;
}

/** The panel, as far as the controller is concerned. */
export interface NotesView {
  isOpen(): boolean;
  open(): void;
  close(): void;
  setLoading(loading: boolean): void;
  /** Shows the session being worked on and clears undo history. */
  loadCurrent(doc: Doc, label: string): void;
  /** Shows an earlier note, read-only. */
  showPast(doc: Doc, label: string): void;
  showCurrent(): void;
  /** Earlier notes for the History menu (newest first) and the current note's label. */
  setHistory(entries: HistoryEntry[], currentLabel: string): void;
  setStatus(status: NotesStatus): void;
}

interface ProblemInfo {
  frontendId: string;
  title: string;
}

export interface NotesDeps {
  list(req: Omit<NotesListRequest, 'type'>): Promise<NotesListResponse>;
  get(req: Omit<NotesGetRequest, 'type'>): Promise<NotesGetResponse>;
  put(req: Omit<NotesPutRequest, 'type'>): Promise<NotesPutResponse>;
  draft(req: Omit<NotesDraftRequest, 'type'>): Promise<NotesDraftResponse>;
  getMeta(slug: string): Promise<ProblemInfo | null>;
  view: NotesView;
  now?: () => Date;
  timings?: Partial<NotesTimings>;
}

export interface NotesTimings {
  /** Quiet time after drawing before the note is committed. */
  saveMs: number;
  /** Quiet time after drawing before the local safety copy is written. */
  draftMs: number;
}

const DEFAULT_TIMINGS: NotesTimings = { saveMs: 30_000, draftMs: 1_000 };
const NEW_NOTE = 'New note';

/** Unsaved work, as kept in the browser between page loads. */
interface Draft {
  name: string | null;
  sha: string | null;
  startedAt: string;
  /** When the drawing last changed. */
  savedAt: string;
  doc: Doc;
}

/** Everything known about one problem's notes while it is on screen. */
interface Pad {
  slug: string;
  meta: ProblemInfo | null;
  loaded: boolean;
  configured: boolean;
  gapMinutes: number;
  /** Saved notes, newest first. */
  files: NoteFile[];
  doc: Doc;
  /** File of the current session; null until it is first saved. */
  name: string | null;
  sha: string | null;
  /** Set at the first stroke of a session. */
  startedAt: string | null;
  /** Last change or save, for the session rule while the page stays open. */
  lastActivity: number;
  dirty: boolean;
  queue: Promise<void>;
  saveTimer?: ReturnType<typeof setTimeout>;
  draftTimer?: ReturnType<typeof setTimeout>;
  /** Bumped whenever a different note is requested for viewing. */
  viewToken: number;
}

export class NotesController {
  private pad: Pad | null = null;
  private readonly t: NotesTimings;
  private readonly now: () => Date;
  private readonly view: NotesView;
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: NotesDeps) {
    this.t = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.now = deps.now ?? (() => new Date());
    this.view = deps.view;
  }

  // ------------------------------------------------------------ inputs

  /** The problem on screen changed (null = not on a problem page). */
  setProblem(slug: string | null): void {
    if ((this.pad?.slug ?? null) === slug) return;
    if (this.pad) this.flush();
    this.pad = slug ? this.newPad(slug) : null;
    if (!this.view.isOpen()) return;
    if (!this.pad) this.view.close();
    else this.ensureLoaded(this.pad);
  }

  /** Opens or closes the panel (toolbar button, keyboard shortcut). */
  toggle(): void {
    if (this.view.isOpen()) {
      this.view.close();
      this.onClosed();
      return;
    }
    const pad = this.pad;
    if (!pad) return;
    this.view.open();
    if (!pad.loaded) {
      this.ensureLoaded(pad);
    } else if (!pad.configured) {
      // A repo may have been connected since: look again, keeping the drawing.
      this.enqueue(pad, async () => {
        if (pad.dirty) await this.writeDraft(pad);
        pad.loaded = false;
        await this.load(pad);
      });
    } else {
      this.enqueue(pad, async () => this.rollOverIfStale(pad));
    }
  }

  /** The panel was closed by the user. */
  onClosed(): void {
    this.flush();
  }

  /** The user changed the drawing. */
  onDocChange(doc: Doc): void {
    const pad = this.pad;
    if (!pad || !pad.loaded || doc === pad.doc) return;
    const now = this.now();
    pad.doc = doc;
    pad.startedAt ??= now.toISOString();
    pad.lastActivity = now.getTime();
    pad.dirty = true;

    clearTimeout(pad.draftTimer);
    pad.draftTimer = setTimeout(() => {
      pad.draftTimer = undefined;
      if (pad.dirty) this.track(this.writeDraft(pad));
    }, this.t.draftMs);

    if (pad.configured) {
      clearTimeout(pad.saveTimer);
      pad.saveTimer = setTimeout(() => {
        pad.saveTimer = undefined;
        this.enqueue(pad, () => this.save(pad));
      }, this.t.saveMs);
      this.setStatus(pad, { text: 'Unsaved changes', tone: '' });
    }
  }

  /** The tab was hidden or the page is going away: save now. */
  onHidden(): void {
    this.flush();
  }

  /** History menu: show an earlier note (null = back to the current one). */
  pickHistory(name: string | null): void {
    const pad = this.pad;
    if (!pad || !pad.loaded) return;
    const token = ++pad.viewToken;
    if (name === null || name === pad.name) {
      this.view.showCurrent();
      return;
    }
    if (!pad.meta) return;
    const meta = pad.meta;
    this.track(
      (async () => {
        const res = await this.deps.get({ slug: pad.slug, meta, name });
        if (this.pad !== pad || pad.viewToken !== token) return;
        const note = res.ok && res.file ? fromSvg(res.file.content) : null;
        if (!note) {
          this.view.showCurrent();
          this.setStatus(pad, {
            text: res.ok ? 'That file is not a note made by this extension.' : `Could not open the note: ${res.error}`,
            tone: 'bad',
          });
          return;
        }
        this.view.showPast(note.doc, noteLabel(name) ?? name);
      })().catch(() => undefined),
    );
  }

  /** Resolves once all work started so far has finished. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  // ------------------------------------------------------------ plumbing

  private newPad(slug: string): Pad {
    return {
      slug,
      meta: null,
      loaded: false,
      configured: false,
      gapMinutes: 60,
      files: [],
      doc: EMPTY_DOC,
      name: null,
      sha: null,
      startedAt: null,
      lastActivity: 0,
      dirty: false,
      queue: Promise.resolve(),
      viewToken: 0,
    };
  }

  private track(work: Promise<void>): void {
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work));
  }

  private enqueue(pad: Pad, job: () => Promise<void>): void {
    pad.queue = pad.queue.then(job).catch((e: unknown) => {
      this.setStatus(pad, {
        text: /context invalidated/i.test(String(e))
          ? 'The extension was updated. Reload this page to keep saving notes.'
          : `Notes error: ${e instanceof Error ? e.message : String(e)}`,
        tone: 'bad',
      });
    });
    this.track(pad.queue);
  }

  private setStatus(pad: Pad, status: NotesStatus): void {
    if (this.pad === pad) this.view.setStatus(status);
  }

  private label(pad: Pad): string {
    return pad.name ? (noteLabel(pad.name) ?? pad.name) : NEW_NOTE;
  }

  private showHistory(pad: Pad): void {
    if (this.pad !== pad) return;
    this.view.setHistory(
      pad.files
        .filter((f) => f.name !== pad.name)
        .map((f) => ({ name: f.name, label: noteLabel(f.name) ?? f.name })),
      this.label(pad),
    );
  }

  private showCurrent(pad: Pad): void {
    if (this.pad !== pad) return;
    this.view.loadCurrent(pad.doc, this.label(pad));
    this.showHistory(pad);
  }

  /** Saves pending work right away (panel closed, tab hidden, problem left). */
  private flush(): void {
    const pad = this.pad;
    if (!pad || !pad.loaded) return;
    clearTimeout(pad.saveTimer);
    pad.saveTimer = undefined;
    clearTimeout(pad.draftTimer);
    pad.draftTimer = undefined;
    if (!pad.dirty) return;
    // The local copy goes first: it survives even if the page dies mid-save.
    this.track(this.writeDraft(pad));
    if (pad.configured) this.enqueue(pad, () => this.save(pad));
  }

  // ------------------------------------------------------------ local draft

  private async writeDraft(pad: Pad): Promise<void> {
    try {
      const value = JSON.stringify({
        v: 1,
        name: pad.name,
        sha: pad.sha,
        startedAt: pad.startedAt ?? this.now().toISOString(),
        savedAt: new Date(pad.lastActivity || this.now().getTime()).toISOString(),
        shapes: pad.doc.shapes,
      });
      await this.deps.draft({ slug: pad.slug, op: 'set', value });
    } catch {
      // Best effort; the repo copy is what matters.
    }
  }

  private async clearDraft(pad: Pad): Promise<void> {
    try {
      await this.deps.draft({ slug: pad.slug, op: 'set', value: null });
    } catch {
      // ignore
    }
  }

  private async readDraft(pad: Pad): Promise<Draft | null> {
    try {
      const res = await this.deps.draft({ slug: pad.slug, op: 'get' });
      if (!res.ok || !res.value) return null;
      const d = JSON.parse(res.value) as Record<string, unknown>;
      const shapes = validateShapes(d.shapes);
      if (d.v !== 1 || !shapes || typeof d.startedAt !== 'string' || typeof d.savedAt !== 'string') return null;
      if (Number.isNaN(Date.parse(d.startedAt)) || Number.isNaN(Date.parse(d.savedAt))) return null;
      return {
        name: typeof d.name === 'string' && noteLabel(d.name) !== null ? d.name : null,
        sha: typeof d.sha === 'string' ? d.sha : null,
        startedAt: d.startedAt,
        savedAt: d.savedAt,
        doc: { shapes },
      };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ loading

  private ensureLoaded(pad: Pad): void {
    if (pad.loaded) {
      this.showCurrent(pad);
      return;
    }
    this.enqueue(pad, () => this.load(pad));
  }

  /** First open for a problem: find out which session the user is in. */
  private async load(pad: Pad): Promise<void> {
    if (pad.loaded) {
      this.showCurrent(pad);
      return;
    }
    if (this.pad === pad) this.view.setLoading(true);
    try {
      pad.meta ??= await this.deps.getMeta(pad.slug);
      if (!pad.meta) {
        this.setStatus(pad, { text: 'Could not read the problem details from LeetCode.', tone: 'bad' });
        return;
      }
      const list = await this.deps.list({ slug: pad.slug, meta: pad.meta });
      if (!list.ok) {
        this.setStatus(pad, { text: `Could not load notes: ${list.error}`, tone: 'bad' });
        return;
      }
      const draft = await this.readDraft(pad);
      const now = this.now();

      if (!list.configured) {
        // No repo: the browser copy is the only copy, so always keep it going.
        pad.configured = false;
        if (draft) this.adopt(pad, { ...draft, name: null, sha: null }, false);
        pad.loaded = true;
        this.showCurrent(pad);
        this.setStatus(pad, {
          text: 'Not saved to git. Connect a repo in Settings.',
          tone: 'warn',
          opensSettings: true,
        });
        return;
      }

      pad.configured = true;
      pad.gapMinutes = list.gapMinutes;
      pad.files = sortNotes(list.files);

      if (draft) {
        if (shouldContinue(draft.savedAt, now, pad.gapMinutes)) {
          // Unsaved work from a moment ago: carry on with it.
          this.adopt(pad, draft, true);
          pad.loaded = true;
          this.showCurrent(pad);
          await this.save(pad);
          return;
        }
        // Unsaved work from an earlier session: file it, then start fresh.
        const filed = await this.putNote(pad, draft, draft.savedAt);
        if (filed.ok) {
          await this.clearDraft(pad);
        } else {
          // Could not file it; keep working on it rather than lose it.
          this.adopt(pad, draft, true);
          pad.loaded = true;
          this.showCurrent(pad);
          this.setStatus(pad, { text: `Not saved: ${filed.error}`, tone: 'bad' });
          return;
        }
      }

      const latest = pad.files[0];
      if (latest) {
        const got = await this.deps.get({ slug: pad.slug, meta: pad.meta, name: latest.name });
        const note = got.ok && got.file ? fromSvg(got.file.content) : null;
        if (note && got.ok && got.file && shouldContinue(note.meta.savedAt, now, pad.gapMinutes)) {
          this.adopt(
            pad,
            { name: latest.name, sha: got.file.sha, startedAt: note.meta.startedAt, savedAt: note.meta.savedAt, doc: note.doc },
            false,
          );
        }
      }
      pad.loaded = true;
      this.showCurrent(pad);
      this.setStatus(pad, this.restingStatus(pad));
    } finally {
      if (this.pad === pad) this.view.setLoading(false);
    }
  }

  private adopt(pad: Pad, from: Draft, dirty: boolean): void {
    pad.doc = from.doc;
    pad.name = from.name;
    pad.sha = from.sha;
    pad.startedAt = from.startedAt;
    pad.lastActivity = Date.parse(from.savedAt);
    pad.dirty = dirty;
  }

  private restingStatus(pad: Pad): NotesStatus {
    return pad.name
      ? { text: 'Saved to git', tone: 'ok' }
      : { text: 'New note. It is saved once you draw.', tone: '' };
  }

  /** Reopening the panel after a long break starts a new blank session. */
  private async rollOverIfStale(pad: Pad): Promise<void> {
    if (this.pad !== pad || !pad.loaded) return;
    const hasSession = pad.name !== null || pad.doc.shapes.length > 0;
    const stale =
      pad.configured &&
      hasSession &&
      !pad.dirty &&
      !shouldContinue(new Date(pad.lastActivity).toISOString(), this.now(), pad.gapMinutes);
    if (stale) {
      pad.doc = EMPTY_DOC;
      pad.name = null;
      pad.sha = null;
      pad.startedAt = null;
      this.showCurrent(pad);
      this.setStatus(pad, this.restingStatus(pad));
    }
  }

  // ------------------------------------------------------------ saving

  private async save(pad: Pad): Promise<void> {
    if (!pad.dirty || !pad.configured) return;
    if (pad.doc.shapes.length === 0 && pad.name === null) {
      // Drawn and erased again before anything was saved: no file needed.
      pad.dirty = false;
      pad.startedAt = null;
      await this.clearDraft(pad);
      this.setStatus(pad, this.restingStatus(pad));
      return;
    }
    const doc = pad.doc;
    const savedAt = this.now().toISOString();
    this.setStatus(pad, { text: 'Saving…', tone: '' });
    const res = await this.putNote(
      pad,
      { name: pad.name, sha: pad.sha, startedAt: pad.startedAt ?? savedAt, savedAt, doc },
      savedAt,
    );
    if (!res.ok) {
      this.setStatus(pad, { text: `Not saved: ${res.error}`, tone: 'bad' });
      return;
    }
    const renamed = pad.name !== res.name;
    pad.name = res.name;
    pad.sha = res.sha;
    pad.lastActivity = Date.parse(savedAt);
    // The label and the history list depend on the file name.
    if (renamed) this.showHistory(pad);
    if (pad.doc === doc) {
      pad.dirty = false;
      await this.clearDraft(pad);
      const time = new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.setStatus(pad, { text: `Saved to git ${time}`, tone: 'ok' });
    } else if (pad.saveTimer === undefined) {
      // More was drawn while saving and no timer is pending (e.g. on close).
      await this.save(pad);
    }
  }

  /**
   * Writes one note file. If the file was changed from elsewhere, or the name
   * is taken, the note goes into a new file instead: nothing is overwritten.
   */
  private async putNote(
    pad: Pad,
    note: Draft,
    savedAt: string,
  ): Promise<{ ok: true; name: string; sha: string } | { ok: false; error: string }> {
    if (!pad.meta) return { ok: false, error: 'Problem details are missing.' };
    const meta = pad.meta;
    const content = toSvg(note.doc, { startedAt: note.startedAt, savedAt });
    const taken = new Set(pad.files.map((f) => f.name));
    let name = note.name ?? freeNoteFileName(new Date(note.startedAt), taken);
    let sha = note.sha;

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.deps.put({ slug: pad.slug, meta, name, content, expectedSha: sha });
      if (res.ok) {
        const others = pad.files.filter((f) => f.name !== name);
        pad.files = sortNotes([...others, { name, sha: res.sha }]);
        return { ok: true, name, sha: res.sha };
      }
      if (!res.conflict) return { ok: false, error: res.error };
      // Refresh the list so the replacement name is really free.
      const list = await this.deps.list({ slug: pad.slug, meta });
      if (list.ok && list.configured) pad.files = sortNotes(list.files);
      const nowTaken = new Set([...pad.files.map((f) => f.name), name]);
      name = freeNoteFileName(note.name ? this.now() : new Date(note.startedAt), nowTaken);
      sha = null;
    }
    return { ok: false, error: 'The notes folder keeps changing. Try again in a moment.' };
  }
}
