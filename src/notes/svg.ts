// The on-disk format of a note: a plain SVG picture (so GitHub shows it as an
// image) that also carries the exact drawing data in a <metadata> block, so
// the note can be reopened and edited.
//
// Reading goes through that data only. SVG markup from a file is never put
// into the page.

import { PAGE, validateShapes, type Doc, type Shape } from './model';

export interface NoteMeta {
  /** When the session began (ISO 8601). */
  startedAt: string;
  /** When the note was last saved (ISO 8601). */
  savedAt: string;
}

export interface Note {
  doc: Doc;
  meta: NoteMeta;
}

export interface SvgElement {
  tag: 'path' | 'line' | 'rect' | 'ellipse' | 'polygon';
  attrs: Record<string, string>;
}

const METADATA_ID = 'lcgit-notes';
const MAX_FILE = 2_000_000;

const n = (v: number): string => String(Math.round(v * 10) / 10);

/** The SVG elements that draw one shape. Shared by the file writer and the on-screen renderer. */
export function elementsFor(s: Shape): SvgElement[] {
  const stroke = { stroke: s.color, 'stroke-width': n(s.width) };
  switch (s.type) {
    case 'pen': {
      const [first, ...rest] = s.points;
      // A single point still needs a segment so round line caps draw a dot.
      const tail = rest.length ? rest : [first];
      const d = `M${n(first[0])} ${n(first[1])}` + tail.map(([x, y]) => `L${n(x)} ${n(y)}`).join('');
      return [{ tag: 'path', attrs: { d, ...stroke } }];
    }
    case 'line':
      return [{ tag: 'line', attrs: { x1: n(s.x1), y1: n(s.y1), x2: n(s.x2), y2: n(s.y2), ...stroke } }];
    case 'arrow': {
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const head = 8 + s.width * 2.5;
      const spread = 0.42;
      const length = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      // Stop the shaft inside the head so its round cap does not poke through the tip.
      const inset = Math.min(head * 0.7, length);
      const sx = s.x2 - inset * Math.cos(angle);
      const sy = s.y2 - inset * Math.sin(angle);
      const ax = s.x2 - head * Math.cos(angle - spread);
      const ay = s.y2 - head * Math.sin(angle - spread);
      const bx = s.x2 - head * Math.cos(angle + spread);
      const by = s.y2 - head * Math.sin(angle + spread);
      return [
        { tag: 'line', attrs: { x1: n(s.x1), y1: n(s.y1), x2: n(sx), y2: n(sy), ...stroke } },
        {
          tag: 'polygon',
          attrs: {
            points: `${n(s.x2)},${n(s.y2)} ${n(ax)},${n(ay)} ${n(bx)},${n(by)}`,
            fill: s.color,
            stroke: s.color,
            'stroke-width': '1',
          },
        },
      ];
    }
    case 'rect':
      return [{ tag: 'rect', attrs: { x: n(s.x), y: n(s.y), width: n(s.w), height: n(s.h), ...stroke } }];
    case 'ellipse':
      return [
        {
          tag: 'ellipse',
          attrs: { cx: n(s.x + s.w / 2), cy: n(s.y + s.h / 2), rx: n(s.w / 2), ry: n(s.h / 2), ...stroke },
        },
      ];
  }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

export function toSvg(doc: Doc, meta: NoteMeta): string {
  const data = JSON.stringify({ v: 1, startedAt: meta.startedAt, savedAt: meta.savedAt, shapes: doc.shapes });
  const body = doc.shapes
    .flatMap(elementsFor)
    .map(
      (e) =>
        `    <${e.tag} ${Object.entries(e.attrs)
          .map(([k, v]) => `${k}="${escapeXml(v)}"`)
          .join(' ')}/>`,
    )
    .join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE.width} ${PAGE.height}" width="${PAGE.width}" height="${PAGE.height}">`,
    `  <metadata id="${METADATA_ID}">${escapeXml(data)}</metadata>`,
    `  <rect width="${PAGE.width}" height="${PAGE.height}" fill="#ffffff"/>`,
    `  <g fill="none" stroke-linecap="round" stroke-linejoin="round">`,
    ...(body ? [body] : []),
    `  </g>`,
    `</svg>`,
    '',
  ].join('\n');
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

/** Reads a note file. Returns null if it is not a note this extension wrote. */
export function fromSvg(text: string): Note | null {
  if (typeof text !== 'string' || text.length > MAX_FILE) return null;
  const m = new RegExp(`<metadata id="${METADATA_ID}">([\\s\\S]*?)</metadata>`).exec(text);
  if (!m) return null;
  let data: unknown;
  try {
    data = JSON.parse(unescapeXml(m[1]));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.v !== 1 || !isIsoDate(d.startedAt) || !isIsoDate(d.savedAt)) return null;
  const shapes = validateShapes(d.shapes);
  if (!shapes) return null;
  return { doc: { shapes }, meta: { startedAt: d.startedAt, savedAt: d.savedAt } };
}
