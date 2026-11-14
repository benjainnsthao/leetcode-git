// The sync decision. Pure: it only compares version identities (hashes).

export type SyncAction =
  /** Nothing to do right now. */
  | 'none'
  /** Code box and repo already match. */
  | 'in-sync'
  /** Put the repo version into the code box. */
  | 'load-remote'
  /** Commit the code box to the repo. */
  | 'push-local'
  /** Both sides changed; the user has to choose. */
  | 'conflict';

export interface DecideInput {
  /** Identity of what is in the code box. */
  local: string;
  /** True when the code box is empty. */
  localBlank?: boolean;
  /** Identity of the file in the repo, or null if there is no file. */
  remote: string | null;
  /** Identity of the last version synced on this machine, if any. */
  base: string | null;
  /** Identity of LeetCode's default code for this language, if known. */
  template: string | null;
  /** The "Git always wins" setting. */
  gitAlwaysWins: boolean;
  /**
   * 'open'       - a problem was opened, the tab regained focus, or the
   *                language was switched.
   * 'page-reset' - LeetCode itself replaced the code box contents while the
   *                problem was already open (e.g. "reset to default code").
   *                Never pushed automatically, since the user did not type it.
   */
  trigger: 'open' | 'page-reset';
}

export function decide(i: DecideInput): SyncAction {
  if (i.remote === null) return 'none';
  if (i.local === i.remote) return 'in-sync';

  const isTemplate = i.localBlank === true || (i.template !== null && i.local === i.template);
  const isBase = i.base !== null && i.local === i.base;
  const bothChanged: SyncAction = i.gitAlwaysWins ? 'load-remote' : 'conflict';

  if (i.trigger === 'page-reset') {
    // The user asked LeetCode for a clean slate; do not undo that.
    if (isTemplate) return 'none';
    if (isBase) return 'load-remote';
    return bothChanged;
  }

  // Code box untouched since the last sync (or never touched): repo is newer.
  if (isTemplate || isBase) return 'load-remote';
  // Repo untouched since the last sync: code box is newer.
  if (i.base !== null && i.remote === i.base) return 'push-local';
  return bothChanged;
}
