# LeetCode Git Sync

A browser extension that keeps the LeetCode code box and a GitHub repo of your solutions in sync, in both directions, so your work follows you between computers.

- **LeetCode → git.** Your code is committed to your solutions repo about 10 seconds after you stop typing. Accepted submissions get their own commit with runtime and memory.
- **git → LeetCode.** Opening a problem loads the version from your repo into the code box. That includes changes pushed from somewhere else: another computer, or your own editor and `git push`.
- **Scratch-paper notes.** A drawing panel for sketching the algorithm. Each working session is saved to the repo as its own timestamped picture, so every problem builds up a dev log you can look back on.
- **Your repo, your rules.** The solutions repo can be private or public. There is no server; the extension talks to GitHub directly from your browser.

Works in Chrome, Edge, Brave and other Chromium browsers (Manifest V3, Chrome 111+).

> **Status: early.** The sync engine is covered by automated tests, including a browser test against real GitHub. LeetCode's own page is not part of the automated tests, so please report anything odd you see on the real site.

## Install

The extension is not on the Chrome Web Store yet. Build it and load it unpacked:

```sh
git clone https://github.com/benjainnsthao/leetcode-git.git
cd leetcode-git
npm install
npm run build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `dist` folder. The settings page opens on first install.

## Set up

1. **Create a solutions repo** on GitHub (private or public). Tick *Add a README* when creating it, so the repo has a first commit.
2. **Create a fine-grained personal access token** at [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new):
   - Repository access: *Only select repositories* → your solutions repo
   - Permissions → Repository → **Contents: Read and write**
3. Open the extension's **Settings**, enter the repo as `owner/name`, paste the token, and press **Save**. It checks the connection for you.

Repeat step 3 on every computer you use. That is all it takes to share your solutions between them.

## How syncing works

A small pill in the bottom-right corner of a problem page shows the current state. Click it to open the file on GitHub.

When you open a problem, switch language, or come back to the tab, the extension compares three things: the code box, the file in the repo, and the version it last synced on this computer.

| Situation | What happens |
|---|---|
| No file in the repo yet | Nothing. The file is created once you type. |
| Code box and repo match | Nothing. |
| Code box untouched (starter code, or unchanged since the last sync), repo differs | The repo version is loaded into the code box. |
| Repo unchanged since the last sync, code box changed | The code box is committed. |
| Both changed | You are asked: **Use git** or **Keep mine**. Nothing is overwritten until you choose. |
| Both changed, and **Git always wins** is on | The repo version is loaded without asking. |

Other details:

- LeetCode's untouched starter code is never committed.
- Loading from git is a normal edit: **Ctrl+Z** brings your previous code back.
- If you use LeetCode's "reset to default code", the reset is left alone and is not committed. Your repo keeps your last saved version until you type something new.
- Commits never overwrite a newer commit. If the repo moved since the extension last looked, you get the same **Use git / Keep mine** choice.
- Contest pages are not synced.

## Scratch-paper notes

Click the pencil button next to the status pill (or press **Alt+N**) to open a sheet of scratch paper over the problem. Draw the idea, close it, carry on coding.

- **Tools:** select, pen, line, arrow, rectangle, ellipse, eraser; six colours, three thicknesses; undo, redo, clear.
- **Building arrays and trees quickly:** draw one cell or node, select it, then `Ctrl+C` / `Ctrl+V` (or `Ctrl+D` to duplicate). The copy stays selected so you can drag it into place. Shift-click or drag a box to select several shapes; arrow keys nudge; `Delete` removes.
- **Sessions.** Each working session is one file named after the time it started. If you reopen the notes within 60 minutes of the last save, you continue the same note. After a longer break you get a blank page and a new file; the earlier note stays in the history. The 60 minutes is a setting.
- **Saving.** The note is committed 30 seconds after you stop drawing, and right away when you close the panel, switch tabs or leave the problem. Until a save lands, your strokes are also kept in the browser, so a crash does not lose them.
- **History.** The menu at the right of the toolbar lists the problem's earlier notes. Opening one shows it read-only; you can copy all of it, or a selected part, into the current note.
- Notes belong to the problem, not to a language. A note that was changed from another computer in the meantime is never overwritten: your drawing is saved as a new note.
- The eraser removes whole strokes and shapes (the drawing is made of shapes, not pixels).

Notes are SVG files, so GitHub shows them as pictures and they stay small in git.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| Repository | – | `owner/name` of your solutions repo. |
| Personal access token | – | Stored only in this browser. |
| Branch | repo default | Branch to sync with. It must already exist. |
| Folder | `problems` | Folder inside the repo. Empty means the repo root. |
| Save drafts while I work | on | Off: only accepted submissions are committed. |
| Git always wins | off | On: when both sides changed, load the repo version without asking. Unsynced changes in the code box are discarded. |
| Start a new note after | 60 minutes | How long after the last save a scratch-paper note is still continued. After that, a new note starts. |

## What the repo looks like

One folder per problem, one file per language, and one picture per notes session:

```
problems/
  0001-two-sum/
    solution.py
    solution.cpp
    notes/
      2026-11-14_09-35.svg
      2026-11-16_21-10.svg
  0002-add-two-numbers/
    solution.py
```

Commit messages tell you what kind of save it was:

```
draft: 1. Two Sum (python3)
accepted: 1. Two Sum (python3) - 52 ms, 17.1 MB
notes: 1. Two Sum (2026-11-14 09:35)
```

You can edit these files anywhere and push; the next time you open the problem on LeetCode, your pushed version is loaded.

## Privacy and security

- The token is kept in the extension's local storage and is only ever sent to `api.github.com`. The LeetCode page cannot read it, and only the extension's background worker uses it.
- The extension reads the problem number, title and starter code from LeetCode using your existing session. It sends nothing to LeetCode and has no analytics or third-party servers.
- A fine-grained token limited to one repo means that, even if the token leaked, only that repo is exposed.
- If your solutions repo is **public**, your drafts and notes are public too, as you make them. Use a private repo if you do not want that.
- Note files from the repo are read as data only. Their SVG markup is never inserted into the LeetCode page.

## Limitations

- GitHub only (no GitLab, Bitbucket or self-hosted git).
- `leetcode.com` only (not `leetcode.cn`).
- Chromium browsers only for now.
- Changes pushed to the repo show up when you open the problem or return to its tab, not while you are looking at it.
- Notes have no text tool, zoom or pan yet, and note files are named in each computer's local time.
- The extension depends on details of LeetCode's page (the Monaco editor and its submit requests). If LeetCode changes those, syncing may stop until the extension is updated; it is written so that it stops quietly rather than touching your code.

## Development

```sh
npm test            # unit tests (sync rules, GitHub client, notes, full sync scenarios)
npm run typecheck
npm run build       # writes dist/
npm run watch       # rebuild on change
```

Layout:

```
src/core/         pure logic: sync decision, repo paths, settings, text helpers
src/background/   service worker: the only code that holds the token and calls GitHub
src/page/         runs inside the LeetCode page: reads/writes the editor, sees submissions
src/content/      sync engine, status pill and conflict prompt
src/notes/        scratch paper: drawing model, SVG format, sessions, panel
src/options/      settings page
src/popup/        toolbar popup
tests/            unit tests with an in-memory GitHub
e2e/              browser test: built extension + real GitHub + a stand-in problem page
```

The browser test loads the built extension into Chromium and syncs against a real repo. It never contacts LeetCode; a local stand-in page with a real Monaco editor is served in its place.

```sh
npm run build
GH_TOKEN=<token> E2E_REPO=<owner/name> E2E_BRANCH=<scratch branch> npm run e2e
```

It writes into a uniquely named folder on the branch you give it, so use a throwaway branch.

## License

[MIT](LICENSE)
