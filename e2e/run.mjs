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
const notesPath = `${runId}/0002-add-two-numbers/notes`;
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

async function remoteDir(p) {
  const { status, data } = await gh('GET', `/contents/${p}?ref=${encodeURIComponent(E2E_BRANCH)}&t=${Date.now()}`);
  if (status === 404) return [];
  if (status !== 200 || !Array.isArray(data)) throw new Error(`GitHub list ${p}: ${status}`);
  return data.map((f) => f.name).sort();
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

  // ---- scratch-paper notes ---------------------------------------------------

  const panel = page.locator('#lcgit-notes .panel');
  const paper = page.locator('#lcgit-notes svg.paper');
  const drawn = () => page.locator('#lcgit-notes svg.paper [data-id]').count();
  const noteLabel = () => page.locator('#lcgit-notes .label').textContent();
  const tool = (name) => page.locator(`#lcgit-notes button[data-tool="${name}"]`).click();
  const paperPoint = async (fx, fy) => {
    const box = await paper.boundingBox();
    return [box.x + box.width * fx, box.y + box.height * fy];
  };
  const dragOnPaper = async (from, to) => {
    const [x1, y1] = await paperPoint(...from);
    const [x2, y2] = await paperPoint(...to);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
    await page.mouse.move(x2, y2, { steps: 4 });
    await page.mouse.up();
  };
  const openNotes = async () => {
    await page.locator('#lcgit-root .notes').click();
    await panel.waitFor({ state: 'visible' });
    await page.locator('#lcgit-notes .loading').waitFor({ state: 'hidden' });
  };
  const closeNotes = async () => {
    await page.locator('#lcgit-notes button[aria-label="Close (Esc)"]').click();
    await panel.waitFor({ state: 'hidden' });
  };
  const openNextProblem = async () => {
    await page.goto('https://leetcode.com/problems/add-two-numbers/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.monaco?.editor.getModels().some((m) => m.getValue().length > 0));
    await pillShows(/In sync with git|Loaded from git/);
  };
  const noteShapes = (svg) => (svg.match(/&quot;type&quot;:&quot;(\w+)&quot;/g) ?? []).map((m) => m.split('&quot;')[3]);

  await step('the pencil button opens a blank scratch paper', async () => {
    await openNotes();
    expect((await noteLabel()) === 'New note', 'unexpected note label');
    expect((await drawn()) === 0, 'paper is not blank');
    expect((await remoteDir(notesPath)).length === 0, 'a note file exists before anything was drawn');
  });

  await step('Alt+N closes and reopens the panel', async () => {
    await page.keyboard.press('Alt+n');
    await panel.waitFor({ state: 'hidden' });
    await page.locator('#code .view-lines').click(); // focus is in the code box
    await page.keyboard.press('Alt+n');
    await panel.waitFor({ state: 'visible' });
  });

  await step('shapes can be drawn, selected, copied and pasted', async () => {
    await tool('rect');
    await dragOnPaper([0.3, 0.3], [0.4, 0.42]);
    expect((await drawn()) === 1, 'rectangle was not drawn');

    await tool('select');
    const [cx, cy] = await paperPoint(0.35, 0.36);
    await page.mouse.click(cx, cy); // inside the rectangle
    expect((await page.locator('#lcgit-notes .selbox').count()) === 1, 'rectangle was not selected');
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await page.keyboard.press('Control+v');
    expect((await drawn()) === 3, 'paste did not add copies');
    expect((await page.locator('#lcgit-notes .selbox').count()) === 1, 'the pasted copy is not the selection');

    // Drag the last copy away, then check undo/redo.
    const lastRect = page.locator('#lcgit-notes svg.paper rect[data-id]').last();
    const before = await lastRect.getAttribute('x');
    const corner = await lastRect.boundingBox();
    const [tx, ty] = await paperPoint(0.6, 0.6);
    await page.mouse.move(corner.x + corner.width - 1, corner.y + corner.height - 1); // its bottom-right corner
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 6 });
    await page.mouse.up();
    const after = await page.locator('#lcgit-notes svg.paper rect[data-id]').last().getAttribute('x');
    expect(Number(after) > Number(before) + 100, 'dragging did not move the copy');
    await page.keyboard.press('Control+z');
    expect((await page.locator('#lcgit-notes svg.paper rect[data-id]').last().getAttribute('x')) === before, 'undo failed');
    await page.keyboard.press('Control+Shift+z');

    await tool('arrow');
    await dragOnPaper([0.42, 0.36], [0.55, 0.36]);
    await tool('pen');
    await dragOnPaper([0.3, 0.6], [0.45, 0.7]);
    expect((await drawn()) === 6, 'arrow (2 parts) and pen stroke were not drawn'); // 3 rects + line + head + path
    await page.screenshot({ path: path.join(outDir, 'notes.png') });
  });

  await step('the eraser removes whole shapes', async () => {
    await tool('eraser');
    const stroke = await page.locator('#lcgit-notes svg.paper path[data-id]').boundingBox();
    const mx = stroke.x + stroke.width / 2;
    const my = stroke.y + stroke.height / 2;
    await page.mouse.move(mx - 6, my + 6); // drag across the middle of the pen stroke
    await page.mouse.down();
    await page.mouse.move(mx + 6, my - 6, { steps: 4 });
    await page.mouse.up();
    expect((await drawn()) === 5, 'pen stroke was not erased');
  });

  await step('keys typed in the panel do not reach the code box', async () => {
    const code = await editorCode();
    await panel.focus();
    await page.keyboard.type('plr');
    await page.keyboard.press('Delete');
    expect((await editorCode()) === code, 'code box changed');
  });

  let firstNote;
  await step('closing the panel saves the note to the repo as an SVG', async () => {
    await closeNotes();
    const files = await until('note file in repo', async () => {
      const f = await remoteDir(notesPath);
      return f.length === 1 ? f : null;
    });
    firstNote = files[0];
    expect(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.svg$/.test(firstNote), `unexpected file name: ${firstNote}`);
    const file = await remoteFile(`${notesPath}/${firstNote}`);
    expect(file.content.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), 'not an SVG file');
    expect(noteShapes(file.content).join() === 'rect,rect,rect,arrow', `unexpected shapes: ${noteShapes(file.content)}`);
    const message = await lastCommitMessage(`${notesPath}/${firstNote}`);
    expect(/^notes: 2\. Add Two Numbers \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/.test(message), `unexpected message: ${message}`);
  });

  await step('reopening soon after a reload continues the same note', async () => {
    await openNextProblem();
    await openNotes();
    expect((await drawn()) === 5, 'saved drawing was not restored');
    expect((await noteLabel()) === firstNote.replace('_', ' ').replace(/-(\d\d)\.svg$/, ':$1'), 'unexpected note label');
    await tool('ellipse');
    await dragOnPaper([0.6, 0.25], [0.7, 0.35]);
    await closeNotes();
    await until('ellipse saved into the same file', async () =>
      noteShapes((await remoteFile(`${notesPath}/${firstNote}`)).content).includes('ellipse'),
    );
    expect((await remoteDir(notesPath)).length === 1, 'a second file was created within the same session');
  });

  await step('after a long break, a new blank note starts and the old one is in the history', async () => {
    // Make the saved note look two hours old, as if the break had happened.
    const file = await remoteFile(`${notesPath}/${firstNote}`);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const aged = file.content.replace(/(&quot;savedAt&quot;:&quot;)[^&]+(&quot;)/, `$1${old}$2`);
    expect(aged !== file.content, 'could not age the note');
    await commitElsewhere(`${notesPath}/${firstNote}`, aged);

    await openNextProblem();
    await openNotes();
    expect((await drawn()) === 0, 'new session is not blank');
    expect((await noteLabel()) === 'New note', 'unexpected note label');
    const options = await page.locator('#lcgit-notes select option').allTextContents();
    expect(options.length === 2 && options[0] === 'History (1)', `unexpected history: ${options}`);

    await tool('line');
    await dragOnPaper([0.3, 0.3], [0.5, 0.5]);
    await closeNotes();
    const files = await until('second note file', async () => {
      const f = await remoteDir(notesPath);
      return f.length === 2 ? f : null;
    });
    const second = files.find((f) => f !== firstNote);
    expect(noteShapes((await remoteFile(`${notesPath}/${second}`)).content).join() === 'line', 'unexpected second note');
    expect((await remoteFile(`${notesPath}/${firstNote}`)).content === aged, 'the earlier note was modified');
  });

  await step('an earlier note opens read-only and can be copied into the current one', async () => {
    await openNotes();
    await page.locator('#lcgit-notes select').selectOption(firstNote);
    await page.locator('#lcgit-notes .pastbar').waitFor({ state: 'visible' });
    expect((await drawn()) === 6, 'earlier note not shown'); // 3 rects + arrow (2 parts) + ellipse
    expect(await page.locator('#lcgit-notes button[data-tool="pen"]').isDisabled(), 'tools are enabled on a read-only note');
    await dragOnPaper([0.3, 0.6], [0.45, 0.7]); // drawing must do nothing here
    expect((await drawn()) === 6, 'a read-only note was edited');
    await page.screenshot({ path: path.join(outDir, 'notes-history.png') });

    await page.locator('#lcgit-notes .pastbar button', { hasText: 'Copy all into current' }).click();
    await page.locator('#lcgit-notes .pastbar').waitFor({ state: 'hidden' });
    expect((await drawn()) === 7, 'earlier note was not copied into the current one'); // + today's line
    await closeNotes();
    const files = await remoteDir(notesPath);
    const second = files.find((f) => f !== firstNote);
    await until('copied shapes saved', async () =>
      noteShapes((await remoteFile(`${notesPath}/${second}`)).content).length === 6,
    );
    expect(files.length === 2, 'unexpected number of note files');
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
