// The drawing model: a list of vector shapes and pure operations on it.
// No DOM here, so all of it is unit-testable.

export type Point = [number, number];

interface Style {
  id: string;
  color: string;
  width: number;
}

export interface PenShape extends Style {
  type: 'pen';
  points: Point[];
}
export interface LineShape extends Style {
  type: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface BoxShape extends Style {
  type: 'rect' | 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Shape = PenShape | LineShape | BoxShape;

function isLine(s: Shape): s is LineShape {
  return s.type === 'line' || s.type === 'arrow';
}
export type ShapeType = Shape['type'];

/** A drawing. Treated as immutable: every edit returns a new Doc. */
export interface Doc {
  shapes: readonly Shape[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The sheet of paper, in drawing units. */
export const PAGE = { width: 1600, height: 1000 } as const;
export const COLORS = ['#1f2328', '#cf222e', '#1a7f37', '#0969da', '#bc4c00', '#8250df'] as const;
export const WIDTHS = [2, 4, 8] as const;
export const EMPTY_DOC: Doc = { shapes: [] };

const MAX_SHAPES = 5000;
const MAX_POINTS = 5000;
const MAX_COORD = 100_000;

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const round = (n: number): number => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- geometry

export function bounds(s: Shape): Box {
  if (s.type === 'pen') {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of s.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (isLine(s)) {
    return {
      x: Math.min(s.x1, s.x2),
      y: Math.min(s.y1, s.y2),
      w: Math.abs(s.x2 - s.x1),
      h: Math.abs(s.y2 - s.y1),
    };
  }
  return { x: s.x, y: s.y, w: s.w, h: s.h };
}

/** Bounding box of several shapes, or null for none. */
export function boundsOf(shapes: readonly Shape[]): Box | null {
  if (shapes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    const b = bounds(s);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a point to the drawn outline of a shape. */
export function distanceToOutline(s: Shape, px: number, py: number): number {
  if (s.type === 'pen') {
    if (s.points.length === 1) return Math.hypot(px - s.points[0][0], py - s.points[0][1]);
    let best = Infinity;
    for (let i = 1; i < s.points.length; i++) {
      const [ax, ay] = s.points[i - 1];
      const [bx, by] = s.points[i];
      best = Math.min(best, distToSegment(px, py, ax, ay, bx, by));
    }
    return best;
  }
  if (isLine(s)) return distToSegment(px, py, s.x1, s.y1, s.x2, s.y2);
  if (s.type === 'rect') {
    const { x, y, w, h } = s;
    return Math.min(
      distToSegment(px, py, x, y, x + w, y),
      distToSegment(px, py, x + w, y, x + w, y + h),
      distToSegment(px, py, x + w, y + h, x, y + h),
      distToSegment(px, py, x, y + h, x, y),
    );
  }
  // Ellipse: approximate by scaling to a circle around its centre.
  const rx = s.w / 2;
  const ry = s.h / 2;
  if (rx === 0 || ry === 0) return distToSegment(px, py, s.x, s.y, s.x + s.w, s.y + s.h);
  const nx = (px - (s.x + rx)) / rx;
  const ny = (py - (s.y + ry)) / ry;
  return Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
}

function contains(s: Shape, px: number, py: number): boolean {
  if (s.type === 'rect') return px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h;
  if (s.type === 'ellipse') {
    const rx = s.w / 2;
    const ry = s.h / 2;
    if (rx === 0 || ry === 0) return false;
    return ((px - (s.x + rx)) / rx) ** 2 + ((py - (s.y + ry)) / ry) ** 2 <= 1;
  }
  return false;
}

/**
 * The shape under a point, for the select tool: an outline within `tolerance`
 * wins (topmost first); otherwise the smallest rectangle or ellipse whose
 * interior contains the point.
 */
export function pick(doc: Doc, px: number, py: number, tolerance: number): Shape | null {
  for (let i = doc.shapes.length - 1; i >= 0; i--) {
    const s = doc.shapes[i];
    if (distanceToOutline(s, px, py) <= tolerance + s.width / 2) return s;
  }
  let best: Shape | null = null;
  let bestArea = Infinity;
  for (const s of doc.shapes) {
    if (!contains(s, px, py)) continue;
    const b = bounds(s);
    if (b.w * b.h < bestArea) {
      best = s;
      bestArea = b.w * b.h;
    }
  }
  return best;
}

/** Shapes lying entirely inside a selection box. */
export function shapesInBox(doc: Doc, box: Box): Shape[] {
  return doc.shapes.filter((s) => {
    const b = bounds(s);
    return b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h;
  });
}

export function normalizeBox(x1: number, y1: number, x2: number, y2: number): Box {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

// ---------------------------------------------------------------- edits

export function translate(s: Shape, dx: number, dy: number): Shape {
  if (s.type === 'pen') return { ...s, points: s.points.map(([x, y]) => [round(x + dx), round(y + dy)] as Point) };
  if (isLine(s)) {
    return { ...s, x1: round(s.x1 + dx), y1: round(s.y1 + dy), x2: round(s.x2 + dx), y2: round(s.y2 + dy) };
  }
  return { ...s, x: round(s.x + dx), y: round(s.y + dy) };
}

export function addShapes(doc: Doc, shapes: readonly Shape[]): Doc {
  if (shapes.length === 0) return doc;
  return { shapes: [...doc.shapes, ...shapes].slice(-MAX_SHAPES) };
}

export function removeShapes(doc: Doc, ids: ReadonlySet<string>): Doc {
  if (ids.size === 0) return doc;
  const shapes = doc.shapes.filter((s) => !ids.has(s.id));
  return shapes.length === doc.shapes.length ? doc : { shapes };
}

export function moveShapes(doc: Doc, ids: ReadonlySet<string>, dx: number, dy: number): Doc {
  if (ids.size === 0 || (dx === 0 && dy === 0)) return doc;
  return { shapes: doc.shapes.map((s) => (ids.has(s.id) ? translate(s, dx, dy) : s)) };
}

export function restyle(doc: Doc, ids: ReadonlySet<string>, style: { color?: string; width?: number }): Doc {
  if (ids.size === 0) return doc;
  let changed = false;
  const shapes = doc.shapes.map((s) => {
    if (!ids.has(s.id)) return s;
    const next = { ...s, ...style };
    if (next.color !== s.color || next.width !== s.width) changed = true;
    return next;
  });
  return changed ? { shapes } : doc;
}

/** Copies of the given shapes with fresh ids, shifted by (dx, dy). */
export function duplicate(shapes: readonly Shape[], dx: number, dy: number): Shape[] {
  return shapes.map((s) => ({ ...translate(s, dx, dy), id: newId() }));
}

/** Removes every shape whose outline passes within `radius` of the point. */
export function eraseAt(doc: Doc, px: number, py: number, radius: number): Doc {
  const hit = new Set<string>();
  for (const s of doc.shapes) {
    if (distanceToOutline(s, px, py) <= radius + s.width / 2) hit.add(s.id);
  }
  return removeShapes(doc, hit);
}

/** Thins out a freehand stroke: drops points closer than `minGap` to the last kept one. */
export function simplify(points: readonly Point[], minGap = 1.5): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p: Point = [round(points[i][0]), round(points[i][1])];
    const last = out[out.length - 1];
    const isEnd = i === points.length - 1;
    if (!last) out.push(p);
    else if (last[0] === p[0] && last[1] === p[1]) continue;
    else if (isEnd || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minGap) out.push(p);
  }
  return out.slice(0, MAX_POINTS);
}

// ---------------------------------------------------------------- validation

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;
}

/** Checks data read from a file. Returns a clean Shape, or null if unusable. */
export function validateShape(raw: unknown): Shape | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id)) return null;
  if (typeof r.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(r.color)) return null;
  if (!num(r.width) || r.width < 0.5 || r.width > 40) return null;
  const style = { id: r.id, color: r.color.toLowerCase(), width: r.width };
  switch (r.type) {
    case 'pen': {
      if (!Array.isArray(r.points) || r.points.length === 0 || r.points.length > MAX_POINTS) return null;
      const points: Point[] = [];
      for (const p of r.points) {
        if (!Array.isArray(p) || p.length !== 2 || !num(p[0]) || !num(p[1])) return null;
        points.push([p[0], p[1]]);
      }
      return { ...style, type: 'pen', points };
    }
    case 'line':
    case 'arrow':
      if (!num(r.x1) || !num(r.y1) || !num(r.x2) || !num(r.y2)) return null;
      return { ...style, type: r.type, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 };
    case 'rect':
    case 'ellipse':
      if (!num(r.x) || !num(r.y) || !num(r.w) || !num(r.h) || r.w < 0 || r.h < 0) return null;
      return { ...style, type: r.type, x: r.x, y: r.y, w: r.w, h: r.h };
    default:
      return null;
  }
}

/** Validates a list of shapes, dropping unusable entries and duplicate ids. */
export function validateShapes(raw: unknown): Shape[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_SHAPES) return null;
  const seen = new Set<string>();
  const out: Shape[] = [];
  for (const item of raw) {
    const s = validateShape(item);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- undo / redo

export class History {
  private past: Doc[] = [];
  private future: Doc[] = [];

  constructor(private current: Doc = EMPTY_DOC) {}

  get doc(): Doc {
    return this.current;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Records an edit. Returns false if nothing changed. */
  commit(doc: Doc): boolean {
    if (doc === this.current) return false;
    this.past.push(this.current);
    if (this.past.length > 200) this.past.shift();
    this.current = doc;
    this.future = [];
    return true;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.current);
    this.current = prev;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.current);
    this.current = next;
    return true;
  }
}
