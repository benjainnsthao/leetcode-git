// Reads problem details from LeetCode's own GraphQL endpoint (same origin,
// using the visitor's existing session; nothing is sent anywhere else).

import type { QuestionMeta } from './controller';

const QUERY = `query lcgitQuestion($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionFrontendId
    title
    codeSnippets { langSlug code }
  }
}`;

interface QuestionData {
  questionFrontendId?: unknown;
  title?: unknown;
  codeSnippets?: unknown;
}

/** Turns the GraphQL payload into QuestionMeta. Exported for tests. */
export function parseQuestion(question: QuestionData | null | undefined): QuestionMeta | null {
  if (!question) return null;
  const { questionFrontendId, title, codeSnippets } = question;
  if (typeof questionFrontendId !== 'string' || typeof title !== 'string') return null;
  const templates: Record<string, string> = {};
  if (Array.isArray(codeSnippets)) {
    for (const s of codeSnippets as { langSlug?: unknown; code?: unknown }[]) {
      if (s && typeof s.langSlug === 'string' && typeof s.code === 'string') templates[s.langSlug] = s.code;
    }
  }
  return { frontendId: questionFrontendId, title, templates };
}

export async function fetchQuestionMeta(slug: string): Promise<QuestionMeta | null> {
  try {
    const csrf = /(?:^|;\s*)csrftoken=([^;]+)/.exec(document.cookie)?.[1];
    const res = await fetch('/graphql/', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrftoken': csrf } : {}) },
      body: JSON.stringify({ query: QUERY, variables: { titleSlug: slug }, operationName: 'lcgitQuestion' }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { question?: QuestionData | null } };
    return parseQuestion(json.data?.question);
  } catch {
    return null;
  }
}
