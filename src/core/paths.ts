// Where a solution lives in the repo and how its commits are worded.

export interface ProblemMeta {
  /** LeetCode's URL slug, e.g. "two-sum". */
  slug: string;
  /** The number shown in the UI, e.g. "1". */
  frontendId: string;
  title: string;
}

export interface SubmissionStats {
  runtime?: string;
  memory?: string;
}

export type CommitKind = 'draft' | 'accepted';

/** File name per LeetCode language slug. One file per language per problem. */
const FILE_NAMES: Record<string, string> = {
  cpp: 'solution.cpp',
  java: 'solution.java',
  python3: 'solution.py',
  python: 'solution.py2.py',
  pythondata: 'solution.pandas.py',
  c: 'solution.c',
  csharp: 'solution.cs',
  javascript: 'solution.js',
  typescript: 'solution.ts',
  php: 'solution.php',
  swift: 'solution.swift',
  kotlin: 'solution.kt',
  dart: 'solution.dart',
  golang: 'solution.go',
  ruby: 'solution.rb',
  scala: 'solution.scala',
  rust: 'solution.rs',
  racket: 'solution.rkt',
  erlang: 'solution.erl',
  elixir: 'solution.ex',
  cangjie: 'solution.cj',
  bash: 'solution.sh',
  mysql: 'solution.sql',
  mssql: 'solution.mssql.sql',
  oraclesql: 'solution.oracle.sql',
  postgresql: 'solution.postgres.sql',
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,199}$/;
const LANG_RE = /^[a-z0-9]{1,30}$/;

export function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

export function isValidLang(lang: unknown): lang is string {
  return typeof lang === 'string' && LANG_RE.test(lang);
}

export function solutionFileName(lang: string): string {
  return FILE_NAMES[lang] ?? `solution.${lang}.txt`;
}

/** "1" + "two-sum" -> "0001-two-sum". Non-numeric ids are kept, sanitised. */
export function problemDir(meta: Pick<ProblemMeta, 'slug' | 'frontendId'>): string {
  const raw = meta.frontendId.trim();
  const id = /^\d+$/.test(raw)
    ? raw.padStart(4, '0')
    : raw.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return id ? `${id}-${meta.slug}` : meta.slug;
}

/** Cleans the "base folder" setting. Returns null if it is not a safe path. */
export function normalizeBaseDir(input: string): string | null {
  const parts = input.trim().replace(/\\/g, '/').split('/').filter((p) => p !== '');
  for (const p of parts) {
    if (p === '.' || p === '..' || p === '.git' || /[\u0000-\u001f<>:"|?*]/.test(p)) return null;
  }
  return parts.join('/');
}

export function solutionPath(baseDir: string, meta: ProblemMeta, lang: string): string {
  const tail = `${problemDir(meta)}/${solutionFileName(lang)}`;
  return baseDir ? `${baseDir}/${tail}` : tail;
}

/** Note files are named by their session's start time: 2026-11-14_09-35.svg */
export const NOTE_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:-(\d{1,2}))?\.svg$/;

export function isValidNoteName(name: unknown): name is string {
  return typeof name === 'string' && NOTE_FILE_RE.test(name);
}

/** Folder holding a problem's scratch-paper notes. */
export function notesDir(baseDir: string, meta: ProblemMeta): string {
  const tail = `${problemDir(meta)}/notes`;
  return baseDir ? `${baseDir}/${tail}` : tail;
}

export function notesCommitMessage(meta: ProblemMeta, noteName: string): string {
  const m = NOTE_FILE_RE.exec(noteName);
  const when = m ? ` (${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]})` : '';
  return `notes: ${meta.frontendId}. ${meta.title.replace(/\s+/g, ' ').trim()}${when}`;
}

export function commitMessage(
  kind: CommitKind,
  meta: ProblemMeta,
  lang: string,
  stats?: SubmissionStats,
): string {
  const title = meta.title.replace(/\s+/g, ' ').trim();
  const subject = `${kind}: ${meta.frontendId}. ${title} (${lang})`;
  if (kind !== 'accepted') return subject;
  const parts = [stats?.runtime, stats?.memory].filter((s): s is string => !!s && s.trim() !== '');
  return parts.length ? `${subject} - ${parts.map((p) => p.trim()).join(', ')}` : subject;
}
