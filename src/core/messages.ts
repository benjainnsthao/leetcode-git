// Message shapes exchanged between the three worlds:
//   page bridge (MAIN world)  <-- window.postMessage -->  content script
//   content script / popup / options  <-- chrome.runtime -->  background

import type { CommitKind, SubmissionStats } from './paths';
import type { Settings } from './settings';

// ---------------------------------------------------------------- page <-> content

export const PAGE_TAG = 'lcgit-page';
export const EXT_TAG = 'lcgit-ext';

/** What the code box currently holds. */
export interface EditorState {
  slug: string;
  lang: string;
  code: string;
  /**
   * True when the latest change was made by the page itself (language switch,
   * "reset to default", restoring saved code) rather than typed by the user.
   */
  flush: boolean;
}

export interface AcceptedSubmission {
  slug: string;
  lang: string;
  code: string;
  runtime?: string;
  memory?: string;
}

export type PageMessage =
  | { tag: typeof PAGE_TAG; type: 'state'; state: EditorState | null }
  | { tag: typeof PAGE_TAG; type: 'accepted'; submission: AcceptedSubmission }
  | { tag: typeof PAGE_TAG; type: 'setResult'; id: number; ok: boolean };

export type ExtMessage =
  | { tag: typeof EXT_TAG; type: 'hello' }
  | { tag: typeof EXT_TAG; type: 'set'; id: number; slug: string; lang: string; code: string };

// ---------------------------------------------------------------- * <-> background

export interface MetaInput {
  frontendId: string;
  title: string;
}

export interface PullRequest {
  type: 'pull';
  slug: string;
  lang: string;
  meta: MetaInput;
}

export interface PushRequest {
  type: 'push';
  slug: string;
  lang: string;
  meta: MetaInput;
  content: string;
  kind: CommitKind;
  stats?: SubmissionStats;
  /** Blob sha the caller believes is in the repo; null = file should not exist. */
  expectedSha: string | null;
  /** Look up the current sha first and overwrite whatever is there. */
  force?: boolean;
}

export interface MarkBaseRequest {
  type: 'markBase';
  slug: string;
  lang: string;
  content: string;
}

export interface TestRequest {
  type: 'test';
  settings: Settings;
}

export interface OpenOptionsRequest {
  type: 'openOptions';
}

export type BgRequest = PullRequest | PushRequest | MarkBaseRequest | TestRequest | OpenOptionsRequest;

export interface RemoteFile {
  content: string;
  sha: string;
}

export type PullResponse =
  | { ok: true; configured: false }
  | {
      ok: true;
      configured: true;
      remote: RemoteFile | null;
      /** Hash of the last version synced on this machine. */
      baseHash: string | null;
      syncDrafts: boolean;
      gitAlwaysWins: boolean;
      /** Link to the file on github.com. */
      fileUrl: string;
    }
  | { ok: false; error: string };

export type PushResponse =
  | { ok: true; sha: string }
  | { ok: false; conflict: true }
  | { ok: false; conflict?: false; error: string };

export type TestResponse =
  | { ok: true; fullName: string; private: boolean; canPush: boolean; defaultBranch: string }
  | { ok: false; error: string };

export type SimpleResponse = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------- popup <-> content

export type StatusKind =
  | 'hidden'
  | 'checking'
  | 'unconfigured'
  | 'idle'
  | 'synced'
  | 'saving'
  | 'saved'
  | 'loaded'
  | 'conflict'
  | 'error';

export interface Status {
  kind: StatusKind;
  /** Short human text for the pill. */
  text: string;
  /** Longer explanation (tooltip / popup). */
  detail?: string;
  fileUrl?: string;
}

export type PopupRequest = { type: 'popup/status' } | { type: 'popup/syncNow' };

export interface PopupStatusResponse {
  active: boolean;
  slug?: string;
  lang?: string;
  status?: Status;
}
