export interface ElementOptions {
  className?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
}

/** Creates an element; all text goes through `textContent`, never HTML parsing. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) {
    node.className = options.className;
  }
  if (options.title) {
    node.title = options.title;
  }
  if (options.text !== undefined) {
    node.textContent = options.text;
  }
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

export function button(options: ElementOptions & { label: string; icon?: IconName; showLabel?: boolean }): HTMLButtonElement {
  const btn = el('button', { className: options.className, title: options.title ?? options.label, attrs: options.attrs });
  btn.type = 'button';
  btn.setAttribute('aria-label', options.label);
  if (options.icon) {
    btn.append(icon(options.icon));
  }
  if (options.showLabel) {
    btn.append(el('span', { className: 'button-label', text: options.label }));
  }
  return btn;
}

type Shape =
  | { tag: 'path'; d: string }
  | { tag: 'circle'; cx: number; cy: number; r: number }
  | { tag: 'rect'; x: number; y: number; width: number; height: number; rx?: number };

// Static 16x16 stroke icons drawn with currentColor so they follow the theme.
const ICONS = {
  newBranch: [
    { tag: 'circle', cx: 4.5, cy: 3.5, r: 1.5 },
    { tag: 'circle', cx: 4.5, cy: 12.5, r: 1.5 },
    { tag: 'path', d: 'M4.5 5v6' },
    { tag: 'path', d: 'M11.5 3v6M8.5 6h6' },
  ],
  eye: [
    { tag: 'path', d: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z' },
    { tag: 'circle', cx: 8, cy: 8, r: 2 },
  ],
  fetch: [{ tag: 'path', d: 'M8 2v7M5 6l3 3 3-3M2.5 10.5v3h11v-3' }],
  pull: [{ tag: 'path', d: 'M8 2v10M4 8l4 4 4-4M3 14h10' }],
  push: [{ tag: 'path', d: 'M8 14V4M4 8l4-4 4 4M3 2h10' }],
  refresh: [{ tag: 'path', d: 'M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3' }],
  chevronLeft: [{ tag: 'path', d: 'M10 3 5 8l5 5' }],
  chevronRight: [{ tag: 'path', d: 'M6 3l5 5-5 5' }],
  chevronDown: [{ tag: 'path', d: 'M3 6l5 5 5-5' }],
  close: [{ tag: 'path', d: 'M4 4l8 8M12 4l-8 8' }],
  copy: [
    { tag: 'rect', x: 5.5, y: 5.5, width: 8, height: 8, rx: 1 },
    { tag: 'path', d: 'M3 10.5V3.5a1 1 0 0 1 1-1h6.5' },
  ],
  search: [
    { tag: 'circle', cx: 7, cy: 7, r: 4 },
    { tag: 'path', d: 'M10 10l3.5 3.5' },
  ],
  graph: [
    { tag: 'circle', cx: 4, cy: 3.5, r: 1.5 },
    { tag: 'circle', cx: 4, cy: 12.5, r: 1.5 },
    { tag: 'circle', cx: 12, cy: 8, r: 1.5 },
    { tag: 'path', d: 'M4 5v6M5.2 4.4 10.8 7.1M10.8 8.9 5.2 11.6' },
  ],
  linkExternal: [{ tag: 'path', d: 'M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v4H2.5V4h4' }],
  file: [{ tag: 'path', d: 'M4 1.5h5l3.5 3.5v9.5H4zM9 1.5V5h3.5' }],
  openFile: [
    { tag: 'path', d: 'M3.5 1.5h5L12 5v4M8.5 1.5V5H12M3.5 1.5v13h5' },
    { tag: 'path', d: 'M9 11.5h5M12 9.5l2 2-2 2' },
  ],
  pin: [{ tag: 'path', d: 'M6 2.5h4M7 2.5v4L5 9h6L9 6.5v-4M8 9v4.5' }],
} satisfies Record<string, Shape[]>;

const SVG_NS = 'http://www.w3.org/2000/svg';
type ColoredIconName = 'repo' | 'branch' | 'remote' | 'folder' | 'folderOpen' | 'check' | 'tag';
export type IconName = keyof typeof ICONS | ColoredIconName;

type SvgAttributes = Record<string, string | number>;

function appendSvgShape<K extends keyof SVGElementTagNameMap>(
  svg: SVGSVGElement,
  tag: K,
  attributes: SvgAttributes,
): SVGElementTagNameMap[K] {
  const shape = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    shape.setAttribute(name, String(value));
  }
  svg.append(shape);
  return shape;
}

const COLORED_ICONS: Record<ColoredIconName, (svg: SVGSVGElement) => void> = {
  folder: (svg) => {
    appendSvgShape(svg, 'path', { d: 'M1.5 4h4l1.4-1.8h6.6l1 1.8v9.5h-13z', fill: '#C68A2B' });
    appendSvgShape(svg, 'rect', { x: 5.1, y: 1.9, width: 4.1, height: 5, rx: 0.4, fill: '#F3F6FA' });
    appendSvgShape(svg, 'path', { d: 'M9.2 2.3h2.2l.9 1v3.1H9.2z', fill: '#5CA8E6' });
    appendSvgShape(svg, 'path', { d: 'M1.5 5.2h13v8.3h-13z', fill: '#E5B55C' });
    appendSvgShape(svg, 'path', { d: 'M2 5.2h12', fill: 'none', stroke: '#F4D38B', 'stroke-width': 0.9 });
  },
  folderOpen: (svg) => {
    appendSvgShape(svg, 'path', { d: 'M1.5 3.8h4l1.4-1.6h6.6l1 1.8v8.9H1.5z', fill: '#C68A2B' });
    appendSvgShape(svg, 'rect', { x: 4.6, y: 2.1, width: 3.8, height: 5.1, rx: 0.4, fill: '#F3F6FA' });
    appendSvgShape(svg, 'path', { d: 'M8.3 2.2h2.1l.8 1v3H8.3z', fill: '#5CA8E6' });
    appendSvgShape(svg, 'path', { d: 'M10.8 2.1h1.6l.7.9v4.2h-2.3z', fill: '#E07A5F' });
    appendSvgShape(svg, 'path', { d: 'M1.5 6h13l-2 7.5H3.2z', fill: '#EBC06A' });
    appendSvgShape(svg, 'path', { d: 'M2.1 6h11.6', fill: 'none', stroke: '#F4D38B', 'stroke-width': 0.9 });
  },
  remote: (svg) => {
    appendSvgShape(svg, 'path', { d: 'M3.5 13.2a3 3 0 0 1-.3-6 4.5 4.5 0 0 1 8.4-.9 3.5 3.5 0 0 1 .8 6.9z', fill: '#3B82C4' });
    appendSvgShape(svg, 'path', { d: 'M3.7 12.2a2.5 2.5 0 0 1-.2-5 4 4 0 0 1 7.5-.7 3 3 0 0 1 .8 5.7z', fill: '#7CC4FA' });
    appendSvgShape(svg, 'path', { d: 'M4.1 7.7a2.9 2.9 0 0 1 5.6-1.1 2.1 2.1 0 0 1 2.9 1.8 2.3 2.3 0 0 0-1.7-.7 4 4 0 0 0-6.8 0z', fill: '#D8EEFF' });
  },
  branch: (svg) => {
    appendSvgShape(svg, 'path', { d: 'M4.5 5v6M4.5 10.2c0-2.5 6-1.5 6-5.1', fill: 'none', stroke: '#6CB6FF', 'stroke-width': 1.8, 'stroke-linecap': 'round' });
    for (const [cx, cy] of [[4.5, 3.4], [4.5, 12.6], [10.5, 4.1]]) {
      appendSvgShape(svg, 'circle', { cx, cy, r: 1.8, fill: '#4EC9B0', stroke: '#277E73', 'stroke-width': 0.7 });
      appendSvgShape(svg, 'circle', { cx: cx - 0.45, cy: cy - 0.45, r: 0.45, fill: '#B8F3E7' });
    }
  },
  check: (svg) => {
    appendSvgShape(svg, 'circle', { cx: 8, cy: 8, r: 6.2, fill: '#2EA043' });
    appendSvgShape(svg, 'circle', { cx: 7.2, cy: 7.2, r: 4.6, fill: '#3FB950' });
    appendSvgShape(svg, 'path', { d: 'M4.7 8.1 7 10.4l4.5-5', fill: 'none', stroke: '#FFFFFF', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  },
  tag: (svg) => {
    appendSvgShape(svg, 'path', { d: 'M2 2.2h5.5l6.3 6.2-5.4 5.4-6.4-6.3z', fill: '#A67014' });
    appendSvgShape(svg, 'path', { d: 'M2.2 2.4h5l5.8 5.8-4.6 4.6-6.2-6z', fill: '#D99B26' });
    appendSvgShape(svg, 'circle', { cx: 5.1, cy: 5.1, r: 1.2, fill: '#FFF4D6', stroke: '#A67014', 'stroke-width': 0.5 });
  },
  repo: (svg) => {
    appendSvgShape(svg, 'path', { d: 'M3 2h10v11.5H5a2 2 0 0 1-2-2z', fill: '#4B8BBE' });
    appendSvgShape(svg, 'path', { d: 'M4.6 2h1.8v9H5.1a1.4 1.4 0 0 0-1.1.5V3z', fill: '#A8D1F0' });
    appendSvgShape(svg, 'path', { d: 'M4.8 11h8.2v2.5H4.9a1.2 1.2 0 0 1 0-2.5z', fill: '#A8D1F0' });
  },
};

export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  const builder = Object.prototype.hasOwnProperty.call(COLORED_ICONS, name)
    ? COLORED_ICONS[name as ColoredIconName]
    : undefined;
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', builder ? 'none' : 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (builder) {
    builder(svg);
    return svg;
  }
  for (const shape of ICONS[name as keyof typeof ICONS] as readonly Shape[]) {
    const node = document.createElementNS(SVG_NS, shape.tag);
    for (const [attr, value] of Object.entries(shape)) {
      if (attr !== 'tag') {
        node.setAttribute(attr, String(value));
      }
    }
    svg.append(node);
  }
  return svg;
}

/** A text input with a clear (×) button that appears only when the input has a value. */
export function createSearchBox(
  placeholder: string,
  onChange: (value: string) => void,
): { element: HTMLElement; input: HTMLInputElement; sync(value: string): void } {
  const input = el('input', { className: 'search-input', attrs: { type: 'search', placeholder, 'aria-label': placeholder, spellcheck: 'false' } });
  const clear = button({ className: 'icon-button search-clear', label: 'Clear filter', icon: 'close' });
  const element = el('div', { className: 'search-box' }, [icon('search', 'icon search-icon'), input, clear]);

  const sync = (value: string): void => {
    if (input.value !== value) {
      input.value = value;
    }
    clear.hidden = value.length === 0;
  };

  input.addEventListener('input', () => onChange(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && input.value !== '') {
      event.stopPropagation();
      onChange('');
    }
  });
  clear.addEventListener('click', () => {
    onChange('');
    input.focus();
  });
  sync('');
  return { element, input, sync };
}

/** Rebuilds `container` and restores focus to the element carrying the same `data-focus-key`. */
export function rebuildPreservingFocus(container: HTMLElement, build: () => Node[]): void {
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement && container.contains(active) ? active.dataset.focusKey : undefined;
  container.replaceChildren(...build());
  if (focusKey === undefined) {
    return;
  }
  for (const candidate of Array.from(container.querySelectorAll<HTMLElement>('[data-focus-key]'))) {
    if (candidate.dataset.focusKey === focusKey) {
      candidate.focus();
      return;
    }
  }
}
