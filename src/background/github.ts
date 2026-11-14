// Thin client for the GitHub REST "contents" API: read one file, write one file.

import { base64ToUtf8, utf8ToBase64 } from '../core/text';

export type GitHubErrorKind = 'auth' | 'forbidden' | 'not-found' | 'conflict' | 'rate-limit' | 'network' | 'other';

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  /** Empty string = the repo's default branch. */
  branch: string;
}

export interface FileInfo {
  content: string;
  sha: string;
}

export interface RepoInfo {
  fullName: string;
  private: boolean;
  canPush: boolean;
  defaultBranch: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.github.com';

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export class GitHubClient {
  constructor(
    private readonly cfg: GitHubConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  private get repoUrl(): string {
    return `${API}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}`;
  }

  private async request(method: string, url: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method,
        // GitHub marks API responses cacheable for 60s; we must always see
        // the latest commit, so bypass the HTTP cache entirely.
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.cfg.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError('network', 'Could not reach GitHub. Check your connection.');
    }
  }

  private async fail(res: Response): Promise<never> {
    let apiMessage = '';
    try {
      const data = (await res.json()) as { message?: unknown };
      if (typeof data.message === 'string') apiMessage = data.message;
    } catch {
      // Non-JSON error body; the status code is enough.
    }
    const s = res.status;
    if (s === 401) {
      throw new GitHubError('auth', 'GitHub rejected the token. It may be mistyped, expired or revoked.', s);
    }
    if (s === 403 || s === 429) {
      if (s === 429 || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(apiMessage)) {
        throw new GitHubError('rate-limit', 'GitHub rate limit reached. Sync will resume shortly.', s);
      }
      throw new GitHubError(
        'forbidden',
        'The token is not allowed to do this. It needs "Contents: Read and write" on the solutions repo.',
        s,
      );
    }
    if (s === 404) {
      throw new GitHubError(
        'not-found',
        'Repository or branch not found, or the token has no access to it.',
        s,
      );
    }
    if (s === 409 || (s === 422 && /sha/i.test(apiMessage))) {
      throw new GitHubError('conflict', 'The file changed in the repo since it was last read.', s);
    }
    throw new GitHubError('other', `GitHub error ${s}${apiMessage ? `: ${apiMessage}` : ''}`, s);
  }

  /** Returns null when the file (or the whole repo's first commit) does not exist yet. */
  async getFile(path: string): Promise<FileInfo | null> {
    const ref = this.cfg.branch ? `?ref=${encodeURIComponent(this.cfg.branch)}` : '';
    const res = await this.request('GET', `${this.repoUrl}/contents/${encodePath(path)}${ref}`);
    if (res.status === 404) return null;
    if (!res.ok) return this.fail(res);
    const data = (await res.json()) as { type?: string; content?: string; encoding?: string; sha?: string };
    if (Array.isArray(data) || data.type !== 'file' || typeof data.sha !== 'string') {
      throw new GitHubError('other', `"${path}" exists in the repo but is not a regular file.`);
    }
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new GitHubError('other', `"${path}" is too large to sync.`);
    }
    return { content: base64ToUtf8(data.content), sha: data.sha };
  }

  /**
   * Creates or updates a file with one commit.
   * `sha` must be the blob sha being replaced, or null to create the file.
   * Throws GitHubError('conflict') if the repo no longer matches `sha`.
   */
  async putFile(path: string, content: string, message: string, sha: string | null): Promise<{ sha: string }> {
    const body: Record<string, string> = { message, content: utf8ToBase64(content) };
    if (sha) body.sha = sha;
    if (this.cfg.branch) body.branch = this.cfg.branch;
    const res = await this.request('PUT', `${this.repoUrl}/contents/${encodePath(path)}`, body);
    if (!res.ok) return this.fail(res);
    const data = (await res.json()) as { content?: { sha?: string } };
    const newSha = data.content?.sha;
    if (typeof newSha !== 'string') throw new GitHubError('other', 'Unexpected response from GitHub.');
    return { sha: newSha };
  }

  async getRepo(): Promise<RepoInfo> {
    const res = await this.request('GET', this.repoUrl);
    if (!res.ok) return this.fail(res);
    const data = (await res.json()) as {
      full_name?: string;
      private?: boolean;
      default_branch?: string;
      permissions?: { push?: boolean };
    };
    return {
      fullName: data.full_name ?? `${this.cfg.owner}/${this.cfg.repo}`,
      private: data.private === true,
      canPush: data.permissions?.push === true,
      defaultBranch: data.default_branch ?? '',
    };
  }

  /** True if the configured branch exists (always true when using the default branch). */
  async branchExists(): Promise<boolean> {
    if (!this.cfg.branch) return true;
    const res = await this.request('GET', `${this.repoUrl}/branches/${encodePath(this.cfg.branch)}`);
    if (res.status === 404) return false;
    if (!res.ok) return this.fail(res);
    return true;
  }
}
