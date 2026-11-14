// An in-memory stand-in for the parts of api.github.com the extension uses.
// Mimics the real status codes: 404 for a missing file, 409 for a stale sha,
// 422 when an existing file is written without a sha.

import { base64ToUtf8, utf8ToBase64 } from '../src/core/text';

export interface Commit {
  path: string;
  message: string;
  content: string;
}

export class FakeGitHub {
  files = new Map<string, { content: string; sha: string }>();
  commits: Commit[] = [];
  requests: { method: string; url: string; headers: Record<string, string>; cache?: string }[] = [];
  /** Set to make every request fail with this status. */
  failWith: { status: number; message?: string; headers?: Record<string, string> } | null = null;
  offline = false;
  repo = { full_name: 'octo/sols', private: true, default_branch: 'main', permissions: { push: true } };
  branches = new Set(['main']);
  private nextSha = 1;

  /** Simulates a commit made from elsewhere (another computer, a local editor). */
  commitElsewhere(path: string, content: string): string {
    const sha = `sha${this.nextSha++}`;
    this.files.set(path, { content, sha });
    this.commits.push({ path, message: 'external', content });
    return sha;
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.requests.push({ method, url: input, headers, cache: init.cache });
    if (this.offline) throw new TypeError('Failed to fetch');
    if (this.failWith) {
      return json(this.failWith.status, { message: this.failWith.message ?? 'nope' }, this.failWith.headers);
    }
    const url = new URL(input);
    const m = /^\/repos\/octo\/sols(?:\/(contents|branches)\/(.+))?$/.exec(url.pathname);
    if (!m) return json(404, { message: 'Not Found' });
    if (!m[1]) return json(200, this.repo);
    const rest = decodeURIComponent(m[2]);
    if (m[1] === 'branches') return this.branches.has(rest) ? json(200, { name: rest }) : json(404, { message: 'Branch not found' });

    const existing = this.files.get(rest);
    if (method === 'GET') {
      if (!existing) return json(404, { message: 'Not Found' });
      // GitHub wraps the base64 payload in lines.
      const b64 = utf8ToBase64(existing.content).replace(/(.{60})/g, '$1\n');
      return json(200, { type: 'file', encoding: 'base64', content: b64, sha: existing.sha });
    }
    if (method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { message: string; content: string; sha?: string };
      if (existing && !body.sha) return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      if (existing && body.sha !== existing.sha) return json(409, { message: `${rest} does not match ${body.sha}` });
      if (!existing && body.sha) return json(409, { message: 'does not match' });
      const content = base64ToUtf8(body.content);
      const sha = `sha${this.nextSha++}`;
      this.files.set(rest, { content, sha });
      this.commits.push({ path: rest, message: body.message, content });
      return json(existing ? 200 : 201, { content: { sha } });
    }
    return json(405, { message: 'Method not allowed' });
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export class MemoryStore {
  data: Record<string, unknown> = {};
  async get(key: string): Promise<Record<string, unknown>> {
    return key in this.data ? { [key]: this.data[key] } : {};
  }
  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, items);
  }
}
