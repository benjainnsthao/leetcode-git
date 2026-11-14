// The sync engine. Lives in the content script because it owns timers that
// must survive as long as the page does. It knows nothing about chrome APIs or
// the DOM: everything it needs is injected, which keeps it unit-testable.

import { decide, type SyncAction } from '../core/decide';
import type {
  AcceptedSubmission,
  EditorState,
  MarkBaseRequest,
  PopupStatusResponse,
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  Status,
} from '../core/messages';
import type { SubmissionStats } from '../core/paths';
import { hashCode, normalizeCode } from '../core/text';

export interface QuestionMeta {
  frontendId: string;
  title: string;
  /** LeetCode's default code per language slug. */
  templates: Record<string, string>;
}

export interface ConflictHandlers {
  useGit(): void;
  keepMine(): void;
}

export interface ControllerDeps {
  pull(req: Omit<PullRequest, 'type'>): Promise<PullResponse>;
  push(req: Omit<PushRequest, 'type'>): Promise<PushResponse>;
  markBase(req: Omit<MarkBaseRequest, 'type'>): Promise<unknown>;
  /** Replaces the code box contents. Resolves false if it could not. */
  setCode(slug: string, lang: string, code: string): Promise<boolean>;
  /** Problem number, title and default code. Null if LeetCode did not answer. */
  getMeta(slug: string): Promise<QuestionMeta | null>;
  setStatus(status: Status): void;
  /** Shows the "both sides changed" prompt, or hides it when passed null. */
  showConflict(handlers: ConflictHandlers | null): void;
  timings?: Partial<Timings>;
  now?: () => number;
}

export interface Timings {
  /** Quiet time after the code box first fills before the first sync. */
  settleMs: number;
  /** Quiet time after typing before a draft is committed. */
  draftMs: number;
  /** Minimum gap between re-checks triggered by the tab regaining focus. */
  focusMinMs: number;
}

const DEFAULT_TIMINGS: Timings = { settleMs: 1500, draftMs: 10_000, focusMinMs: 15_000 };

type Trigger = 'open' | 'page-reset' | 'focus' | 'manual' | 'push-conflict';

/** Everything known about one problem + language while it is on screen. */
interface View {
  key: string;
  slug: string;
  lang: string;
  code: string;
  /** First sync has completed; edits may now be pushed. */
  ready: boolean;
  configured: boolean;
  syncDrafts: boolean;
  gitAlwaysWins: boolean;
  meta: QuestionMeta | null;
  templateHash: string | null;
  remoteSha: string | null;
  remoteHash: string | null;
  remoteContent: string | null;
  baseHash: string | null;
  fileUrl?: string;
  conflict: boolean;
  /** An accepted submission that could not be committed yet (conflict). */
  heldAccepted: { hash: string; stats: SubmissionStats } | null;
  /** Serialises all network work for this view. */
  queue: Promise<void>;
  lastCheck: number;
}

export class SyncController {
  private view: View | null = null;
  private status: Status = { kind: 'hidden', text: '' };
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly inflight = new Set<Promise<void>>();
  private readonly t: Timings;
  private readonly now: () => number;

  constructor(private readonly deps: ControllerDeps) {
    this.t = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.now = deps.now ?? (() => Date.now());
  }

  // ------------------------------------------------------------ inputs

  /** Called whenever the page bridge reports the code box (null = no editor). */
  onEditorState(state: EditorState | null): void {
    if (!state) {
      this.leave();
      return;
    }
    const key = `${state.slug}:${state.lang}`;
    const view = this.view;
    if (!view || view.key !== key) {
      this.leave();
      this.enter(state, key);
      return;
    }
    if (state.code === view.code) return;
    view.code = state.code;
    if (!view.ready) {
      this.armSettle(view); // still loading: wait for it to go quiet again
    } else if (state.flush) {
      this.enqueue(view, () => this.reconcile(view, 'page-reset'));
    } else {
      this.armDraft(view);
    }
  }

  /** Called when LeetCode reports a submission as Accepted. */
  onAccepted(sub: AcceptedSubmission): void {
    const stats: SubmissionStats = { runtime: sub.runtime, memory: sub.memory };
    const view = this.view;
    if (view && view.ready && view.key === `${sub.slug}:${sub.lang}`) {
      this.cancelDraft();
      this.enqueue(view, async () => void (await this.push(view, { accepted: { code: sub.code, stats } })));
      return;
    }
    // The user already moved to another problem or language: commit directly.
    this.track(this.pushDetached(sub, stats));
  }

  onVisibilityChange(visible: boolean): void {
    const view = this.view;
    if (!view) return;
    if (!visible) {
      this.flushDraft();
    } else if (view.ready && this.now() - view.lastCheck >= this.t.focusMinMs) {
      this.enqueue(view, () => this.reconcile(view, 'focus'));
    }
  }

  /** "Sync now" from the popup: commit pending work and re-check the repo. */
  async syncNow(): Promise<void> {
    const view = this.view;
    if (!view) return;
    this.cancelDraft();
    clearTimeout(this.settleTimer);
    await this.enqueue(view, () => this.reconcile(view, 'manual'));
  }

  describe(): PopupStatusResponse {
    const view = this.view;
    if (!view) return { active: false };
    return { active: true, slug: view.slug, lang: view.lang, status: this.status };
  }

  /** Re-opens the conflict prompt after it was dismissed. */
  reopenConflict(): void {
    const view = this.view;
    if (view?.conflict) this.deps.showConflict(this.conflictHandlers(view));
  }

  // ------------------------------------------------------------ view lifecycle

  private enter(state: EditorState, key: string): void {
    const view: View = {
      key,
      slug: state.slug,
      lang: state.lang,
      code: state.code,
      ready: false,
      configured: false,
      syncDrafts: false,
      gitAlwaysWins: false,
      meta: null,
      templateHash: null,
      remoteSha: null,
      remoteHash: null,
      remoteContent: null,
      baseHash: null,
      conflict: false,
      heldAccepted: null,
      queue: Promise.resolve(),
      lastCheck: 0,
    };
    this.view = view;
    this.setStatus(view, { kind: 'checking', text: 'Checking git…' });
    this.armSettle(view);
  }

  private leave(): void {
    if (!this.view) return;
    this.flushDraft();
    clearTimeout(this.settleTimer);
    this.view = null;
    this.deps.showConflict(null);
    this.status = { kind: 'hidden', text: '' };
    this.deps.setStatus(this.status);
  }

  private armSettle(view: View): void {
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (this.view === view) this.enqueue(view, () => this.reconcile(view, 'open'));
    }, this.t.settleMs);
  }

  private armDraft(view: View): void {
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined;
      this.enqueue(view, async () => void (await this.push(view, {})));
    }, this.t.draftMs);
  }

  private cancelDraft(): void {
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
  }

  /** Commits a pending draft right away (tab hidden, navigating away). */
  private flushDraft(): void {
    const view = this.view;
    if (!view || this.draftTimer === undefined) return;
    this.cancelDraft();
    this.enqueue(view, async () => void (await this.push(view, {})));
  }

  /** Resolves once all sync work started so far has finished. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track(work: Promise<void>): void {
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work));
  }

  private enqueue(view: View, job: () => Promise<void>): Promise<void> {
    view.queue = view.queue.then(job).catch((e: unknown) => {
      this.setStatus(view, {
        kind: 'error',
        text: 'Git sync error',
        detail: /context invalidated/i.test(String(e))
          ? 'The extension was updated or reloaded. Refresh this page to resume syncing.'
          : e instanceof Error
            ? e.message
            : String(e),
      });
    });
    this.track(view.queue);
    return view.queue;
  }

  private setStatus(view: View, status: Status): void {
    if (this.view !== view) return; // stale: that problem is no longer on screen
    this.status = { fileUrl: view.fileUrl, ...status };
    this.deps.setStatus(this.status);
  }

  // ------------------------------------------------------------ reconcile

  /** Compares code box, repo and last-synced version, then acts on the result. */
  private async reconcile(view: View, trigger: Trigger): Promise<void> {
    if (this.view !== view) return;
    view.lastCheck = this.now();
    if (!view.ready) this.setStatus(view, { kind: 'checking', text: 'Checking git…' });

    if (!view.meta) {
      view.meta = await this.deps.getMeta(view.slug);
      if (!view.meta) {
        this.setStatus(view, {
          kind: 'error',
          text: 'Git sync error',
          detail: 'Could not read the problem details from LeetCode. Reload the page to retry.',
        });
        return;
      }
      const template = view.meta.templates[view.lang];
      view.templateHash = template !== undefined ? await hashCode(template) : null;
    }

    const res = await this.deps.pull({ slug: view.slug, lang: view.lang, meta: view.meta });
    if (!res.ok) {
      this.setStatus(view, { kind: 'error', text: 'Git sync error', detail: res.error });
      return;
    }
    if (!res.configured) {
      view.configured = false;
      view.ready = true;
      this.setStatus(view, {
        kind: 'unconfigured',
        text: 'Set up git sync',
        detail: 'Click to connect your solutions repo.',
      });
      return;
    }

    view.configured = true;
    view.syncDrafts = res.syncDrafts;
    view.gitAlwaysWins = res.gitAlwaysWins;
    view.fileUrl = res.fileUrl;
    view.remoteSha = res.remote?.sha ?? null;
    view.remoteContent = res.remote?.content ?? null;
    view.remoteHash = res.remote ? await hashCode(res.remote.content) : null;
    view.baseHash = res.baseHash;

    const codeAtDecision = view.code;
    const localHash = await hashCode(codeAtDecision);
    const action = decide({
      local: localHash,
      localBlank: normalizeCode(codeAtDecision) === '',
      remote: view.remoteHash,
      base: view.baseHash,
      template: view.templateHash,
      gitAlwaysWins: view.gitAlwaysWins,
      trigger: trigger === 'page-reset' ? 'page-reset' : 'open',
    });
    view.ready = true;
    await this.apply(view, action, trigger, localHash);
  }

  private async apply(view: View, action: SyncAction, trigger: Trigger, localHash: string): Promise<void> {
    if (action !== 'conflict') this.clearConflict(view);

    switch (action) {
      case 'none': {
        if (view.remoteHash === null) {
          if (trigger === 'manual' && (await this.push(view, { manual: true })) !== 'skipped') return;
          this.setStatus(view, {
            kind: 'idle',
            text: 'Not in git yet',
            detail: view.syncDrafts
              ? 'This problem will be saved to your repo once you start typing.'
              : 'This problem will be saved to your repo when a submission is accepted.',
          });
        } else {
          this.setStatus(view, {
            kind: 'idle',
            text: 'Git copy kept',
            detail: 'The code box was reset. Your repo still has your last saved version.',
          });
        }
        return;
      }

      case 'in-sync': {
        if (view.baseHash !== localHash) {
          view.baseHash = localHash;
          await this.deps.markBase({ slug: view.slug, lang: view.lang, content: view.code });
        }
        this.setStatus(view, { kind: 'synced', text: 'In sync with git' });
        return;
      }

      case 'load-remote':
        await this.loadRemote(view);
        return;

      case 'push-local': {
        if (!view.syncDrafts && trigger !== 'manual') {
          this.setStatus(view, {
            kind: 'idle',
            text: 'Not saved to git',
            detail: 'Draft sync is off. This code will be committed when a submission is accepted.',
          });
          return;
        }
        await this.push(view, { manual: trigger === 'manual', noRetry: trigger === 'push-conflict' });
        return;
      }

      case 'conflict': {
        view.conflict = true;
        this.setStatus(view, {
          kind: 'conflict',
          text: 'Differs from git',
          detail: 'The code box and your repo both changed. Choose which version to keep.',
        });
        if (this.view === view) this.deps.showConflict(this.conflictHandlers(view));
        return;
      }
    }
  }

  private conflictHandlers(view: View): ConflictHandlers {
    return {
      useGit: () => {
        this.enqueue(view, async () => {
          if (!view.conflict) return;
          this.clearConflict(view);
          await this.loadRemote(view);
        });
      },
      keepMine: () => {
        this.enqueue(view, async () => {
          if (!view.conflict) return;
          this.clearConflict(view);
          await this.push(view, { manual: true });
        });
      },
    };
  }

  private clearConflict(view: View): void {
    if (!view.conflict) return;
    view.conflict = false;
    if (this.view === view) this.deps.showConflict(null);
  }

  private async loadRemote(view: View): Promise<void> {
    if (this.view !== view || view.remoteContent === null) return;
    const text = normalizeCode(view.remoteContent);
    const ok = await this.deps.setCode(view.slug, view.lang, text);
    if (!ok) {
      this.setStatus(view, {
        kind: 'error',
        text: 'Git sync error',
        detail: 'Could not write to the code box. Reload the page to retry.',
      });
      return;
    }
    view.code = text;
    view.heldAccepted = null;
    view.baseHash = view.remoteHash;
    await this.deps.markBase({ slug: view.slug, lang: view.lang, content: text });
    this.setStatus(view, { kind: 'loaded', text: 'Loaded from git' });
  }

  // ------------------------------------------------------------ push

  private async push(
    view: View,
    opts: { manual?: boolean; noRetry?: boolean; accepted?: { code: string; stats: SubmissionStats } },
  ): Promise<'pushed' | 'skipped' | 'failed'> {
    if (!view.configured || !view.meta) return 'skipped';

    const content = opts.accepted?.code ?? view.code;
    const hash = await hashCode(content);

    if (view.conflict) {
      // Nothing is written while the user has not chosen a side, but remember
      // an accepted result so "Keep mine" can record it as such.
      if (opts.accepted) view.heldAccepted = { hash, stats: opts.accepted.stats };
      return 'skipped';
    }

    let kind: 'draft' | 'accepted' = 'draft';
    let stats: SubmissionStats | undefined;
    if (opts.accepted) {
      kind = 'accepted';
      stats = opts.accepted.stats;
    } else if (view.heldAccepted?.hash === hash) {
      kind = 'accepted';
      stats = view.heldAccepted.stats;
    } else {
      if (!view.syncDrafts && !opts.manual) return 'skipped';
      if (hash === view.remoteHash) return 'skipped'; // already in the repo
      const untouched = normalizeCode(content) === '' || hash === view.templateHash;
      if (untouched) return 'skipped'; // never commit LeetCode's starter code
    }

    this.setStatus(view, { kind: 'saving', text: 'Saving to git…' });
    const res = await this.deps.push({
      slug: view.slug,
      lang: view.lang,
      meta: view.meta,
      content,
      kind,
      stats,
      expectedSha: view.remoteSha,
    });

    if (res.ok) {
      view.remoteSha = res.sha;
      view.remoteHash = hash;
      view.remoteContent = content;
      view.baseHash = hash;
      if (kind === 'accepted') view.heldAccepted = null;
      this.setStatus(view, {
        kind: 'saved',
        text: kind === 'accepted' ? 'Accepted — saved to git' : 'Saved to git',
      });
      return 'pushed';
    }
    if (res.conflict && !opts.noRetry) {
      // The repo moved underneath us. Keep the accepted result for later and
      // let the normal rules decide what happens next.
      if (opts.accepted) view.heldAccepted = { hash, stats: opts.accepted.stats };
      await this.reconcile(view, 'push-conflict');
      return 'failed';
    }
    this.setStatus(view, {
      kind: 'error',
      text: 'Git sync error',
      detail: res.conflict
        ? 'GitHub refused the commit. The branch may be protected or changing too quickly.'
        : res.error,
    });
    return 'failed';
  }

  /** Commits an accepted submission for a problem that is no longer on screen. */
  private async pushDetached(sub: AcceptedSubmission, stats: SubmissionStats): Promise<void> {
    try {
      const meta = await this.deps.getMeta(sub.slug);
      if (!meta) return;
      await this.deps.push({
        slug: sub.slug,
        lang: sub.lang,
        meta,
        content: sub.code,
        kind: 'accepted',
        stats,
        expectedSha: null,
        force: true,
      });
    } catch {
      // Best effort: there is no view to report the failure on.
    }
  }
}
