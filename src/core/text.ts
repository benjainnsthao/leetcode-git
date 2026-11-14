// Text helpers shared by every part of the extension.

/**
 * Canonical form used for all comparisons: LF line endings, no BOM, no
 * trailing whitespace at the end of the file. This keeps a file saved by a
 * desktop editor (CRLF, final newline) equal to the same code in LeetCode.
 */
export function normalizeCode(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/** What gets written to the repo: canonical text plus one final newline. */
export function toFileContent(text: string): string {
  const n = normalizeCode(text);
  return n === '' ? '' : n + '\n';
}

/** SHA-256 (hex) of the canonical form. Used as the identity of a version. */
export async function hashCode(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeCode(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
