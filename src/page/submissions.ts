// Parsing of LeetCode's submit / result-polling network calls. Kept free of
// browser globals so it can be unit-tested.

/** "/problems/two-sum/submit/" -> "two-sum". */
export function submitSlugFromUrl(pathname: string): string | null {
  return /^\/problems\/([a-z0-9][a-z0-9-]*)\/submit\/?$/.exec(pathname)?.[1] ?? null;
}

/**
 * "/submissions/detail/123456/check/" -> "123456".
 * "Run" results use ids like "runcode_1700000000.1_abc" and never match.
 */
export function submissionIdFromCheckUrl(pathname: string): string | null {
  return /^\/submissions\/detail\/(\d+)\/check\/?$/.exec(pathname)?.[1] ?? null;
}

/** Extracts language and code from the body LeetCode posts on submit. */
export function parseSubmitBody(body: unknown): { lang: string; code: string } | null {
  if (typeof body !== 'string') return null;
  try {
    const data = JSON.parse(body) as { lang?: unknown; typed_code?: unknown };
    if (typeof data.lang !== 'string' || typeof data.typed_code !== 'string') return null;
    if (!/^[a-z0-9]{1,30}$/.test(data.lang)) return null;
    return { lang: data.lang, code: data.typed_code };
  } catch {
    return null;
  }
}

export interface CheckResult {
  /** False while LeetCode is still judging. */
  finished: boolean;
  accepted: boolean;
  runtime?: string;
  memory?: string;
}

export function parseCheckResponse(text: string): CheckResult {
  try {
    const data = JSON.parse(text) as {
      state?: unknown;
      status_msg?: unknown;
      status_code?: unknown;
      status_runtime?: unknown;
      status_memory?: unknown;
    };
    if (data.state !== 'SUCCESS') return { finished: false, accepted: false };
    const accepted = data.status_code === 10 || data.status_msg === 'Accepted';
    return {
      finished: true,
      accepted,
      runtime: typeof data.status_runtime === 'string' ? data.status_runtime : undefined,
      memory: typeof data.status_memory === 'string' ? data.status_memory : undefined,
    };
  } catch {
    return { finished: false, accepted: false };
  }
}
