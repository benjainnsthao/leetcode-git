// Sessions: one note file per working session, named by when it started.

import { NOTE_FILE_RE } from '../core/paths';

const pad = (v: number): string => String(v).padStart(2, '0');

/**
 * "2026-11-14_09-35.svg" for a session that began at that local time.
 * `attempt` > 1 adds "-2", "-3"… for the rare case the name is already taken.
 */
export function noteFileName(startedAt: Date, attempt = 1): string {
  const stamp =
    `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}` +
    `_${pad(startedAt.getHours())}-${pad(startedAt.getMinutes())}`;
  return `${stamp}${attempt > 1 ? `-${attempt}` : ''}.svg`;
}

/** A name not in `taken`, starting from the plain timestamp. */
export function freeNoteFileName(startedAt: Date, taken: ReadonlySet<string>): string {
  for (let attempt = 1; attempt < 100; attempt++) {
    const name = noteFileName(startedAt, attempt);
    if (!taken.has(name)) return name;
  }
  return noteFileName(startedAt, 99);
}

/** "2026-11-14_09-35-2.svg" -> "2026-11-14 09:35 (2)". Null if it is not a note file name. */
export function noteLabel(name: string): string | null {
  const m = NOTE_FILE_RE.exec(name);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}${m[6] ? ` (${m[6]})` : ''}`;
}

/** Sorts note file names newest first; names that are not notes are dropped. */
export function sortNotes<T extends { name: string }>(files: readonly T[]): T[] {
  const key = (name: string): [string, number] | null => {
    const m = NOTE_FILE_RE.exec(name);
    return m ? [`${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}`, Number(m[6] ?? 1)] : null;
  };
  return files
    .map((f) => ({ f, k: key(f.name) }))
    .filter((x): x is { f: T; k: [string, number] } => x.k !== null)
    .sort((a, b) => (a.k[0] === b.k[0] ? b.k[1] - a.k[1] : a.k[0] < b.k[0] ? 1 : -1))
    .map((x) => x.f);
}

/**
 * The session rule: keep working on a note if it was last saved less than
 * `gapMinutes` ago; otherwise the next drawing starts a new note.
 */
export function shouldContinue(savedAt: string | undefined, now: Date, gapMinutes: number): boolean {
  if (!savedAt) return false;
  const saved = Date.parse(savedAt);
  if (Number.isNaN(saved)) return false;
  const age = now.getTime() - saved;
  // A clock that jumped backwards should not strand the note forever.
  return age < gapMinutes * 60_000 && age > -24 * 60 * 60_000;
}
