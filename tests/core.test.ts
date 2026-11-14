import { describe, expect, it } from 'vitest';
import { decide, type DecideInput } from '../src/core/decide';
import {
  commitMessage,
  isValidLang,
  isValidSlug,
  normalizeBaseDir,
  problemDir,
  solutionFileName,
  solutionPath,
} from '../src/core/paths';
import { isConfigured, mergeSettings, parseRepo, DEFAULT_SETTINGS } from '../src/core/settings';
import { base64ToUtf8, hashCode, normalizeCode, toFileContent, utf8ToBase64 } from '../src/core/text';
import { parseQuestion } from '../src/content/leetcode';
import {
  parseCheckResponse,
  parseSubmitBody,
  submissionIdFromCheckUrl,
  submitSlugFromUrl,
} from '../src/page/submissions';

const base: DecideInput = {
  local: 'L',
  remote: 'R',
  base: null,
  template: 'T',
  gitAlwaysWins: false,
  trigger: 'open',
};

describe('decide', () => {
  it('does nothing when the repo has no file', () => {
    expect(decide({ ...base, remote: null })).toBe('none');
    expect(decide({ ...base, remote: null, base: 'B', gitAlwaysWins: true })).toBe('none');
  });

  it('reports in-sync when both sides match', () => {
    expect(decide({ ...base, local: 'X', remote: 'X' })).toBe('in-sync');
  });

  it('loads the repo version into an untouched code box', () => {
    expect(decide({ ...base, local: 'T' })).toBe('load-remote'); // default template
    expect(decide({ ...base, local: '', localBlank: true })).toBe('load-remote'); // empty
    expect(decide({ ...base, local: 'B', base: 'B' })).toBe('load-remote'); // same as last sync
  });

  it('pushes the code box when only it changed', () => {
    expect(decide({ ...base, base: 'R' })).toBe('push-local');
    expect(decide({ ...base, base: 'R', gitAlwaysWins: true })).toBe('push-local');
  });

  it('asks when both changed, unless git always wins', () => {
    expect(decide({ ...base, base: 'B' })).toBe('conflict');
    expect(decide({ ...base, base: 'B', gitAlwaysWins: true })).toBe('load-remote');
  });

  it('treats a first visit on a new computer with existing code as both-changed', () => {
    expect(decide({ ...base, base: null })).toBe('conflict');
    expect(decide({ ...base, base: null, gitAlwaysWins: true })).toBe('load-remote');
  });

  it('works without a known template', () => {
    expect(decide({ ...base, template: null, base: 'R' })).toBe('push-local');
    expect(decide({ ...base, template: null })).toBe('conflict');
  });

  describe('when the page itself replaced the code', () => {
    const reset: DecideInput = { ...base, trigger: 'page-reset' };

    it('leaves a reset-to-default alone', () => {
      expect(decide({ ...reset, local: 'T', base: 'R' })).toBe('none');
      expect(decide({ ...reset, local: 'T', base: 'R', gitAlwaysWins: true })).toBe('none');
    });

    it('never pushes code the user did not type', () => {
      expect(decide({ ...reset, base: 'R' })).toBe('conflict');
      expect(decide({ ...reset, base: 'R', gitAlwaysWins: true })).toBe('load-remote');
    });

    it('still loads a newer repo version over the last synced one', () => {
      expect(decide({ ...reset, local: 'B', base: 'B' })).toBe('load-remote');
    });

    it('is in sync when the page restored exactly the repo version', () => {
      expect(decide({ ...reset, local: 'R' })).toBe('in-sync');
    });
  });
});

describe('paths', () => {
  const meta = { slug: 'two-sum', frontendId: '1', title: 'Two Sum' };

  it('builds zero-padded problem folders', () => {
    expect(problemDir(meta)).toBe('0001-two-sum');
    expect(problemDir({ slug: 'x', frontendId: '12345' })).toBe('12345-x');
    expect(problemDir({ slug: 'x', frontendId: 'LCP 07' })).toBe('lcp-07-x');
    expect(problemDir({ slug: 'x', frontendId: ' ' })).toBe('x');
  });

  it('maps languages to distinct file names', () => {
    expect(solutionFileName('python3')).toBe('solution.py');
    expect(solutionFileName('python')).toBe('solution.py2.py');
    expect(solutionFileName('golang')).toBe('solution.go');
    expect(solutionFileName('mysql')).toBe('solution.sql');
    expect(solutionFileName('somethingnew')).toBe('solution.somethingnew.txt');
  });

  it('joins the base folder', () => {
    expect(solutionPath('problems', meta, 'cpp')).toBe('problems/0001-two-sum/solution.cpp');
    expect(solutionPath('', meta, 'cpp')).toBe('0001-two-sum/solution.cpp');
  });

  it('cleans or rejects the base folder setting', () => {
    expect(normalizeBaseDir(' /a//b/ ')).toBe('a/b');
    expect(normalizeBaseDir('')).toBe('');
    expect(normalizeBaseDir('a\\b')).toBe('a/b');
    expect(normalizeBaseDir('../etc')).toBeNull();
    expect(normalizeBaseDir('a/./b')).toBeNull();
    expect(normalizeBaseDir('.git/hooks')).toBeNull();
    expect(normalizeBaseDir('a?b')).toBeNull();
  });

  it('words commits by kind', () => {
    expect(commitMessage('draft', meta, 'python3')).toBe('draft: 1. Two Sum (python3)');
    expect(commitMessage('accepted', meta, 'python3', { runtime: '52 ms', memory: '17.1 MB' })).toBe(
      'accepted: 1. Two Sum (python3) - 52 ms, 17.1 MB',
    );
    expect(commitMessage('accepted', meta, 'python3', {})).toBe('accepted: 1. Two Sum (python3)');
    expect(commitMessage('draft', { ...meta, title: 'Two\n Sum' }, 'c')).toBe('draft: 1. Two Sum (c)');
  });

  it('validates slugs and languages', () => {
    expect(isValidSlug('two-sum')).toBe(true);
    expect(isValidSlug('3sum')).toBe(true);
    expect(isValidSlug('../x')).toBe(false);
    expect(isValidSlug('Two-Sum')).toBe(false);
    expect(isValidSlug('')).toBe(false);
    expect(isValidLang('python3')).toBe(true);
    expect(isValidLang('c++')).toBe(false);
    expect(isValidLang(3)).toBe(false);
  });
});

describe('text', () => {
  it('normalises line endings, BOM and trailing whitespace', () => {
    expect(normalizeCode('﻿a\r\nb\rc\n\n  ')).toBe('a\nb\nc');
    expect(normalizeCode('  indented\n')).toBe('  indented');
  });

  it('writes files with exactly one final newline', () => {
    expect(toFileContent('a\n\n\n')).toBe('a\n');
    expect(toFileContent('a')).toBe('a\n');
    expect(toFileContent('  \n')).toBe('');
  });

  it('hashes equal code equally regardless of formatting noise', async () => {
    expect(await hashCode('a\r\nb\n')).toBe(await hashCode('a\nb'));
    expect(await hashCode('a')).not.toBe(await hashCode('b'));
    expect(await hashCode('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('round-trips unicode through base64', () => {
    const s = '// 你好 — naïve ✓ 🚀\n' + 'x'.repeat(100_000);
    expect(base64ToUtf8(utf8ToBase64(s))).toBe(s);
    // GitHub wraps base64 at 60 columns.
    expect(base64ToUtf8('aGVs\nbG8=\n')).toBe('hello');
  });
});

describe('settings', () => {
  it('parses repo references', () => {
    expect(parseRepo('octo/sols')).toEqual({ owner: 'octo', repo: 'sols' });
    expect(parseRepo(' https://github.com/octo/sols.git ')).toEqual({ owner: 'octo', repo: 'sols' });
    expect(parseRepo('github.com/octo/my.repo/')).toEqual({ owner: 'octo', repo: 'my.repo' });
    expect(parseRepo('git@github.com:octo/sols.git')).toEqual({ owner: 'octo', repo: 'sols' });
    expect(parseRepo('octo')).toBeNull();
    expect(parseRepo('octo/sols/extra')).toBeNull();
    expect(parseRepo('octo/..')).toBeNull();
    expect(parseRepo('-bad/sols')).toBeNull();
  });

  it('merges stored values over defaults and ignores junk', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings({ repo: 'a/b', gitAlwaysWins: true, syncDrafts: 'yes', extra: 1 })).toEqual({
      ...DEFAULT_SETTINGS,
      repo: 'a/b',
      gitAlwaysWins: true,
    });
  });

  it('is configured only with a token and a valid repo', () => {
    expect(isConfigured(DEFAULT_SETTINGS)).toBe(false);
    expect(isConfigured({ ...DEFAULT_SETTINGS, token: 't', repo: 'nope' })).toBe(false);
    expect(isConfigured({ ...DEFAULT_SETTINGS, token: 't', repo: 'a/b' })).toBe(true);
  });
});

describe('leetcode payload parsing', () => {
  it('reads question details', () => {
    expect(
      parseQuestion({
        questionFrontendId: '1',
        title: 'Two Sum',
        codeSnippets: [{ langSlug: 'cpp', code: 'class Solution {};' }, { langSlug: 5 }, null],
      }),
    ).toEqual({ frontendId: '1', title: 'Two Sum', templates: { cpp: 'class Solution {};' } });
    expect(parseQuestion({ questionFrontendId: '1', title: 'SQL', codeSnippets: null })).toEqual({
      frontendId: '1',
      title: 'SQL',
      templates: {},
    });
    expect(parseQuestion(null)).toBeNull();
    expect(parseQuestion({ title: 'x' })).toBeNull();
  });

  it('recognises submit and result URLs', () => {
    expect(submitSlugFromUrl('/problems/two-sum/submit/')).toBe('two-sum');
    expect(submitSlugFromUrl('/problems/two-sum/interpret_solution/')).toBeNull();
    expect(submissionIdFromCheckUrl('/submissions/detail/1234567/check/')).toBe('1234567');
    expect(submissionIdFromCheckUrl('/submissions/detail/runcode_1700000000.12_abc/check/')).toBeNull();
  });

  it('reads the submitted code', () => {
    expect(parseSubmitBody(JSON.stringify({ lang: 'python3', question_id: '1', typed_code: 'pass' }))).toEqual({
      lang: 'python3',
      code: 'pass',
    });
    expect(parseSubmitBody('not json')).toBeNull();
    expect(parseSubmitBody(undefined)).toBeNull();
    expect(parseSubmitBody(JSON.stringify({ lang: 'c++', typed_code: 'x' }))).toBeNull();
  });

  it('reads judging results', () => {
    expect(parseCheckResponse(JSON.stringify({ state: 'PENDING' }))).toEqual({ finished: false, accepted: false });
    expect(
      parseCheckResponse(
        JSON.stringify({
          state: 'SUCCESS',
          status_code: 10,
          status_msg: 'Accepted',
          status_runtime: '52 ms',
          status_memory: '17.1 MB',
        }),
      ),
    ).toEqual({ finished: true, accepted: true, runtime: '52 ms', memory: '17.1 MB' });
    expect(
      parseCheckResponse(JSON.stringify({ state: 'SUCCESS', status_code: 11, status_msg: 'Wrong Answer' })),
    ).toMatchObject({ finished: true, accepted: false });
    expect(parseCheckResponse('<html>')).toEqual({ finished: false, accepted: false });
  });
});
