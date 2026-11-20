import type { BranchInfo, RemoteGroup, RepoSnapshot } from '../../types/git';
import { button, createSearchBox, el, icon, type IconName, rebuildPreservingFocus } from './dom';
import type { ExplorerUiState } from './state';
import { filterBranches, NODE_BRANCHES, NODE_REPO_ROOT, remoteNodeKey } from './state';

export interface BranchTreeCallbacks {
  onFilterChange(text: string): void;
  onToggleNode(key: string): void;
  onTogglePin(fullName: string): void;
  onCheckout(branch: BranchInfo): void;
  onToggleSidebar(): void;
}

function repoTitle(snapshot: RepoSnapshot): string {
  return `${snapshot.repoName} (${snapshot.currentBranch})`;
}

function trackingText(branch: BranchInfo): { text: string; title: string; className: string } | null {
  if (branch.ahead > 0 || branch.behind > 0) {
    return {
      text: `\u2191${branch.ahead} / \u2193${branch.behind}`,
      title: `${branch.ahead} outgoing, ${branch.behind} incoming (${branch.upstream ?? 'upstream'})`,
      className: 'tracking',
    };
  }
  if (branch.upstream) {
    return { text: '\u2022', title: `Up to date with ${branch.upstream}`, className: 'tracking tracking-synced' };
  }
  return null;
}

/** Left pane: repository header, branch filter and the Branches / remotes tree. */
export class BranchTree {
  public readonly element: HTMLElement;
  /** Narrow strip shown instead of the pane while the sidebar is collapsed. */
  public readonly collapsedStrip: HTMLElement;

  private readonly titleEl: HTMLElement;
  private readonly search: ReturnType<typeof createSearchBox>;
  private readonly treeEl: HTMLUListElement;
  private checkoutTargets = new Map<string, BranchInfo>();

  constructor(private readonly callbacks: BranchTreeCallbacks) {
    this.titleEl = el('span', { className: 'sidebar-title', text: 'Loading\u2026' });
    const collapse = button({ className: 'icon-button', label: 'Collapse branch pane', icon: 'chevronLeft' });
    collapse.addEventListener('click', () => callbacks.onToggleSidebar());

    this.search = createSearchBox('Filter', (value) => callbacks.onFilterChange(value));
    this.treeEl = el('ul', { className: 'tree', attrs: { role: 'tree', 'aria-label': 'Branches' } });
    this.treeEl.addEventListener('keydown', (event) => this.handleTreeKeydown(event));

    this.element = el('aside', { className: 'pane pane-left', attrs: { 'aria-label': 'Branch explorer' } }, [
      el('div', { className: 'sidebar-header' }, [icon('repo'), this.titleEl, collapse]),
      el('div', { className: 'sidebar-filter' }, [this.search.element]),
      el('div', { className: 'tree-scroll' }, [this.treeEl]),
    ]);

    const expand = button({ className: 'icon-button', label: 'Expand branch pane', icon: 'chevronRight' });
    expand.addEventListener('click', () => callbacks.onToggleSidebar());
    this.collapsedStrip = el('div', { className: 'collapsed-strip' }, [expand]);
  }

  public update(state: ExplorerUiState): void {
    const { snapshot } = state;
    this.titleEl.textContent = snapshot ? repoTitle(snapshot) : state.errorMessage ? 'No repository' : 'Loading\u2026';
    this.titleEl.title = snapshot?.repoRoot ?? '';
    this.search.sync(state.branchFilterText);
    this.checkoutTargets = new Map();

    rebuildPreservingFocus(this.treeEl, () => {
      if (!snapshot) {
        return [this.placeholder(state.errorMessage ? 'Unavailable' : 'Loading\u2026', 0)];
      }
      return [this.renderBranchesNode(snapshot, state)];
    });

    // Roving tabindex: the focused item (or the first one) is the single tab stop.
    const active = document.activeElement;
    const tabStop =
      active instanceof HTMLElement && active.getAttribute('role') === 'treeitem' && this.treeEl.contains(active)
        ? active
        : this.treeEl.querySelector<HTMLElement>('[role="treeitem"]');
    if (tabStop) {
      tabStop.tabIndex = 0;
    }
  }

  private renderBranchesNode(snapshot: RepoSnapshot, state: ExplorerUiState): HTMLLIElement {
    const filtering = state.branchFilterText.trim() !== '';
    const isOpen = (key: string): boolean => filtering || state.expandedNodes.has(key);

    const locals = filterBranches(snapshot.localBranches, state.branchFilterText);
    const localItems =
      locals.length > 0
        ? locals.map((b) => this.renderBranch(b, state, 2))
        : [this.placeholder(filtering ? 'No matching branches' : `${snapshot.currentBranch} (no commits yet)`, 2)];

    const repoNode = this.renderGroup({
      key: NODE_REPO_ROOT,
      label: repoTitle(snapshot),
      iconName: 'repo',
      depth: 1,
      open: isOpen(NODE_REPO_ROOT),
      children: localItems,
    });

    const remoteNodes = snapshot.remoteGroups
      .map((group) => this.renderRemote(group, state, filtering, isOpen))
      .filter((node): node is HTMLLIElement => node !== null);

    return this.renderGroup({
      key: NODE_BRANCHES,
      label: 'Branches',
      iconName: null,
      depth: 0,
      open: isOpen(NODE_BRANCHES),
      children: [repoNode, ...remoteNodes],
    });
  }

  private renderRemote(
    group: RemoteGroup,
    state: ExplorerUiState,
    filtering: boolean,
    isOpen: (key: string) => boolean,
  ): HTMLLIElement | null {
    const branches = filterBranches(group.branches, state.branchFilterText);
    if (filtering && branches.length === 0) {
      return null;
    }
    const key = remoteNodeKey(group.remoteName);
    return this.renderGroup({
      key,
      label: `remotes/${group.remoteName}`,
      iconName: 'remote',
      depth: 1,
      open: isOpen(key),
      children: branches.map((b) => this.renderBranch(b, state, 2)),
    });
  }

  private renderGroup(options: {
    key: string;
    label: string;
    iconName: IconName | null;
    depth: number;
    open: boolean;
    children: HTMLLIElement[];
  }): HTMLLIElement {
    const row = el('div', { className: `tree-row depth-${options.depth}` }, [
      icon(options.open ? 'chevronDown' : 'chevronRight', 'icon twisty'),
      ...(options.iconName ? [icon(options.iconName)] : []),
      el('span', { className: 'tree-label', text: options.label, title: options.label }),
    ]);
    row.addEventListener('click', () => this.callbacks.onToggleNode(options.key));

    const item = el(
      'li',
      {
        className: 'tree-node tree-group',
        attrs: {
          role: 'treeitem',
          'aria-expanded': String(options.open),
          'aria-level': String(options.depth + 1),
          'aria-label': options.label,
          tabindex: '-1',
          'data-focus-key': `group:${options.key}`,
          'data-node-key': options.key,
        },
      },
      [row],
    );
    if (options.open) {
      item.append(el('ul', { className: 'tree', attrs: { role: 'group' } }, options.children));
    }
    return item;
  }

  private renderBranch(branch: BranchInfo, state: ExplorerUiState, depth: number): HTMLLIElement {
    const pinned = state.pinnedBranchFullNames.has(branch.fullName);
    const canCheckout = !branch.isRemote && !branch.isCurrent;

    const eye = button({
      className: pinned ? 'icon-button eye-toggle active' : 'icon-button eye-toggle',
      label: pinned ? `Stop isolating ${branch.name} in history` : `Show only ${branch.name} in history`,
      icon: 'eye',
      attrs: { 'aria-pressed': String(pinned), tabindex: '-1' },
    });
    eye.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.onTogglePin(branch.fullName);
    });
    eye.addEventListener('dblclick', (event) => event.stopPropagation());

    const tracking = trackingText(branch);
    const tooltip = [branch.fullName, branch.upstream ? `Tracking ${branch.upstream}` : null, canCheckout ? 'Double-click to check out' : null]
      .filter((line): line is string => line !== null)
      .join('\n');

    const row = el('div', { className: `tree-row depth-${depth}${branch.isCurrent ? ' current-branch' : ''}`, title: tooltip }, [
      el('span', { className: 'twisty-spacer' }),
      icon('branch'),
      el('span', { className: 'tree-label', text: branch.displayName }),
      ...(tracking ? [el('span', { className: tracking.className, text: tracking.text, title: tracking.title })] : []),
      eye,
    ]);
    if (canCheckout) {
      this.checkoutTargets.set(branch.fullName, branch);
      row.addEventListener('dblclick', () => this.callbacks.onCheckout(branch));
    }

    return el(
      'li',
      {
        className: pinned ? 'tree-node tree-branch pinned' : 'tree-node tree-branch',
        attrs: {
          role: 'treeitem',
          'aria-level': String(depth + 1),
          'aria-label': `${branch.name}${branch.isCurrent ? ' (current)' : ''}${pinned ? ', isolated in history' : ''}`,
          'aria-current': branch.isCurrent ? 'true' : 'false',
          tabindex: '-1',
          'data-focus-key': `branch:${branch.fullName}`,
          'data-full-name': branch.fullName,
        },
      },
      [row],
    );
  }

  private placeholder(text: string, depth: number): HTMLLIElement {
    return el('li', { className: 'tree-node', attrs: { role: 'none' } }, [
      el('div', { className: `tree-row depth-${depth} placeholder`, text }),
    ]);
  }

  /** Arrow keys move between visible items; Enter/Space activate; Left/Right collapse/expand. */
  private handleTreeKeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLLIElement) || target.getAttribute('role') !== 'treeitem') {
      return;
    }
    const items = Array.from(this.treeEl.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const index = items.indexOf(target);
    const nodeKey = target.dataset.nodeKey;
    const fullName = target.dataset.fullName;
    const expanded = target.getAttribute('aria-expanded') === 'true';

    const focusItem = (next: HTMLElement | undefined): void => {
      if (next) {
        items.forEach((item) => (item.tabIndex = -1));
        next.tabIndex = 0;
        next.focus();
      }
    };

    switch (event.key) {
      case 'ArrowDown':
        focusItem(items[index + 1]);
        break;
      case 'ArrowUp':
        focusItem(items[index - 1]);
        break;
      case 'Home':
        focusItem(items[0]);
        break;
      case 'End':
        focusItem(items[items.length - 1]);
        break;
      case 'ArrowRight':
        if (nodeKey && !expanded) {
          this.callbacks.onToggleNode(nodeKey);
        }
        break;
      case 'ArrowLeft':
        if (nodeKey && expanded) {
          this.callbacks.onToggleNode(nodeKey);
        } else {
          focusItem(target.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined);
        }
        break;
      case 'Enter':
        if (nodeKey) {
          this.callbacks.onToggleNode(nodeKey);
        } else if (fullName) {
          const branch = this.checkoutTargets.get(fullName);
          if (branch) {
            this.callbacks.onCheckout(branch);
          }
        }
        break;
      case ' ':
        if (nodeKey) {
          this.callbacks.onToggleNode(nodeKey);
        } else if (fullName) {
          this.callbacks.onTogglePin(fullName);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
