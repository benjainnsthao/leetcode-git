// The scratch-paper panel: toolbar, drawing surface, pointer and keyboard
// handling. It edits a Doc (see model.ts) and reports every committed change;
// deciding where and when that is saved is the controller's job.

import type { HistoryEntry, NotesStatus, NotesView } from './controller';
import {
  COLORS,
  EMPTY_DOC,
  History,
  PAGE,
  WIDTHS,
  addShapes,
  bounds,
  duplicate,
  eraseAt,
  moveShapes,
  newId,
  normalizeBox,
  pick,
  removeShapes,
  restyle,
  shapesInBox,
  simplify,
  type Doc,
  type Point,
  type Shape,
} from './model';
import { elementsFor } from './svg';

export interface OverlayCallbacks {
  /** The current session's drawing changed. */
  onChange(doc: Doc): void;
  /** The user closed the panel. */
  onClose(): void;
  /** The user picked an earlier note (null = back to the current one). */
  onPickHistory(name: string | null): void;
  onOpenSettings(): void;
}

type Tool = 'select' | 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'eraser';

type Drag =
  | { kind: 'pen'; points: Point[] }
  | { kind: 'shape'; type: 'line' | 'arrow' | 'rect' | 'ellipse'; start: Point; end: Point }
  | { kind: 'move'; start: Point; base: Doc; moved: boolean }
  | { kind: 'marquee'; start: Point; end: Point; additive: boolean }
  | { kind: 'erase'; base: Doc };

const SVG_NS = 'http://www.w3.org/2000/svg';
const PASTE_OFFSET = 24;

const TOOLS: { tool: Tool; label: string; key: string; icon: string }[] = [
  { tool: 'select', label: 'Select and move', key: 'V', icon: 'M3.5 2.5l9 4.6-3.9 1.2 2.3 4.3-1.6.9-2.3-4.3-2.9 2.8z' },
  { tool: 'pen', label: 'Pen', key: 'P', icon: 'M2.5 13.5l.9-3.6 7.4-7.4 2.7 2.7-7.4 7.4zM9.6 3.7l2.7 2.7' },
  { tool: 'line', label: 'Line', key: 'L', icon: 'M3 13L13 3' },
  { tool: 'arrow', label: 'Arrow', key: 'A', icon: 'M3 13L13 3M7.5 3H13v5.5' },
  { tool: 'rect', label: 'Rectangle', key: 'R', icon: 'M2.5 3.5h11v9h-11z' },
  { tool: 'ellipse', label: 'Ellipse', key: 'O', icon: 'M8 3.2c3.3 0 5.8 2.1 5.8 4.8s-2.5 4.8-5.8 4.8S2.2 10.7 2.2 8 4.7 3.2 8 3.2z' },
  { tool: 'eraser', label: 'Eraser', key: 'E', icon: 'M6.2 13L2.6 9.4l6.8-6.8 4 4L7.8 13zM5 7l4 4M6.2 13h7' },
];

const ICONS = {
  undo: 'M6 3.5L2.5 7 6 10.5M3 7h6.2a3.3 3.3 0 010 6.6H7.5',
  redo: 'M10 3.5L13.5 7 10 10.5M13 7H6.8a3.3 3.3 0 000 6.6h1.7',
  clear: 'M3 4.5h10M6.3 4.5V3h3.4v1.5M4.4 4.5l.6 8.5h6l.6-8.5',
  max: 'M3 3h10v10H3z',
  close: 'M4 4l8 8M12 4l-8 8',
};

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed; z-index: 2147483001; display: none; flex-direction: column;
  width: min(1100px, 74vw); height: min(760px, 78vh); min-width: 460px; min-height: 320px;
  resize: both; overflow: hidden;
  color: #e8eaed; background: #24292f; border: 1px solid rgba(255,255,255,.16); border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,.4);
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.panel.open { display: flex; }
.panel.max { left: 12px !important; top: 12px !important; width: calc(100vw - 24px) !important;
  height: calc(100vh - 24px) !important; resize: none; }
.panel:focus { outline: none; }
.head { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px; cursor: move; user-select: none; }
.title { font-weight: 600; font-size: 13px; }
.label { color: #b1bac4; white-space: nowrap; }
.status { margin-left: 4px; padding: 2px 8px; border-radius: 999px; background: none; border: 0; color: #b1bac4;
  font: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; cursor: default; }
.status.ok { color: #3fb950; } .status.warn { color: #d29922; } .status.bad { color: #f85149; }
.status.link { cursor: pointer; text-decoration: underline; }
.spacer { flex: 1; }
.tools { display: flex; align-items: center; gap: 4px; padding: 4px 8px 8px; flex-wrap: wrap; }
.sep { width: 1px; height: 20px; background: rgba(255,255,255,.16); margin: 0 4px; }
button.ic {
  display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;
  color: #e8eaed; background: none; border: 1px solid transparent; border-radius: 6px; cursor: pointer;
}
button.ic:hover { background: #373e47; }
button.ic[aria-pressed="true"] { background: #444c56; border-color: rgba(255,255,255,.28); }
button.ic:disabled { opacity: .35; cursor: default; background: none; }
button.ic svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5;
  stroke-linecap: round; stroke-linejoin: round; }
button.sw { width: 20px; height: 20px; padding: 0; margin: 0 2px; border-radius: 50%;
  border: 2px solid #f6f8fa; cursor: pointer; }
button.sw[aria-pressed="true"] { box-shadow: 0 0 0 2px #24292f, 0 0 0 4px #58a6ff; }
button.wd { width: 28px; height: 28px; padding: 0; background: none; border: 1px solid transparent;
  border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
button.wd:hover { background: #373e47; }
button.wd[aria-pressed="true"] { background: #444c56; border-color: rgba(255,255,255,.28); }
button.wd i { display: block; border-radius: 50%; background: #e8eaed; }
select, button.txt {
  font: inherit; color: #e8eaed; background: #373e47; border: 1px solid rgba(255,255,255,.16);
  border-radius: 6px; padding: 4px 8px; cursor: pointer;
}
select { max-width: 220px; }
button.txt:hover { background: #444c56; }
button:focus-visible, select:focus-visible { outline: 2px solid #58a6ff; outline-offset: 1px; }
.pastbar { display: none; align-items: center; gap: 8px; padding: 6px 12px; background: #3a2f0b; color: #f0d98c; }
.pastbar.show { display: flex; }
.wrap { position: relative; flex: 1; min-height: 0; background: #57606a; border-radius: 0 0 9px 9px; }
svg.paper { display: block; width: 100%; height: 100%; touch-action: none; cursor: crosshair; }
svg.paper.t-select { cursor: default; }
svg.paper.t-eraser { cursor: cell; }
.loading { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  background: rgba(36,41,47,.6); color: #e8eaed; font-size: 13px; }
.loading.show { display: flex; }
`;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function svgEl(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function iconButton(path: string, label: string): HTMLButtonElement {
  const b = h('button', 'ic');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  const svg = svgEl('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: path }));
  b.append(svg);
  return b;
}

export class NotesOverlay implements NotesView {
  private readonly panel: HTMLElement;
  private readonly paper: SVGSVGElement;
  private readonly shapesLayer: SVGElement;
  private readonly selectionLayer: SVGElement;
  private readonly previewLayer: SVGElement;
  private readonly labelEl: HTMLElement;
  private readonly statusEl: HTMLButtonElement;
  private readonly historySelect: HTMLSelectElement;
  private readonly pastBar: HTMLElement;
  private readonly pastLabel: HTMLElement;
  private readonly loadingEl: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly colorButtons = new Map<string, HTMLButtonElement>();
  private readonly widthButtons = new Map<number, HTMLButtonElement>();
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly clearBtn: HTMLButtonElement;

  private history = new History();
  /** An earlier note being viewed read-only, if any. */
  private past: Doc | null = null;
  /** Uncommitted state while moving or erasing. */
  private working: Doc | null = null;
  private tool: Tool = 'pen';
  private color: string = COLORS[0];
  private width: number = WIDTHS[1];
  private selection = new Set<string>();
  private clipboard: Shape[] = [];
  private pasteCount = 0;
  private drag: Drag | null = null;
  private loading = false;
  private opensSettings = false;
  private placed = false;

  constructor(private readonly callbacks: OverlayCallbacks) {
    const host = document.createElement('div');
    host.id = 'lcgit-notes';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;

    this.panel = h('div', 'panel');
    this.panel.tabIndex = -1;
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Scratch-paper notes');

    // ---- header
    const head = h('div', 'head');
    this.labelEl = h('span', 'label');
    this.statusEl = h('button', 'status');
    this.statusEl.type = 'button';
    this.statusEl.setAttribute('role', 'status');
    const maxBtn = iconButton(ICONS.max, 'Maximise');
    const closeBtn = iconButton(ICONS.close, 'Close (Esc)');
    head.append(h('span', 'title', 'Notes'), this.labelEl, this.statusEl, h('span', 'spacer'), maxBtn, closeBtn);

    // ---- toolbar
    const tools = h('div', 'tools');
    for (const t of TOOLS) {
      const b = iconButton(t.icon, `${t.label} (${t.key})`);
      b.dataset.tool = t.tool;
      b.addEventListener('click', () => this.setTool(t.tool));
      this.toolButtons.set(t.tool, b);
      tools.append(b);
    }
    tools.append(h('span', 'sep'));
    for (const c of COLORS) {
      const b = h('button', 'sw');
      b.type = 'button';
      b.style.background = c;
      b.title = `Colour ${c}`;
      b.setAttribute('aria-label', `Colour ${c}`);
      b.addEventListener('click', () => this.setColor(c));
      this.colorButtons.set(c, b);
      tools.append(b);
    }
    tools.append(h('span', 'sep'));
    for (const w of WIDTHS) {
      const b = h('button', 'wd');
      b.type = 'button';
      b.title = `Thickness ${w}`;
      b.setAttribute('aria-label', `Thickness ${w}`);
      const dot = h('i');
      dot.style.width = dot.style.height = `${w + 3}px`;
      b.append(dot);
      b.addEventListener('click', () => this.setWidth(w));
      this.widthButtons.set(w, b);
      tools.append(b);
    }
    tools.append(h('span', 'sep'));
    this.undoBtn = iconButton(ICONS.undo, 'Undo (Ctrl+Z)');
    this.redoBtn = iconButton(ICONS.redo, 'Redo (Ctrl+Shift+Z)');
    this.clearBtn = iconButton(ICONS.clear, 'Clear the page');
    this.undoBtn.addEventListener('click', () => this.undo());
    this.redoBtn.addEventListener('click', () => this.redo());
    this.clearBtn.addEventListener('click', () => this.clear());
    this.historySelect = h('select');
    this.historySelect.title = 'Earlier notes for this problem';
    this.historySelect.setAttribute('aria-label', 'Notes history');
    this.historySelect.addEventListener('change', () => {
      const name = this.historySelect.value;
      if (name === '') this.backToCurrent();
      this.callbacks.onPickHistory(name === '' ? null : name);
      this.panel.focus();
    });
    tools.append(this.undoBtn, this.redoBtn, this.clearBtn, h('span', 'spacer'), this.historySelect);

    // ---- read-only bar
    this.pastBar = h('div', 'pastbar');
    this.pastLabel = h('span');
    const copyAll = h('button', 'txt', 'Copy all into current');
    copyAll.type = 'button';
    const back = h('button', 'txt', 'Back to current');
    back.type = 'button';
    this.pastBar.append(this.pastLabel, h('span', 'spacer'), copyAll, back);
    copyAll.addEventListener('click', () => this.copyAllIntoCurrent());
    back.addEventListener('click', () => {
      this.backToCurrent();
      this.callbacks.onPickHistory(null);
    });

    // ---- paper
    const wrap = h('div', 'wrap');
    this.paper = svgEl('svg', {
      class: 'paper',
      viewBox: `-20 -20 ${PAGE.width + 40} ${PAGE.height + 40}`,
      role: 'img',
      'aria-label': 'Drawing area',
    }) as SVGSVGElement;
    this.shapesLayer = svgEl('g', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    this.selectionLayer = svgEl('g', { fill: 'none' });
    this.previewLayer = svgEl('g', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    this.paper.append(
      svgEl('rect', { width: String(PAGE.width), height: String(PAGE.height), fill: '#ffffff' }),
      this.shapesLayer,
      this.selectionLayer,
      this.previewLayer,
    );
    this.loadingEl = h('div', 'loading', 'Loading notes…');
    wrap.append(this.paper, this.loadingEl);

    this.panel.append(head, tools, this.pastBar, wrap);
    root.append(style, this.panel);

    // ---- events
    closeBtn.addEventListener('click', () => this.userClose());
    maxBtn.addEventListener('click', () => this.panel.classList.toggle('max'));
    this.statusEl.addEventListener('click', () => {
      if (this.opensSettings) this.callbacks.onOpenSettings();
    });
    this.enableHeaderDrag(head);
    this.paper.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.paper.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.paper.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.paper.addEventListener('pointercancel', () => this.cancelDrag());
    this.panel.addEventListener('keydown', (e) => this.onKeyDown(e));
    // Keep keystrokes meant for the notes away from the page's own shortcuts.
    for (const type of ['keyup', 'keypress'] as const) {
      this.panel.addEventListener(type, (e) => e.stopPropagation());
    }

    (document.body ?? document.documentElement).append(host);
    this.refreshControls();
  }

  // ------------------------------------------------------------ NotesView

  isOpen(): boolean {
    return this.panel.classList.contains('open');
  }

  open(): void {
    this.panel.classList.add('open');
    if (!this.placed) {
      // Centre it the first time; afterwards it stays where the user put it.
      const r = this.panel.getBoundingClientRect();
      this.panel.style.left = `${Math.max(8, (window.innerWidth - r.width) / 2)}px`;
      this.panel.style.top = `${Math.max(8, (window.innerHeight - r.height) / 2)}px`;
      this.placed = true;
    }
    this.panel.focus();
  }

  close(): void {
    this.cancelDrag();
    this.panel.classList.remove('open');
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.loadingEl.classList.toggle('show', loading);
    if (loading) this.cancelDrag();
  }

  loadCurrent(doc: Doc, label: string): void {
    this.cancelDrag();
    this.history = new History(doc);
    this.past = null;
    this.selection.clear();
    this.labelEl.textContent = label;
    this.pastBar.classList.remove('show');
    this.historySelect.value = '';
    this.render();
  }

  showPast(doc: Doc, label: string): void {
    this.cancelDrag();
    this.past = doc;
    this.selection.clear();
    this.tool = 'select';
    this.pastLabel.textContent = `Viewing ${label} (read-only). Select and Ctrl+C to copy parts of it.`;
    this.pastBar.classList.add('show');
    this.render();
  }

  showCurrent(): void {
    this.backToCurrent();
  }

  setHistory(entries: HistoryEntry[], currentLabel: string): void {
    this.labelEl.textContent = currentLabel;
    const selected = this.historySelect.value;
    this.historySelect.replaceChildren();
    const current = h('option', '', entries.length ? `History (${entries.length})` : 'No earlier notes');
    current.value = '';
    this.historySelect.append(current);
    for (const e of entries) {
      const o = h('option', '', e.label);
      o.value = e.name;
      this.historySelect.append(o);
    }
    this.historySelect.disabled = entries.length === 0;
    this.historySelect.value = this.past && entries.some((e) => e.name === selected) ? selected : '';
  }

  setStatus(status: NotesStatus): void {
    this.statusEl.textContent = status.text;
    this.statusEl.title = status.text;
    this.opensSettings = status.opensSettings === true;
    this.statusEl.className = `status ${status.tone}${this.opensSettings ? ' link' : ''}`;
  }

  // ------------------------------------------------------------ state helpers

  private get readOnly(): boolean {
    return this.past !== null;
  }

  /** What is on screen right now. */
  private get doc(): Doc {
    return this.working ?? this.past ?? this.history.doc;
  }

  private commit(doc: Doc): void {
    this.working = null;
    if (this.readOnly) return;
    if (this.history.commit(doc)) this.callbacks.onChange(this.history.doc);
    this.render();
  }

  private backToCurrent(): void {
    this.cancelDrag();
    this.past = null;
    this.selection.clear();
    this.pastBar.classList.remove('show');
    this.historySelect.value = '';
    this.render();
  }

  private copyAllIntoCurrent(): void {
    if (!this.past) return;
    const copies = duplicate(this.past.shapes, 0, 0);
    this.backToCurrent();
    this.callbacks.onPickHistory(null);
    this.tool = 'select';
    this.selection = new Set(copies.map((s) => s.id));
    this.commit(addShapes(this.history.doc, copies));
  }

  private userClose(): void {
    this.close();
    this.callbacks.onClose();
  }

  private selected(): Shape[] {
    return this.doc.shapes.filter((s) => this.selection.has(s.id));
  }

  // ------------------------------------------------------------ toolbar actions

  private setTool(tool: Tool): void {
    if (this.readOnly && tool !== 'select') return;
    this.cancelDrag();
    this.tool = tool;
    if (tool !== 'select') this.selection.clear();
    this.render();
  }

  private setColor(color: string): void {
    this.color = color;
    if (!this.readOnly && this.selection.size) this.commit(restyle(this.history.doc, this.selection, { color }));
    else this.refreshControls();
  }

  private setWidth(width: number): void {
    this.width = width;
    if (!this.readOnly && this.selection.size) this.commit(restyle(this.history.doc, this.selection, { width }));
    else this.refreshControls();
  }

  private undo(): void {
    if (this.readOnly || this.drag) return;
    if (this.history.undo()) {
      this.callbacks.onChange(this.history.doc);
      this.render();
    }
  }

  private redo(): void {
    if (this.readOnly || this.drag) return;
    if (this.history.redo()) {
      this.callbacks.onChange(this.history.doc);
      this.render();
    }
  }

  private clear(): void {
    if (this.readOnly || this.history.doc.shapes.length === 0) return;
    this.selection.clear();
    this.commit(EMPTY_DOC);
  }

  private copy(): void {
    const shapes = this.selected();
    if (shapes.length === 0) return;
    this.clipboard = shapes;
    this.pasteCount = 0;
  }

  private paste(): void {
    if (this.readOnly || this.clipboard.length === 0) return;
    this.pasteCount++;
    this.insertCopies(this.clipboard, PASTE_OFFSET * this.pasteCount);
  }

  private duplicateSelection(): void {
    if (this.readOnly) return;
    const shapes = this.selected();
    if (shapes.length) this.insertCopies(shapes, PASTE_OFFSET);
  }

  /** Adds copies, selects them and switches to the select tool so they can be dragged into place. */
  private insertCopies(shapes: readonly Shape[], offset: number): void {
    const copies = duplicate(shapes, offset, offset);
    this.tool = 'select';
    this.selection = new Set(copies.map((s) => s.id));
    this.commit(addShapes(this.history.doc, copies));
  }

  private deleteSelection(): void {
    if (this.readOnly || this.selection.size === 0) return;
    const ids = new Set(this.selection);
    this.selection.clear();
    this.commit(removeShapes(this.history.doc, ids));
  }

  private nudge(dx: number, dy: number): void {
    if (this.readOnly || this.selection.size === 0) return;
    this.commit(moveShapes(this.history.doc, this.selection, dx, dy));
  }

  // ------------------------------------------------------------ pointer

  /** Pointer position in drawing units, and how many units one screen pixel is. */
  private locate(e: PointerEvent): { p: Point; unit: number } {
    const ctm = this.paper.getScreenCTM();
    if (!ctm) return { p: [0, 0], unit: 1 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { p: [pt.x, pt.y], unit: 1 / ctm.a };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.loading || this.drag) return;
    e.preventDefault();
    this.panel.focus();
    const { p, unit } = this.locate(e);

    if (this.tool === 'select') {
      const hit = pick(this.doc, p[0], p[1], 6 * unit);
      if (hit) {
        if (e.shiftKey) {
          if (this.selection.has(hit.id)) this.selection.delete(hit.id);
          else this.selection.add(hit.id);
        } else if (!this.selection.has(hit.id)) {
          this.selection = new Set([hit.id]);
        }
        if (!this.readOnly && this.selection.has(hit.id)) {
          this.drag = { kind: 'move', start: p, base: this.history.doc, moved: false };
        }
      } else {
        if (!e.shiftKey) this.selection.clear();
        this.drag = { kind: 'marquee', start: p, end: p, additive: e.shiftKey };
      }
    } else if (this.readOnly) {
      return;
    } else if (this.tool === 'pen') {
      this.drag = { kind: 'pen', points: [p] };
    } else if (this.tool === 'eraser') {
      this.drag = { kind: 'erase', base: this.history.doc };
      this.working = eraseAt(this.history.doc, p[0], p[1], 8 * unit);
    } else {
      this.drag = { kind: 'shape', type: this.tool, start: p, end: p };
    }
    if (this.drag) this.paper.setPointerCapture(e.pointerId);
    this.render();
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const { p, unit } = this.locate(e);
    switch (drag.kind) {
      case 'pen':
        drag.points.push(p);
        this.renderPreview();
        return;
      case 'shape':
        drag.end = p;
        this.renderPreview();
        return;
      case 'marquee':
        drag.end = p;
        this.renderPreview();
        return;
      case 'move': {
        const dx = p[0] - drag.start[0];
        const dy = p[1] - drag.start[1];
        if (!drag.moved && Math.hypot(dx, dy) < 3 * unit) return;
        drag.moved = true;
        this.working = moveShapes(drag.base, this.selection, dx, dy);
        this.render();
        return;
      }
      case 'erase':
        this.working = eraseAt(this.working ?? drag.base, p[0], p[1], 8 * unit);
        this.render();
        return;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (this.paper.hasPointerCapture(e.pointerId)) this.paper.releasePointerCapture(e.pointerId);
    this.previewLayer.replaceChildren();
    const style = { id: newId(), color: this.color, width: this.width };

    switch (drag.kind) {
      case 'pen':
        this.commit(addShapes(this.history.doc, [{ ...style, type: 'pen', points: simplify(drag.points) }]));
        return;
      case 'shape': {
        const shape = this.shapeFromDrag(drag, style);
        if (shape) this.commit(addShapes(this.history.doc, [shape]));
        else this.render();
        return;
      }
      case 'marquee': {
        const box = normalizeBox(drag.start[0], drag.start[1], drag.end[0], drag.end[1]);
        const inside = shapesInBox(this.doc, box).map((s) => s.id);
        this.selection = new Set(drag.additive ? [...this.selection, ...inside] : inside);
        this.render();
        return;
      }
      case 'move':
      case 'erase': {
        const result = this.working;
        this.working = null;
        if (result && result !== drag.base) this.commit(result);
        else this.render();
        return;
      }
    }
  }

  private shapeFromDrag(
    drag: Extract<Drag, { kind: 'shape' }>,
    style: { id: string; color: string; width: number },
  ): Shape | null {
    const [x1, y1] = drag.start;
    const [x2, y2] = drag.end;
    if (Math.hypot(x2 - x1, y2 - y1) < 4) return null; // a stray click, not a shape
    const r = (v: number): number => Math.round(v * 10) / 10;
    if (drag.type === 'line' || drag.type === 'arrow') {
      return { ...style, type: drag.type, x1: r(x1), y1: r(y1), x2: r(x2), y2: r(y2) };
    }
    const b = normalizeBox(x1, y1, x2, y2);
    return { ...style, type: drag.type, x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) };
  }

  private cancelDrag(): void {
    if (!this.drag && !this.working) return;
    this.drag = null;
    this.working = null;
    this.previewLayer.replaceChildren();
    this.render();
  }

  // ------------------------------------------------------------ keyboard

  private onKeyDown(e: KeyboardEvent): void {
    // Whatever the key, it was typed into the notes, not into the page.
    e.stopPropagation();
    if (e.target === this.historySelect) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;

    if (key === 'Escape') {
      if (this.drag || this.working) this.cancelDrag();
      else if (this.selection.size) {
        this.selection.clear();
        this.render();
      } else this.userClose();
    } else if (mod && key === 'z') {
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && key === 'y') this.redo();
    else if (mod && key === 'c') this.copy();
    else if (mod && key === 'x') {
      this.copy();
      this.deleteSelection();
    } else if (mod && key === 'v') this.paste();
    else if (mod && key === 'd') this.duplicateSelection();
    else if (mod && key === 'a') {
      this.tool = 'select';
      this.selection = new Set(this.doc.shapes.map((s) => s.id));
      this.render();
    } else if (key === 'Delete' || key === 'Backspace') this.deleteSelection();
    else if (key.startsWith('Arrow') && this.selection.size) {
      const step = e.shiftKey ? 10 : 1;
      this.nudge(
        key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0,
        key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0,
      );
    } else if (!mod && !e.altKey) {
      const t = TOOLS.find((x) => x.key.toLowerCase() === key);
      if (t) this.setTool(t.tool);
      else handled = false;
    } else handled = false;

    if (handled) e.preventDefault();
  }

  // ------------------------------------------------------------ rendering

  private render(): void {
    // Forget selected shapes that no longer exist (undo, erase, switching notes).
    const doc = this.doc;
    if (this.selection.size) {
      const ids = new Set(doc.shapes.map((s) => s.id));
      for (const id of this.selection) if (!ids.has(id)) this.selection.delete(id);
    }

    this.shapesLayer.replaceChildren(
      ...doc.shapes.flatMap((s) => elementsFor(s).map((e) => svgEl(e.tag, { ...e.attrs, 'data-id': s.id }))),
    );

    this.selectionLayer.replaceChildren(
      ...this.selected().map((s) => {
        const b = bounds(s);
        const pad = 5 + s.width / 2;
        return svgEl('rect', {
          x: String(b.x - pad),
          y: String(b.y - pad),
          width: String(b.w + pad * 2),
          height: String(b.h + pad * 2),
          stroke: '#0969da',
          'stroke-width': '1.5',
          'stroke-dasharray': '6 4',
          'vector-effect': 'non-scaling-stroke',
          class: 'selbox',
        });
      }),
    );
    this.refreshControls();
  }

  private renderPreview(): void {
    const drag = this.drag;
    if (!drag) return;
    const style = { id: 'preview', color: this.color, width: this.width };
    let shape: Shape | null = null;
    if (drag.kind === 'pen') shape = { ...style, type: 'pen', points: drag.points };
    else if (drag.kind === 'shape') shape = this.shapeFromDrag(drag, style);
    else if (drag.kind === 'marquee') {
      const b = normalizeBox(drag.start[0], drag.start[1], drag.end[0], drag.end[1]);
      this.previewLayer.replaceChildren(
        svgEl('rect', {
          x: String(b.x),
          y: String(b.y),
          width: String(b.w),
          height: String(b.h),
          fill: 'rgba(9,105,218,.08)',
          stroke: '#0969da',
          'stroke-width': '1',
          'vector-effect': 'non-scaling-stroke',
        }),
      );
      return;
    }
    this.previewLayer.replaceChildren(...(shape ? elementsFor(shape).map((e) => svgEl(e.tag, e.attrs)) : []));
  }

  private refreshControls(): void {
    const ro = this.readOnly;
    for (const [tool, b] of this.toolButtons) {
      b.setAttribute('aria-pressed', String(tool === this.tool));
      b.disabled = ro && tool !== 'select';
    }
    for (const [color, b] of this.colorButtons) {
      b.setAttribute('aria-pressed', String(color === this.color));
      b.disabled = ro;
    }
    for (const [width, b] of this.widthButtons) {
      b.setAttribute('aria-pressed', String(width === this.width));
      b.disabled = ro;
    }
    this.undoBtn.disabled = ro || !this.history.canUndo;
    this.redoBtn.disabled = ro || !this.history.canRedo;
    this.clearBtn.disabled = ro || this.history.doc.shapes.length === 0;
    this.paper.setAttribute('class', `paper t-${this.tool}`);
  }

  // ------------------------------------------------------------ moving the panel

  private enableHeaderDrag(head: HTMLElement): void {
    let origin: { x: number; y: number; left: number; top: number } | null = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button') || this.panel.classList.contains('max')) return;
      const r = this.panel.getBoundingClientRect();
      origin = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!origin) return;
      const r = this.panel.getBoundingClientRect();
      const left = Math.min(window.innerWidth - 80, Math.max(80 - r.width, origin.left + e.clientX - origin.x));
      const top = Math.min(window.innerHeight - 40, Math.max(0, origin.top + e.clientY - origin.y));
      this.panel.style.left = `${left}px`;
      this.panel.style.top = `${top}px`;
    });
    const stop = (e: PointerEvent): void => {
      origin = null;
      if (head.hasPointerCapture(e.pointerId)) head.releasePointerCapture(e.pointerId);
    };
    head.addEventListener('pointerup', stop);
    head.addEventListener('pointercancel', stop);
  }
}
