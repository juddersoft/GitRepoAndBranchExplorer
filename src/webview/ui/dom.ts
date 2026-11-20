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
  repo: [
    { tag: 'path', d: 'M3.5 2.5h9v11h-7.5a1.5 1.5 0 0 1-1.5-1.5z' },
    { tag: 'path', d: 'M3.5 12a1.5 1.5 0 0 1 1.5-1.5h7.5' },
  ],
  branch: [
    { tag: 'circle', cx: 5, cy: 3.5, r: 1.5 },
    { tag: 'circle', cx: 5, cy: 12.5, r: 1.5 },
    { tag: 'circle', cx: 11, cy: 5, r: 1.5 },
    { tag: 'path', d: 'M5 5v6' },
    { tag: 'path', d: 'M11 6.5c0 3-6 2.5-6 4.5' },
  ],
  newBranch: [
    { tag: 'circle', cx: 4.5, cy: 3.5, r: 1.5 },
    { tag: 'circle', cx: 4.5, cy: 12.5, r: 1.5 },
    { tag: 'path', d: 'M4.5 5v6' },
    { tag: 'path', d: 'M11.5 3v6M8.5 6h6' },
  ],
  remote: [
    { tag: 'path', d: 'M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.8 0 3 3 0 0 1-.4 6z' },
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
  tag: [
    { tag: 'path', d: 'M2.5 2.5h5l6 6-5 5-6-6z' },
    { tag: 'circle', cx: 5.5, cy: 5.5, r: 1 },
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
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const shape of ICONS[name] as readonly Shape[]) {
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
