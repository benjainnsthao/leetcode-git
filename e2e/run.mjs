// Browser check: loads the built extension into Chromium and exercises the
// whole sync loop against a real GitHub repo.
//
//   npm run build
//   GH_TOKEN=... E2E_REPO=owner/name E2E_BRANCH=some-scratch-branch npm run e2e
//
// GitHub is real: everything is written under a unique folder on E2E_BRANCH,
// so use a throwaway branch and delete it afterwards.
//
// LeetCode is NOT contacted. Requests to leetcode.com are answered inside the
// test browser by e2e/fixture/problem.html, a stand-in page with a real Monaco
// editor that mimics the parts of the problem page the extension relies on.
// "Accepted" results are likewise canned responses in LeetCode's format.

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { GH_TOKEN, E2E_REPO, E2E_BRANCH, CHROME_PATH } = process.env;
if (!GH_TOKEN || !E2E_REPO || !E2E_BRANCH) {
  console.error('Set GH_TOKEN, E2E_REPO (owner/name) and E2E_BRANCH.');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'e2e', '.out');
const runId = `e2e-${Date.now().toString(36)}`;
const cppPath = `${runId}/0001-two-sum/solution.cpp`;
const pyPath = `${runId}/0001-two-sum/solution.py`;
const nextPyPath = `${runId}/0002-add-two-numbers/solution.py`;
const DRAFT_WAIT = 25_000;

const TEMPLATES = {
  cpp: 'class Solution {\npublic:\n    \n};',
  python3: 'class Solution:\n    def solve(self):\n        ',
};
const QUESTIONS = {
  'two-sum': { questionFrontendId: '1', title: 'Two Sum' },
  'add-two-numbers': { questionFrontendId: '2', title: 'Add Two Numbers' },
};

// ---- GitHub, as "another computer" ---------------------------------------

async function gh(method, url, body) {
  const res = await fetch(`https://api.github.com/repos/${E2E_REPO}${url}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function remoteFile(p) {
  const { status, data } = await gh('GET', `/contents/${p}?ref=${encodeURIComponent(E2E_BRANCH)}&t=${Date.now()}`);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`GitHub GET ${p}: ${status}`);
  return { sha: data.sha, content: Buffer.from(data.content, 'base64').toString('utf8') };
}

async function commitElsewhere(p, content) {
  const existing = await remoteFile(p);
  const { status } = await gh('PUT', `/contents/${p}`, {
    message: 'e2e: change from another computer',
    content: Buffer.from(content).toString('base64'),
    branch: E2E_BRANCH,
    ...(existing ? { sha: existing.sha } : {}),
  });
  if (status !== 200 && status !== 201) throw new Error(`GitHub PUT ${p}: ${status}`);
}

async function lastCommitMessage(p) {
  const { data } = await gh('GET', `/commits?sha=${encodeURIComponent(E2E_BRANCH)}&path=${p}&per_page=1&t=${Date.now()}`);
  return data?.[0]?.commit?.message ?? null;
}

// ---- tiny test runner ------------------------------------------------------

const results = [];
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        ${String(e?.message ?? e).split('\n')[0]}`);
    throw e;
  }
}

async function until(what, fn, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

// ---- stand-in LeetCode -----------------------------------------------------

const fixtureHtml = (await readFile(path.join(root, 'e2e/fixture/problem.html'), 'utf8')).replace(
  '__TEMPLATES__',
  JSON.stringify(TEMPLATES),
);
const monacoDir = path.join(root, 'node_modules/monaco-editor/min');

async function serveLeetCode(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (/^\/problems\/[a-z0-9-]+\/?$/.test(url.pathname)) {
    return route.fulfill({ contentType: 'text/html', body: fixtureHtml });
  }
  if (url.pathname.startsWith('/monaco/')) {
    const file = path.normalize(path.join(monacoDir, url.pathname.slice('/monaco'.length)));
    if (!file.startsWith(monacoDir)) return route.fulfill({ status: 403, body: '' });
    return route.fulfill({ path: file }).catch(() => route.fulfill({ status: 404, body: '' }));
  }
  if (url.pathname === '/graphql/' && request.method() === 'POST') {
    const slug = JSON.parse(request.postData() ?? '{}').variables?.titleSlug;
    const question = QUESTIONS[slug]
      ? { ...QUESTIONS[slug], codeSnippets: Object.entries(TEMPLATES).map(([langSlug, code]) => ({ langSlug, code })) }
      : null;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { question } }) });
  }
  return route.fulfill({ status: 404, body: '' });
}

// ---- browser ---------------------------------------------------------------

await mkdir(outDir, { recursive: true });
const profile = await mkdtemp(path.join(root, '.e2e-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME_PATH || undefined,
  headless: true,
  viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-sandbox', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
await context.route('https://leetcode.com/**', serveLeetCode);

let failed = false;
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`        page error: ${e.message.split('\n')[0]}`));

  const pill = page.locator('#lcgit-root .pill');
  const card = page.locator('#lcgit-root .card');
  const pillShows = (re, timeout = 40_000) =>
    until(`status pill to match ${re}`, async () => re.test((await pill.textContent().catch(() => '')) ?? ''), timeout);
  const editorCode = () =>
    page.evaluate(() => {
      const ed = window.monaco.editor.getEditors().find((e) => e.getModel() && e.getModel().getLanguageId() !== 'plaintext');
      return ed.getModel().getValue();
    });
  const typeAtEnd = async (text) => {
    await page.locator('#code .view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(text, { delay: 5 });
  };
  const openProblem = async () => {
    await page.goto('https://leetcode.com/problems/two-sum/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.monaco?.editor.getModels().some((m) => m.getValue().length > 0));
  };
  const fileOnDisk = (code) => code.replace(/\s+$/, '') + '\n';
  const saveOptions = async (changes) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await changes(options);
    await options.click('#save');
    await options.locator('#note.ok').waitFor({ timeout: 20_000 });
    const note = await options.locator('#note').textContent();
    await options.screenshot({ path: path.join(outDir, 'options.png'), fullPage: true });
    await options.close();
    return note;
  };

  console.log(`Run folder: ${runId} on ${E2E_REPO}@${E2E_BRANCH}`);

  await step('before setup, the pill asks to connect a repo', async () => {
    await openProblem();
    await pillShows(/Set up git sync/);
  });

  await step('options page saves settings and verifies the connection', async () => {
    const note = await saveOptions(async (o) => {
      await o.fill('#repo', `https://github.com/${E2E_REPO}.git`);
      await o.fill('#token', GH_TOKEN);
      await o.fill('#branch', E2E_BRANCH);
      await o.fill('#baseDir', `/${runId}/`);
    });
    expect(/Connected to/.test(note), `unexpected note: ${note}`);
  });

  await step('a new problem starts as "Not in git yet" and the starter code is not committed', async () => {
    await openProblem();
    await pillShows(/Not in git yet/);
    await new Promise((r) => setTimeout(r, 12_000));
    expect((await remoteFile(cppPath)) === null, 'starter code was committed');
  });

  const marker1 = `// draft ${runId}`;
  await step('typing commits a draft to the repo', async () => {
    await typeAtEnd(`\n${marker1}`);
    await pillShows(/Saved to git/, DRAFT_WAIT);
    const file = await remoteFile(cppPath);
    expect(file?.content.includes(marker1), 'draft not found in repo');
    expect(file.content === fileOnDisk(await editorCode()), 'repo content differs from code box');
    expect((await lastCommitMessage(cppPath)) === 'draft: 1. Two Sum (cpp)', 'unexpected commit message');
    await page.screenshot({ path: path.join(outDir, 'saved.png') });
  });

  const elsewhere1 = `// written on another computer ${runId}\nclass Solution {};\n`;
  await step('a commit made elsewhere is loaded when the tab regains focus', async () => {
    await commitElsewhere(cppPath, elsewhere1);
    await new Promise((r) => setTimeout(r, 16_000)); // focus re-checks are rate limited
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await pillShows(/Loaded from git/);
    expect((await editorCode()) === elsewhere1.trimEnd(), 'code box does not hold the repo version');
  });

  await step('the loaded code can be undone with Ctrl+Z', async () => {
    await page.locator('#code .view-lines').click();
    await page.keyboard.press('Control+z');
    expect((await editorCode()).includes(marker1), 'undo did not restore the previous code');
    await page.keyboard.press('Control+Shift+z');
    expect((await editorCode()) === elsewhere1.trimEnd(), 'redo did not restore the repo version');
  });

  await step('after a reload, code the page restored itself is recognised as in sync', async () => {
    await openProblem();
    await pillShows(/In sync with git/);
    expect((await editorCode()) === elsewhere1.trimEnd(), 'code box changed');
  });

  await step('a fresh code box (as on another computer) gets the repo version', async () => {
    await page.evaluate(() => localStorage.clear());
    await openProblem();
    expect((await editorCode()) === TEMPLATES.cpp, 'fixture did not start from the starter code');
    await pillShows(/Loaded from git/);
    expect((await editorCode()) === elsewhere1.trimEnd(), 'code box does not hold the repo version');
  });

  const elsewhere2 = `// second remote change ${runId}\n`;
  await step('when both sides change, nothing is overwritten and the prompt appears', async () => {
    await typeAtEnd(`\n// local edit ${runId}`);
    await commitElsewhere(cppPath, elsewhere2);
    await pillShows(/Differs from git/, DRAFT_WAIT);
    await card.waitFor({ state: 'visible' });
    expect((await remoteFile(cppPath)).content === elsewhere2, 'repo was overwritten');
    expect((await editorCode()).includes('// local edit'), 'code box was overwritten');
    await page.screenshot({ path: path.join(outDir, 'conflict.png') });
  });

  await step('"Keep mine" commits the code box over the repo version', async () => {
    await card.getByRole('button', { name: 'Keep mine' }).click();
    await pillShows(/Saved to git/);
    await card.waitFor({ state: 'hidden' });
    expect((await remoteFile(cppPath)).content.includes('// local edit'), 'local version not committed');
  });

  const elsewhere3 = `// third remote change ${runId}\n`;
  await step('"Use git" loads the repo version', async () => {
    await typeAtEnd(`\n// another local edit`);
    await commitElsewhere(cppPath, elsewhere3);
    await pillShows(/Differs from git/, DRAFT_WAIT);
    await card.getByRole('button', { name: 'Use git' }).click();
    await pillShows(/Loaded from git/);
    expect((await editorCode()) === elsewhere3.trimEnd(), 'repo version not loaded');
    expect((await remoteFile(cppPath)).content === elsewhere3, 'repo changed');
  });

  await step('"Reset to default" is neither committed nor undone', async () => {
    await page.click('#reset');
    await pillShows(/Git copy kept/);
    await new Promise((r) => setTimeout(r, 12_000));
    expect((await editorCode()) === TEMPLATES.cpp, 'reset was undone');
    expect((await remoteFile(cppPath)).content === elsewhere3, 'repo changed');
  });

  await step('an accepted submission is committed with its stats (canned judge responses)', async () => {
    await page.route('**/problems/two-sum/submit/', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ submission_id: 987654321 }) }),
    );
    let polls = 0;
    await page.route('**/submissions/detail/987654321/check/', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          polls++ === 0
            ? { state: 'PENDING' }
            : {
                state: 'SUCCESS',
                status_code: 10,
                status_msg: 'Accepted',
                status_runtime: '7 ms',
                status_memory: '9.9 MB',
                lang: 'cpp',
              },
        ),
      }),
    );
    await typeAtEnd('\n// accepted version');
    const code = await editorCode();
    // Replay both request styles: XHR for the submit, fetch for the polling.
    await page.evaluate(async (typed) => {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/problems/two-sum/submit/');
        xhr.setRequestHeader('content-type', 'application/json');
        xhr.onload = resolve;
        xhr.onerror = reject;
        xhr.send(JSON.stringify({ lang: 'cpp', question_id: '1', typed_code: typed }));
      });
      await fetch('/submissions/detail/987654321/check/');
      await fetch('/submissions/detail/987654321/check/');
    }, code);
    await pillShows(/Accepted — saved to git/);
    const message = await lastCommitMessage(cppPath);
    expect(message === 'accepted: 1. Two Sum (cpp) - 7 ms, 9.9 MB', `unexpected commit message: ${message}`);
    expect((await remoteFile(cppPath)).content === fileOnDisk(code), 'accepted code not in repo');
    await page.unrouteAll();
  });

  await step('"Run" results are not mistaken for accepted submissions', async () => {
    const before = await lastCommitMessage(cppPath);
    await page.route('**/submissions/detail/runcode_1.2_abc/check/', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ state: 'SUCCESS', status_code: 10, status_msg: 'Accepted' }),
      }),
    );
    await page.evaluate(() => fetch('/submissions/detail/runcode_1.2_abc/check/'));
    await new Promise((r) => setTimeout(r, 3000));
    expect((await lastCommitMessage(cppPath)) === before, 'a run result created a commit');
    await page.unrouteAll();
  });

  const pyMarker = `# python draft ${runId}`;
  await step('switching language syncs a separate file', async () => {
    await page.locator('[data-e2e-locator="lang-selector-button"]').click();
    await page.locator('[role="dialog"]').getByText('Python3', { exact: true }).click();
    await pillShows(/Not in git yet/);
    await typeAtEnd(`\n${pyMarker}`);
    await pillShows(/Saved to git/, DRAFT_WAIT);
    expect((await remoteFile(pyPath))?.content.includes(pyMarker), 'python file not committed');
    expect((await lastCommitMessage(pyPath)) === 'draft: 1. Two Sum (python3)', 'unexpected python commit message');
    expect(!(await remoteFile(cppPath)).content.includes(pyMarker), 'python code leaked into the C++ file');
  });

  await step('moving to another problem commits the pending draft and starts fresh', async () => {
    await typeAtEnd('\n# typed just before leaving');
    const leaving = await editorCode();
    await page.click('#next');
    await pillShows(/Not in git yet/);
    expect(new URL(page.url()).pathname === '/problems/add-two-numbers/', 'did not navigate');
    await until('pending draft to reach the repo', async () => (await remoteFile(pyPath)).content === fileOnDisk(leaving));
    await typeAtEnd('\n# second problem');
    await pillShows(/Saved to git/, DRAFT_WAIT);
    expect((await lastCommitMessage(nextPyPath)) === 'draft: 2. Add Two Numbers (python3)', 'unexpected commit message');
  });

  const elsewhere4 = `# fourth remote change ${runId}\n`;
  await step('"Git always wins" loads the repo version without asking', async () => {
    await saveOptions((o) => o.check('#gitAlwaysWins'));
    await page.bringToFront();
    await typeAtEnd('\n# local edit that will lose');
    await commitElsewhere(nextPyPath, elsewhere4);
    await pillShows(/Loaded from git/, DRAFT_WAIT);
    expect((await editorCode()) === elsewhere4.trimEnd(), 'repo version not loaded');
    expect(await card.isHidden(), 'prompt was shown');
  });

  await step('popup reports the problem and its state', async () => {
    const answer = await worker.evaluate(async () => {
      for (const tab of await chrome.tabs.query({})) {
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: 'popup/status' });
          if (res?.active) return res;
        } catch {
          // tab without our content script
        }
      }
      return null;
    });
    expect(
      answer?.slug === 'add-two-numbers' && answer.lang === 'python3',
      `unexpected popup answer: ${JSON.stringify(answer)}`,
    );
    expect(answer.status.fileUrl.endsWith(nextPyPath), 'file link is wrong');
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 320, height: 240 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator('#repo').filter({ hasText: E2E_REPO }).waitFor();
    await popup.screenshot({ path: path.join(outDir, 'popup.png') });
    await popup.close();
  });

  await step('the token is not exposed to the page', async () => {
    const leaked = await page.evaluate(
      (token) => document.documentElement.innerHTML.includes(token) || JSON.stringify({ ...localStorage }).includes(token),
      GH_TOKEN,
    );
    expect(!leaked, 'token found in page');
  });
} catch {
  failed = true;
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} steps passed${failed ? ' (stopped at first failure)' : ''}`);
process.exit(failed ? 1 : 0);
