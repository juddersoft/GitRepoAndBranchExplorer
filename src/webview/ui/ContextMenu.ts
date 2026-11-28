import { el } from './dom';
import type { MenuActionId, MenuEntry } from './contextMenuModel';
import { clampMenuPosition } from './contextMenuModel';

/** Theme-styled popup menu (`--vscode-menu-*`), built with DOM APIs only so it is CSP-safe. */
export class ContextMenu {
  private root: HTMLElement | null = null;
  private returnFocus: HTMLElement | null = null;
  private teardown: Array<() => void> = [];

  public get isOpen(): boolean {
    return this.root !== null;
  }

  public show(x: number, y: number, entries: readonly MenuEntry[], onSelect: (id: MenuActionId) => void): void {
    this.close(false);
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;

    const items: HTMLButtonElement[] = [];
    const children = entries.map((entry) => {
      if (entry.kind === 'separator') {
        return el('div', { className: 'context-menu-separator', attrs: { role: 'separator' } });
      }
      const row = el(
        'button',
        {
          className: `${entry.enabled ? 'context-menu-item' : 'context-menu-item disabled'}${entry.danger ? ' danger' : ''}`,
          title: entry.reason ?? '',
          attrs: { type: 'button', role: 'menuitem', 'aria-disabled': String(!entry.enabled), tabindex: '-1' },
        },
        [el('span', { className: 'context-menu-label', text: entry.label })],
      );
      if (!entry.enabled && entry.reason) {
        row.append(el('span', { className: 'context-menu-hint', text: entry.reason }));
      }
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!entry.enabled) {
          return;
        }
        this.close();
        onSelect(entry.id);
      });
      if (entry.enabled) {
        items.push(row);
      }
      return row;
    });

    const root = el('div', { className: 'context-menu', attrs: { role: 'menu' } }, children);
    root.addEventListener('keydown', (event) => this.handleKeydown(event, items));
    root.addEventListener('contextmenu', (event) => event.preventDefault());
    document.body.append(root);
    this.root = root;

    const rect = root.getBoundingClientRect();
    const { left, top } = clampMenuPosition(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight);
    // CSSOM assignment (not a style attribute), so it is permitted by the webview CSP.
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;

    const closeIfOutside = (event: Event): void => {
      if (!(event.target instanceof Node) || !root.contains(event.target)) {
        this.close(false);
      }
    };
    const closeNow = (): void => this.close(false);
    const closeOnOutsideScroll = (event: Event): void => {
      if (event.target instanceof Node && root.contains(event.target)) {
        return;
      }
      this.close(false);
    };
    document.addEventListener('pointerdown', closeIfOutside, true);
    window.addEventListener('blur', closeNow);
    window.addEventListener('resize', closeNow);
    document.addEventListener('scroll', closeOnOutsideScroll, true);
    this.teardown = [
      () => document.removeEventListener('pointerdown', closeIfOutside, true),
      () => window.removeEventListener('blur', closeNow),
      () => window.removeEventListener('resize', closeNow),
      () => document.removeEventListener('scroll', closeOnOutsideScroll, true),
    ];

    items[0]?.focus();
  }

  public close(restoreFocus = true): void {
    const root = this.root;
    if (root === null) {
      return;
    }
    this.root = null;
    this.teardown.forEach((fn) => fn());
    this.teardown = [];
    root.remove();
    if (restoreFocus && this.returnFocus?.isConnected) {
      this.returnFocus.focus();
    }
    this.returnFocus = null;
  }

  private handleKeydown(event: KeyboardEvent, items: readonly HTMLButtonElement[]): void {
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (next: number): void => {
      if (items.length > 0) {
        items[(next + items.length) % items.length].focus();
      }
    };
    switch (event.key) {
      case 'ArrowDown':
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        focusAt(index < 0 ? items.length - 1 : index - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(items.length - 1);
        break;
      case 'Escape':
        this.close();
        break;
      case 'Tab':
        this.close();
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
}
