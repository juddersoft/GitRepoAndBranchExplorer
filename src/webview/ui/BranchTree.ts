import type { BranchInfo, RemoteGroup, RepoSnapshot, StashInfo, TagInfo, WorktreeInfo } from '../../types/git';
import type { TrackingIndicatorOrder } from '../../types/messages';
import { buildBranchFolderTree, type BranchTreeNode } from './branchFolderTree';
import { button, createSearchBox, el, icon, type IconName, rebuildPreservingFocus } from './dom';
import { computeCheckedOutPillLayout, MIN_READABLE_PILL_SCALE } from './pillLayout';
import type { ExplorerUiState, RefTarget, TrackingSummary } from './state';
import {
  branchRefTarget,
  filterBranches,
  filterTags,
  NODE_BRANCHES,
  NODE_STASHES,
  NODE_TAGS,
  normalizeRepoKey,
  remoteNodeKey,
  repoNodeKey,
  tagRefTarget,
  trackingSummary,
} from './state';

export interface BranchTreeCallbacks {
  onFilterChange(text: string): void;
  onToggleNode(key: string): void;
  onTogglePin(fullName: string): void;
  onCheckout(branch: BranchInfo): void;
  /** Single-click / Enter: inspect this ref and focus the history on it. */
  onSelectRef(target: RefTarget): void;
  onContextMenu(target: RefTarget, x: number, y: number): void;
  onWorktreeContextMenu(worktree: WorktreeInfo, x: number, y: number): void;
  onOpenWorktree(worktreePath: string): void;
  onInspectStash(stash: StashInfo): void;
  onStashContextMenu(stash: StashInfo, x: number, y: number): void;
  /** Right-click / Shift+F10 / Menu key on the repository row. */
  onRepoContextMenu(x: number, y: number): void;
  onSelectRepository(repoRoot: string): void;
  onSettingsMenu(x: number, y: number): void;
  onCloneRepository(): void;
  /** Reopens the editor timeline tab (for when it was closed while the tree is still showing). */
  onOpenTimeline(): void;
}

export function getTrackingOrderSequence(
  order: TrackingIndicatorOrder,
): readonly ['down', 'up'] | readonly ['up', 'down'] {
  return order === 'visualStudio' ? ['up', 'down'] : ['down', 'up'];
}

export type RepoNodeKeyboardAction = 'toggle' | 'select' | 'menu';

export function getRepoNodeKeyboardAction(
  key: string,
  active: boolean,
  shiftKey = false,
): RepoNodeKeyboardAction | null {
  if (key === 'Enter' || key === ' ') {
    return active ? 'toggle' : 'select';
  }
  if (active && (key === 'ContextMenu' || (key === 'F10' && shiftKey))) {
    return 'menu';
  }
  return null;
}

/** Explicit ahead/behind indicator, ordered for VS Code or Visual Studio. */
function trackingElement(summary: TrackingSummary, order: TrackingIndicatorOrder): HTMLElement {
  const indicators = {
    up: el('span', { className: 'tracking-up', text: summary.up }),
    down: el('span', { className: 'tracking-down', text: summary.down }),
  };
  return el(
    'span',
    { className: `tracking tracking-${summary.kind}`, title: summary.title, attrs: { role: 'img', 'aria-label': summary.label } },
    getTrackingOrderSequence(order).map((direction) => indicators[direction]),
  );
}

/** Must match the base (scale 1) `.checked-out-badge` metrics in styles.css. */
const BADGE_BASE = { fontSize: 9, lineHeight: 11, paddingX: 4, borderRadius: 5, letterSpacing: 0.02 } as const;

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Width of the label's text itself, even while its flex box is ellipsized. */
function naturalTextWidth(label: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(label);
  return Math.max(range.getBoundingClientRect().width, label.scrollWidth);
}

function clearBadgeScale(badge: HTMLElement): void {
  badge.style.fontSize = '';
  badge.style.lineHeight = '';
  badge.style.paddingLeft = '';
  badge.style.paddingRight = '';
  badge.style.borderRadius = '';
  badge.style.letterSpacing = '';
}

function applyBadgeScale(badge: HTMLElement, scale: number): void {
  badge.style.fontSize = `${(BADGE_BASE.fontSize * scale).toFixed(2)}px`;
  badge.style.lineHeight = `${(BADGE_BASE.lineHeight * scale).toFixed(2)}px`;
  badge.style.paddingLeft = `${(BADGE_BASE.paddingX * scale).toFixed(2)}px`;
  badge.style.paddingRight = `${(BADGE_BASE.paddingX * scale).toFixed(2)}px`;
  badge.style.borderRadius = `${(BADGE_BASE.borderRadius * scale).toFixed(2)}px`;
  badge.style.letterSpacing = `${(BADGE_BASE.letterSpacing * scale).toFixed(3)}em`;
}

/** Activity Bar view: `Repos:` heading, repository row, branch filter and the Branches / remotes / tags tree. */
export class BranchTree {
  public readonly element: HTMLElement;

  private readonly busyEl: HTMLElement;
  private readonly graphButton: HTMLButtonElement;
  private readonly search: ReturnType<typeof createSearchBox>;
  private readonly treeEl: HTMLUListElement;
  private readonly treeScroll: HTMLElement;
  private readonly resizeObserver: ResizeObserver | undefined;
  private refTargets = new Map<string, RefTarget>();
  private worktrees = new Map<string, WorktreeInfo>();
  private stashes = new Map<string, StashInfo>();
  private trackingOrder: TrackingIndicatorOrder = 'vscode';
  private lastState: ExplorerUiState | undefined;

  constructor(private readonly callbacks: BranchTreeCallbacks) {
    const settings = button({
      className: 'icon-button',
      label: 'Explorer Display Settings',
      title: 'Display Settings',
      icon: 'settings',
    });
    settings.addEventListener('click', () => {
      const rect = settings.getBoundingClientRect();
      callbacks.onSettingsMenu(rect.left, rect.bottom);
    });
    this.graphButton = button({
      className: 'icon-button',
      label: 'Open history timeline',
      title: 'Open the commit history and graph in the editor area',
      icon: 'graph',
    });
    this.graphButton.addEventListener('click', () => callbacks.onOpenTimeline());
    const clone = button({
      className: 'icon-button clone-repository-button',
      label: 'Clone Repository',
      title: 'Clone Repository…',
      icon: 'clone',
    });
    clone.addEventListener('click', () => callbacks.onCloneRepository());

    this.search = createSearchBox('Filter', (value) => callbacks.onFilterChange(value));
    this.busyEl = el('div', { className: 'sidebar-status busy-indicator', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.busyEl.hidden = true;
    this.treeEl = el('ul', { className: 'tree', attrs: { role: 'tree', 'aria-label': 'Branches' } });
    this.treeEl.addEventListener('keydown', (event) => this.handleTreeKeydown(event));

    this.treeScroll = el('div', { className: 'tree-scroll' }, [this.treeEl]);

    this.element = el('aside', { className: 'pane pane-left', attrs: { 'aria-label': 'Branch explorer' } }, [
      el('div', { className: 'sidebar-utility-bar' }, [settings, this.graphButton]),
      el('div', { className: 'sidebar-filter' }, [this.search.element]),
      el('div', { className: 'sidebar-header repos-header-row' }, [
        el('span', { className: 'sidebar-heading', text: 'Repos:' }),
        clone,
      ]),
      this.busyEl,
      this.treeScroll,
    ]);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.layoutCheckedOutBadges());
      this.resizeObserver.observe(this.treeScroll);
    }
  }

  public dispose(): void {
    this.resizeObserver?.disconnect();
  }

  public setTrackingOrder(order: TrackingIndicatorOrder): void {
    if (this.trackingOrder === order) {
      return;
    }
    this.trackingOrder = order;
    if (this.lastState) {
      this.update({ ...this.lastState, trackingOrder: order });
    }
  }

  public update(state: ExplorerUiState): void {
    this.lastState = state;
    this.trackingOrder = state.trackingOrder;
    this.graphButton.hidden = false;
    this.search.sync(state.branchFilterText);
    this.busyEl.hidden = !state.isBusy;
    this.busyEl.textContent = state.isBusy ? state.busyMessage ?? 'Working\u2026' : '';
    this.refTargets = new Map();
    this.worktrees = new Map();
    this.stashes = new Map();

    rebuildPreservingFocus(this.treeEl, () => {
      if (state.workspaceRepos.length === 0 && !state.snapshot) {
        const placeholder = this.placeholder(state.errorMessage ? 'Unavailable' : 'Loading\u2026', 0);
        if (state.errorMessage?.includes('Trust this workspace') || state.isLoading) {
          return [placeholder];
        }
        const clone = button({
          className: 'empty-clone-repository-button',
          label: 'Clone Repository…',
          title: 'Clone Repository…',
          icon: 'clone',
          showLabel: true,
        });
        clone.addEventListener('click', () => this.callbacks.onCloneRepository());
        return [
          placeholder,
          el('li', { className: 'tree-node empty-clone-node', attrs: { role: 'none' } }, [clone]),
        ];
      }
      return this.renderRepositories(state);
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
    this.layoutCheckedOutBadges();
    requestAnimationFrame(() => this.layoutCheckedOutBadges());
  }

  private renderRepositories(state: ExplorerUiState): HTMLLIElement[] {
    const snapshotRepos = state.snapshot
      ? [{
          repoRoot: state.snapshot.repoRoot,
          repoName: state.snapshot.repoName,
          commonDir: state.snapshot.repoRoot,
          currentBranch: state.snapshot.currentBranch,
          isDetachedHead: state.snapshot.isDetachedHead,
        }]
      : [];
    const repos = state.workspaceRepos.length > 0 ? state.workspaceRepos : snapshotRepos;
    const activeRoot = state.activeRepoRoot ?? state.snapshot?.repoRoot ?? null;
    return repos.map((repo) => {
        const active = activeRoot !== null && normalizeRepoKey(activeRoot) === normalizeRepoKey(repo.repoRoot);
        const repoKey = repoNodeKey(repo.repoRoot);
        const open = active && state.expandedNodes.has(repoKey);
        const label = active
          ? `${repo.repoName} (${repo.currentBranch ?? state.snapshot?.currentBranch ?? 'HEAD'})`
          : `${repo.repoName}${repo.currentBranch ? ` (${repo.currentBranch})` : ''}`;
        const row = el(
          'div',
          {
            className: active ? 'tree-row repo-node-row active-repo' : 'tree-row repo-node-row',
            title: `${repo.repoRoot}${active ? '\nRight-click for repository actions' : '\nSelect to open this repository'}`,
          },
          [
            icon(open ? 'chevronDown' : 'chevronRight', 'icon twisty'),
            icon('repo'),
            el('span', { className: 'tree-label', text: label }),
          ],
        );
        this.setTreeDepth(row, 0);
        row.addEventListener('click', () => {
          if (active) {
            this.callbacks.onToggleNode(repoKey);
          } else {
            this.callbacks.onSelectRepository(repo.repoRoot);
          }
        });
        row.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          if (active) {
            this.callbacks.onRepoContextMenu(event.clientX, event.clientY);
          }
        });
        const item = el(
          'li',
          {
            className: 'tree-node repo-tree-node',
            attrs: {
              role: 'treeitem',
              'aria-expanded': String(active ? open : false),
              'aria-level': '1',
              'aria-current': String(active),
              'aria-label': `Repository ${label}`,
              'aria-haspopup': active ? 'menu' : 'false',
              tabindex: '-1',
              'data-focus-key': repoKey,
              'data-node-key': repoKey,
              ...(active ? {} : { 'data-repo-root': repo.repoRoot }),
            },
          },
          [row],
        );
        if (
          active &&
          open &&
          state.snapshot &&
          normalizeRepoKey(state.snapshot.repoRoot) === normalizeRepoKey(repo.repoRoot)
        ) {
          item.append(
            el('ul', { className: 'tree', attrs: { role: 'group' } }, [
              this.renderBranchesNode(state.snapshot, state),
              ...this.renderWorktreesNode(state.snapshot, state),
              ...this.renderStashesNode(state.snapshot, state),
              ...this.renderTagsNode(state.snapshot, state),
            ]),
          );
        }
        return item;
    });
  }

  /**
   * Fits the "Checked Out" pill into whatever the row has left after the branch name and the ahead/behind
   * counters, scaling it down (CSSOM only, per the CSP) or hiding it when there is too little room.
   */
  private layoutCheckedOutBadges(): void {
    for (const badge of Array.from(this.treeEl.querySelectorAll<HTMLElement>('.checked-out-badge'))) {
      const row = badge.parentElement;
      const label = row?.querySelector<HTMLElement>('.tree-label');
      if (!row || !label || row.clientWidth === 0) {
        continue;
      }
      badge.classList.remove('checked-out-badge-hidden');
      clearBadgeScale(badge);

      const rowStyle = getComputedStyle(row);
      const columnGap = rowStyle.columnGap === 'normal' ? rowStyle.gap : rowStyle.columnGap;
      const gap = pixels(columnGap);
      const visibleChildren = Array.from(row.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement && getComputedStyle(child).display !== 'none',
      );
      const labelIndex = visibleChildren.indexOf(label);
      const badgeIndex = visibleChildren.indexOf(badge);
      const prefixWidth = labelIndex > 0
        ? visibleChildren.slice(0, labelIndex).reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
        : 0;
      const trailingWidth = badgeIndex >= 0
        ? visibleChildren.slice(badgeIndex + 1).reduce((sum, child) => sum + child.getBoundingClientRect().width, 0)
        : 0;
      const gapWidth = gap * Math.max(0, visibleChildren.length - 1);
      const naturalLabelWidth = Math.ceil(naturalTextWidth(label)) + 2;
      const pillBaseWidth = badge.getBoundingClientRect().width;
      const layout = computeCheckedOutPillLayout({
        rowAvailableWidth: row.clientWidth - pixels(rowStyle.paddingLeft) - pixels(rowStyle.paddingRight),
        prefixWidth,
        branchLabelNaturalWidth: naturalLabelWidth,
        trackingWidth: trailingWidth + gapWidth + 2,
        pillBaseWidth,
      });

      badge.classList.toggle('checked-out-badge-hidden', !layout.visible);
      if (!layout.visible) {
        continue;
      }

      let scale = layout.scale;
      const isTruncated = () => label.scrollWidth > label.clientWidth + 0.5 || label.clientWidth + 0.5 < naturalLabelWidth;
      applyBadgeScale(badge, scale);
      while (isTruncated() && scale > MIN_READABLE_PILL_SCALE) {
        scale = Math.max(MIN_READABLE_PILL_SCALE, scale - 0.04);
        applyBadgeScale(badge, scale);
      }
      if (isTruncated()) {
        badge.classList.add('checked-out-badge-hidden');
        clearBadgeScale(badge);
      }
    }
  }

  private renderBranchesNode(snapshot: RepoSnapshot, state: ExplorerUiState): HTMLLIElement {
    const filtering = state.branchFilterText.trim() !== '';
    const isOpen = (key: string): boolean => filtering || state.expandedNodes.has(key);

    const locals = filterBranches(snapshot.localBranches, state.branchFilterText);
    const localItems =
      locals.length > 0
        ? this.renderBranchNodes(buildBranchFolderTree(locals, 'local'), 2, state, filtering)
        : [this.placeholder(filtering ? 'No matching branches' : `${snapshot.currentBranch} (no commits yet)`, 2)];

    const remoteNodes = snapshot.remoteGroups
      .map((group) => this.renderRemote(group, state, filtering, isOpen))
      .filter((node): node is HTMLLIElement => node !== null);

    return this.renderGroup({
      key: NODE_BRANCHES,
      label: 'Branches',
      iconName: null,
      depth: 1,
      open: isOpen(NODE_BRANCHES),
      children: [...localItems, ...remoteNodes],
    });
  }

  private renderBranchNodes(
    nodes: readonly BranchTreeNode[],
    depth: number,
    state: ExplorerUiState,
    isFiltering: boolean,
  ): HTMLLIElement[] {
    return nodes.map((node) => {
      if (node.kind === 'branch') {
        return this.renderBranch(node.branch, state, depth, node.label);
      }

      const open = isFiltering || state.expandedNodes.has(node.id);
      const row = el(
        'div',
        { className: 'tree-row tree-folder-row', title: node.fullPrefix },
        [
          icon(open ? 'chevronDown' : 'chevronRight', 'icon twisty'),
          icon(open ? 'folderOpen' : 'folder', 'icon tree-folder-icon'),
          el('span', { className: 'tree-label', text: node.name }),
          ...(state.showFolderCounts
            ? [el('span', { className: 'tree-folder-count', text: String(node.branchCount), attrs: { 'aria-hidden': 'true' } })]
            : []),
        ],
      );
      this.setTreeDepth(row, depth);
      row.addEventListener('click', () => this.callbacks.onToggleNode(node.id));

      const item = el(
        'li',
        {
          className: 'tree-node tree-folder',
          attrs: {
            role: 'treeitem',
            'aria-expanded': String(open),
            'aria-level': String(depth + 1),
            'aria-label': `${node.name}, ${node.branchCount} branch${node.branchCount === 1 ? '' : 'es'}`,
            tabindex: '-1',
            'data-focus-key': `folder:${node.id}`,
            'data-node-key': node.id,
          },
        },
        [row],
      );
      if (open) {
        const group = el(
          'ul',
          { className: 'tree tree-group', attrs: { role: 'group' } },
          this.renderBranchNodes(node.children, depth + 1, state, isFiltering),
        );
        group.style.setProperty('--tree-depth', String(depth));
        item.append(group);
      }
      return item;
    });
  }

  private renderTagsNode(snapshot: RepoSnapshot, state: ExplorerUiState): HTMLLIElement[] {
    if (snapshot.tags.length === 0) {
      return [];
    }
    const filtering = state.branchFilterText.trim() !== '';
    const tags = filterTags(snapshot.tags, state.branchFilterText);
    if (filtering && tags.length === 0) {
      return [];
    }
    return [
      this.renderGroup({
        key: NODE_TAGS,
        label: 'Tags',
        iconName: null,
        depth: 1,
        open: filtering || state.expandedNodes.has(NODE_TAGS),
        children: tags.map((tag) => this.renderTag(tag, state, 2)),
      }),
    ];
  }

  private renderStashesNode(snapshot: RepoSnapshot, state: ExplorerUiState): HTMLLIElement[] {
    if ((snapshot.stashes?.length ?? 0) === 0) {
      return [];
    }
    const filter = state.branchFilterText.trim().toLocaleLowerCase();
    const stashes = filter
      ? (snapshot.stashes ?? []).filter((stash) =>
          `${stash.ref} ${stash.message} ${stash.hash}`.toLocaleLowerCase().includes(filter),
        )
      : (snapshot.stashes ?? []);
    if (filter && stashes.length === 0) {
      return [];
    }
    return [
      this.renderGroup({
        key: NODE_STASHES,
        label: 'Stashes',
        iconName: 'stash',
        depth: 1,
        open: filter.length > 0 || state.expandedNodes.has(NODE_STASHES),
        children: stashes.map((stash) => this.renderStash(stash, 2)),
      }),
    ];
  }

  private renderStash(stash: StashInfo, depth: number): HTMLLIElement {
    this.stashes.set(stash.ref, stash);
    const label = stash.message || stash.hash.slice(0, 8);
    const title = [
      stash.ref,
      stash.message || stash.hash,
      stash.hash,
      new Date(stash.timestamp * 1000).toLocaleString(),
    ].join('\n');
    const row = el(
      'div',
      { className: 'tree-row tree-leaf stash-row', title },
      [
        el('span', { className: 'twisty-spacer' }),
        icon('stash'),
        el('span', { className: 'tree-label', text: `${stash.ref}: ${label}` }),
      ],
    );
    this.setTreeDepth(row, depth);
    row.addEventListener('click', () => this.callbacks.onInspectStash(stash));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.callbacks.onStashContextMenu(stash, event.clientX, event.clientY);
    });
    return el(
      'li',
      {
        className: 'tree-node tree-stash',
        attrs: {
          role: 'treeitem',
          'aria-level': String(depth + 1),
          'aria-label': `${stash.ref}: ${label}`,
          'aria-haspopup': 'menu',
          tabindex: '-1',
          'data-focus-key': `stash:${stash.ref}`,
          'data-stash-ref': stash.ref,
        },
      },
      [row],
    );
  }

  private renderWorktreesNode(snapshot: RepoSnapshot, state: ExplorerUiState): HTMLLIElement[] {
    if (snapshot.worktrees.length <= 1) {
      return [];
    }
    const filter = state.branchFilterText.trim().toLocaleLowerCase();
    const worktrees = filter
      ? snapshot.worktrees.filter((worktree) =>
          `${worktree.branchName ?? ''} ${worktree.path}`.toLocaleLowerCase().includes(filter),
        )
      : snapshot.worktrees;
    if (filter && worktrees.length === 0) {
      return [];
    }
    return [
      this.renderGroup({
        key: 'worktrees',
        label: 'Worktrees',
        iconName: 'worktree',
        depth: 1,
        open: filter.length > 0 || state.expandedNodes.has('worktrees'),
        children: worktrees.map((worktree) => this.renderWorktree(worktree, 2)),
      }),
    ];
  }

  private renderWorktree(worktree: WorktreeInfo, depth: number): HTMLLIElement {
    this.worktrees.set(worktree.path, worktree);
    const label = worktree.branchName ?? `detached @ ${worktree.headHash.slice(0, 8)}`;
    const suffix = worktree.isCurrent ? ' (current)' : worktree.isMain ? ' (main)' : '';
    const row = el(
      'div',
      { className: 'tree-row tree-leaf worktree-row', title: worktree.path },
      [
        el('span', { className: 'twisty-spacer' }),
        icon('worktree'),
        el('span', { className: 'tree-label', text: label + suffix }),
      ],
    );
    this.setTreeDepth(row, depth);
    row.addEventListener('dblclick', () => {
      if (!worktree.isCurrent) {
        this.callbacks.onOpenWorktree(worktree.path);
      }
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.callbacks.onWorktreeContextMenu(worktree, event.clientX, event.clientY);
    });
    return el(
      'li',
      {
        className: 'tree-node tree-worktree',
        attrs: {
          role: 'treeitem',
          'aria-level': String(depth + 1),
          'aria-label': `${label}${suffix}`,
          'aria-haspopup': 'menu',
          tabindex: '-1',
          'data-focus-key': `worktree:${worktree.path}`,
          'data-worktree-path': worktree.path,
        },
      },
      [row],
    );
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
    const local = group.destinationKind === 'localPath';
    const title = local
      ? `Local drive remote${group.url ? `: ${group.url}` : ''}`
      : group.destinationKind === 'hosted'
        ? `${group.providerName ?? 'Cloud'} remote${group.url ? `: ${group.url}` : ''}`
        : group.url;
    return this.renderGroup({
      key,
      label: `remotes/${group.remoteName}`,
      iconName: local ? 'localDrive' : 'remote',
      ...(title === undefined ? {} : { title }),
      ...(local ? { labelSuffix: '(local)' } : {}),
      depth: 2,
      open: isOpen(key),
      children: this.renderBranchNodes(
        buildBranchFolderTree(branches, `remote:${group.remoteName}`, `${group.remoteName}/`),
        3,
        state,
        filtering,
      ),
    });
  }

  private renderGroup(options: {
    key: string;
    label: string;
    iconName: IconName | null;
    title?: string;
    labelSuffix?: string;
    depth: number;
    open: boolean;
    children: HTMLLIElement[];
  }): HTMLLIElement {
    const label = el('span', { className: 'tree-label', text: options.label, title: options.label });
    if (options.labelSuffix) {
      label.append(el('span', { className: 'remote-kind-tag', text: options.labelSuffix }));
    }
    const row = el('div', { className: `tree-row depth-${options.depth}`, title: options.title ?? options.label }, [
      icon(options.open ? 'chevronDown' : 'chevronRight', 'icon twisty'),
      ...(options.iconName ? [icon(options.iconName)] : []),
      label,
    ]);
    this.setTreeDepth(row, options.depth);
    row.addEventListener('click', () => this.callbacks.onToggleNode(options.key));

    const item = el(
      'li',
      {
        className: 'tree-node tree-group-node',
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

  private renderBranch(branch: BranchInfo, state: ExplorerUiState, depth: number, label = branch.displayName): HTMLLIElement {
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

    const target = branchRefTarget(branch);
    const selected = state.selectedBranchFullName === branch.fullName;
    const tracking = trackingSummary(branch);
    const tooltip = [
      branch.name,
      branch.fullName,
      branch.isCurrent ? 'Checked out' : null,
      branch.upstream ? `Tracking ${branch.upstream}` : null,
      'Click to inspect its history',
      canCheckout ? 'Double-click to check out' : null,
      'Right-click for more actions',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    const rowClasses = ['tree-row'];
    if (depth === 1) {
      rowClasses.push('tree-leaf');
    }
    if (branch.isCurrent) {
      rowClasses.push('current-branch');
    }
    if (selected) {
      rowClasses.push('selected-ref');
    }
    const row = el('div', { className: rowClasses.join(' '), title: tooltip }, [
      el('span', { className: 'twisty-spacer' }),
      branch.isCurrent ? icon('check', 'icon checked-out-icon') : icon('branch'),
      el('span', { className: 'tree-label', text: label }),
      ...(branch.isCurrent && state.showCheckedOutBadge
        ? [el('span', { className: 'checked-out-badge', text: 'Checked Out', title: 'This branch is checked out (HEAD)' })]
        : []),
      ...(branch.worktreePath && !branch.isCurrent
        ? [el('span', {
            className: 'worktree-badge',
            text: 'WORKTREE',
            title: `Checked out in worktree: ${branch.worktreePath}`,
          })]
        : []),
      ...(tracking ? [trackingElement(tracking, this.trackingOrder)] : []),
      eye,
    ]);
    this.setTreeDepth(row, depth);
    this.wireRefRow(row, target);
    if (canCheckout) {
      row.addEventListener('dblclick', () => this.callbacks.onCheckout(branch));
    }

    const classes = ['tree-node', 'tree-branch'];
    if (pinned) {
      classes.push('pinned');
    }
    if (selected) {
      classes.push('selected-ref');
    }
    if (branch.isCurrent) {
      classes.push('checked-out');
    }
    const labelParts = [branch.name, `full ref ${branch.fullName}`];
    if (branch.isCurrent) {
      labelParts.push('checked out');
    }
    if (selected) {
      labelParts.push('selected');
    }
    if (pinned) {
      labelParts.push('isolated in history');
    }
    if (tracking) {
      labelParts.push(tracking.label);
    }
    return el(
      'li',
      {
        className: classes.join(' '),
        attrs: {
          role: 'treeitem',
          'aria-level': String(depth + 1),
          'aria-label': labelParts.join(', '),
          'aria-selected': String(selected),
          'aria-current': branch.isCurrent ? 'true' : 'false',
          tabindex: '-1',
          'data-focus-key': `branch:${branch.fullName}`,
          'data-full-name': branch.fullName,
        },
      },
      [row],
    );
  }

  private renderTag(tag: TagInfo, state: ExplorerUiState, depth = 1): HTMLLIElement {
    const target = tagRefTarget(tag);
    const selected = state.selectedBranchFullName === tag.fullName;
    const row = el(
      'div',
      {
        className: selected ? 'tree-row tree-leaf selected-ref' : 'tree-row tree-leaf',
        title: `${tag.fullName}\nClick to inspect its history\nRight-click for more actions`,
      },
      [el('span', { className: 'twisty-spacer' }), icon('tag'), el('span', { className: 'tree-label', text: tag.name })],
    );
    this.setTreeDepth(row, depth);
    this.wireRefRow(row, target);

    return el(
      'li',
      {
        className: selected ? 'tree-node tree-tag selected-ref' : 'tree-node tree-tag',
        attrs: {
          role: 'treeitem',
          'aria-level': String(depth + 1),
          'aria-label': `${tag.name}, tag${selected ? ', selected' : ''}`,
          'aria-selected': String(selected),
          tabindex: '-1',
          'data-focus-key': `tag:${tag.fullName}`,
          'data-full-name': tag.fullName,
        },
      },
      [row],
    );
  }

  /** Registers the ref for keyboard handling and wires single-click selection and the right-click menu. */
  private wireRefRow(row: HTMLElement, target: RefTarget): void {
    this.refTargets.set(target.fullName, target);
    row.addEventListener('click', () => this.callbacks.onSelectRef(target));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.callbacks.onContextMenu(target, event.clientX, event.clientY);
    });
  }

  private placeholder(text: string, depth: number): HTMLLIElement {
    const row = el('div', { className: 'tree-row placeholder', text });
    this.setTreeDepth(row, depth);
    return el('li', { className: 'tree-node', attrs: { role: 'none' } }, [row]);
  }

  private setTreeDepth(row: HTMLElement, depth: number): void {
    row.style.setProperty('--tree-depth', String(depth));
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
    const repoRoot = target.dataset.repoRoot;
    const isRepoNode = nodeKey?.startsWith('repo:') === true;
    const fullName = target.dataset.fullName;
    const worktreePath = target.dataset.worktreePath;
    const worktree = worktreePath ? this.worktrees.get(worktreePath) : undefined;
    const stashRef = target.dataset.stashRef;
    const stash = stashRef ? this.stashes.get(stashRef) : undefined;
    const ref = fullName ? this.refTargets.get(fullName) : undefined;
    const expanded = target.getAttribute('aria-expanded') === 'true';

    const focusItem = (next: HTMLElement | undefined): void => {
      if (next) {
        items.forEach((item) => (item.tabIndex = -1));
        next.tabIndex = 0;
        next.focus();
      }
    };

    if (isRepoNode) {
      const action = getRepoNodeKeyboardAction(event.key, repoRoot === undefined, event.shiftKey);
      if (action) {
        if (action === 'select' && repoRoot) {
          this.callbacks.onSelectRepository(repoRoot);
        } else if (action === 'toggle' && nodeKey) {
          this.callbacks.onToggleNode(nodeKey);
        } else if (action === 'menu') {
          const rect = target.getBoundingClientRect();
          this.callbacks.onRepoContextMenu(rect.left + 24, rect.bottom);
        }
        event.preventDefault();
        return;
      }
    }

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
        if (nodeKey && !expanded && !repoRoot) {
          this.callbacks.onToggleNode(nodeKey);
        }
        break;
      case 'ArrowLeft':
        if (nodeKey && expanded && !repoRoot) {
          this.callbacks.onToggleNode(nodeKey);
        } else {
          focusItem(target.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined);
        }
        break;
      case 'Enter':
        if (repoRoot) {
          this.callbacks.onSelectRepository(repoRoot);
        } else if (worktree) {
          if (!worktree.isCurrent) {
            this.callbacks.onOpenWorktree(worktree.path);
          }
        } else if (nodeKey) {
          this.callbacks.onToggleNode(nodeKey);
        } else if (stash) {
          this.callbacks.onInspectStash(stash);
        } else if (ref) {
          if (ref.kind === 'local' && ref.branch?.isCurrent === false) {
            this.callbacks.onCheckout(ref.branch);
          } else {
            this.callbacks.onSelectRef(ref);
          }
        }
        break;
      case ' ':
        if (repoRoot) {
          this.callbacks.onSelectRepository(repoRoot);
        } else if (nodeKey) {
          this.callbacks.onToggleNode(nodeKey);
        } else if (ref) {
          if (ref.kind === 'tag') {
            this.callbacks.onSelectRef(ref);
          } else {
            this.callbacks.onTogglePin(ref.fullName);
          }
        }
        break;
      case 'ContextMenu':
      case 'F10':
        if ((!ref && !worktree && !stash) || (event.key === 'F10' && !event.shiftKey)) {
          return;
        }
        {
          const rect = target.getBoundingClientRect();
          if (stash) {
            this.callbacks.onStashContextMenu(stash, rect.left + 24, rect.bottom);
          } else if (worktree) {
            this.callbacks.onWorktreeContextMenu(worktree, rect.left + 24, rect.bottom);
          } else if (ref) {
            this.callbacks.onContextMenu(ref, rect.left + 24, rect.bottom);
          }
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
