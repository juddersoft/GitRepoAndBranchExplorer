import type { ChangedFileEntry, ChangedFileStatus, CommitDetails, CommitNode, RefBadge, RepoSnapshot } from '../../types/git';
import type { GitAction } from '../../types/messages';
import { GIT_ACTION_LABELS } from '../../types/messages';
import { pullPushDisabledReason } from './contextMenuModel';
import { button, createSearchBox, el, icon, type IconName } from './dom';
import type { ColumnKey, StoredColumnWidths } from './columnResize';
import { clampColumnWidth, computeTableMinWidth, resolveColumnWidths } from './columnResize';
import type { GraphRowLayout } from './graphLayout';
import { computeGraphLayout } from './graphLayout';
import type { BadgeKindToggle, ExplorerUiState } from './state';
import {
  computeVisibleCommits,
  describeCommitCount,
  describeEmptyHistory,
  describeHistoryFocus,
  describeRefFilterStatus,
  filterVisibleBadges,
  hasHistoryFocus,
  summarizeRefToggles,
} from './state';

export interface HistoryPaneCallbacks {
  onGitAction(action: GitAction): void;
  onRefresh(): void;
  onToggleBadgeKind(kind: BadgeKindToggle): void;
  onToggleTabPinned(): void;
  onHistoryFilterChange(text: string): void;
  /** Clears the selected ref and every isolated (pinned) branch. */
  onClearFocus(): void;
  onSelectCommit(hash: string | null): void;
  onCommitContextMenu(commit: CommitNode, x: number, y: number): void;
  onCopyHash(hash: string): void;
  onOpenFileDiff(hash: string, file: ChangedFileEntry): void;
  onOpenInGitGraph(): void;
  onOpenCommitOnGitHub(hash: string): void;
  onSignInGitHub(): void;
  /** The user resized (or reset) a column; `widths` holds only the columns that differ from their defaults. */
  onColumnWidthsChange(widths: StoredColumnWidths): void;
}

const FILE_STATUS_LABELS: Readonly<Record<ChangedFileStatus, string>> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Unmerged',
};

const COLUMNS: ReadonlyArray<{ key: ColumnKey; label: string }> = [
  { key: 'refs', label: 'Branch / Tag' },
  { key: 'graph', label: 'Graph' },
  { key: 'message', label: 'Message' },
  { key: 'author', label: 'Author' },
  { key: 'date', label: 'Date' },
  { key: 'id', label: 'ID' },
];

const MAX_INLINE_BADGES = 2;
const AVATAR_COLOR_COUNT = 6;

const SVG_NS = 'http://www.w3.org/2000/svg';
export const LANE_WIDTH = 14;
export const LEFT_PAD = 10;
/** Must equal `--history-row-height` in styles.css so rails meet edge-to-edge between rows. */
export const ROW_HEIGHT = 26;
export const MAX_RENDERED_LANES = 24;
export const GRAPH_COLOR_COUNT = 8;
const MIN_GRAPH_COLUMN_WIDTH = 56;

export function graphWidth(maxLanes: number): number {
  return Math.min(Math.max(maxLanes, 1), MAX_RENDERED_LANES) * LANE_WIDTH + LEFT_PAD * 2;
}

function laneX(lane: number): number {
  return LEFT_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

function laneClass(colorIndex: number): string {
  return `graph-lane-${((colorIndex % GRAPH_COLOR_COUNT) + GRAPH_COLOR_COUNT) % GRAPH_COLOR_COUNT}`;
}

/** Renders one row's rails, curves and commit node; rows stack seamlessly because every row uses the same geometry. */
export function buildGraphCellSvg(layout: GraphRowLayout, rowHeight: number): SVGSVGElement {
  const width = graphWidth(layout.maxLanesInWindow);
  const mid = rowHeight / 2;
  const svg = svgEl('svg', {
    class: 'graph-svg',
    width,
    height: rowHeight,
    viewBox: `0 0 ${width} ${rowHeight}`,
    'aria-hidden': 'true',
    focusable: 'false',
  });

  for (const segment of layout.segments) {
    const x1 = laneX(segment.fromLane);
    const x2 = laneX(segment.toLane);
    const [y1, y2] = segment.half === 'top' ? [0, mid] : [mid, rowHeight];
    const midY = (y1 + y2) / 2;
    const className = `graph-rail ${laneClass(segment.colorIndex)}`;
    svg.appendChild(
      segment.fromLane === segment.toLane
        ? svgEl('line', { class: className, x1, y1, x2, y2 })
        : svgEl('path', { class: className, d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}` }),
    );
  }

  const cx = laneX(layout.lane);
  const color = laneClass(layout.colorIndex);
  if (layout.isHead) {
    svg.appendChild(svgEl('circle', { class: `graph-halo ${color}`, cx, cy: mid, r: 7.5 }));
    svg.appendChild(svgEl('circle', { class: `graph-node graph-node-head ${color}`, cx, cy: mid, r: 5 }));
  } else if (layout.isMerge) {
    svg.appendChild(svgEl('circle', { class: `graph-node graph-node-merge ${color}`, cx, cy: mid, r: 4.5 }));
  } else {
    svg.appendChild(svgEl('circle', { class: `graph-node ${color}`, cx, cy: mid, r: 4 }));
  }
  return svg;
}

const ACTIONS: ReadonlyArray<{ action: GitAction; icon: IconName; tooltip: string }> = [
  { action: 'fetch', icon: 'fetch', tooltip: 'Fetch: download objects and refs from remotes' },
  { action: 'pull', icon: 'pull', tooltip: 'Pull: fetch and integrate the upstream branch' },
  { action: 'push', icon: 'push', tooltip: 'Push: upload local commits to the upstream branch' },
  { action: 'createBranch', icon: 'newBranch', tooltip: 'New Branch: create a branch from the current commit' },
];

const BADGE_TOGGLES: ReadonlyArray<{ kind: BadgeKindToggle; label: string; icon: IconName }> = [
  { kind: 'local', label: 'Local Branches', icon: 'branch' },
  { kind: 'remote', label: 'Remote Branches', icon: 'remote' },
  { kind: 'tag', label: 'Tags', icon: 'tag' },
];

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatCommitDate(commit: CommitNode): string {
  const date = new Date(commit.authorTimestamp * 1000);
  return commit.authorTimestamp > 0 && !Number.isNaN(date.getTime()) ? dateFormatter.format(date) : commit.authorDateIso;
}

function authorInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

function avatarColorIndex(name: string): number {
  let hash = 0;
  for (const ch of name) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash % AVATAR_COLOR_COUNT;
}

function badgeClass(ref: RefBadge, snapshot: RepoSnapshot): string {
  switch (ref.kind) {
    case 'head':
      return 'pill pill-head';
    case 'localBranch':
      return !snapshot.isDetachedHead && ref.label === snapshot.currentBranch ? 'pill pill-current' : 'pill pill-local';
    case 'remoteBranch':
      return 'pill pill-remote';
    case 'tag':
      return 'pill pill-tag';
  }
}

const BADGE_KIND_LABELS: Readonly<Record<RefBadge['kind'], string>> = {
  head: 'HEAD',
  localBranch: 'Local branch',
  remoteBranch: 'Remote branch',
  tag: 'Tag',
};

function pill(ref: RefBadge, snapshot: RepoSnapshot): HTMLSpanElement {
  return el('span', { className: badgeClass(ref, snapshot), text: ref.label, title: `${BADGE_KIND_LABELS[ref.kind]}: ${ref.label}` });
}

function renderPills(refs: readonly RefBadge[], snapshot: RepoSnapshot): HTMLSpanElement[] {
  if (refs.length <= MAX_INLINE_BADGES) {
    return refs.map((ref) => pill(ref, snapshot));
  }
  const overflow = el('span', {
    className: 'pill pill-overflow',
    text: '...',
    title: refs.map((ref) => `${BADGE_KIND_LABELS[ref.kind]}: ${ref.label}`).join('\n'),
  });
  return [...refs.slice(0, MAX_INLINE_BADGES).map((ref) => pill(ref, snapshot)), overflow];
}

/** Editor timeline: action/filter toolbar, branch breadcrumb, commit graph + history table and details footer. */
export class HistoryPane {
  public readonly element: HTMLElement;

  private readonly actionButtons = new Map<GitAction, HTMLButtonElement>();
  private readonly refreshButton: HTMLButtonElement;
  private readonly gitGraphButton: HTMLButtonElement;
  private readonly tabPinButton: HTMLButtonElement;
  private readonly busyIndicator: HTMLElement;
  private readonly toggleButtons = new Map<BadgeKindToggle, HTMLButtonElement>();
  private readonly toggleCounts = new Map<BadgeKindToggle, HTMLElement>();
  private readonly search: ReturnType<typeof createSearchBox>;
  private readonly banner: HTMLElement;
  private readonly breadcrumbText: HTMLElement;
  private readonly refFilterStatus: HTMLElement;
  private readonly commitCountStatus: HTMLElement;
  private readonly clearPinsButton: HTMLButtonElement;
  private readonly tableScroll: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly tbody: HTMLTableSectionElement;
  private readonly columnEls = new Map<ColumnKey, HTMLTableColElement>();
  private readonly details: HTMLElement;
  private readonly detailsTitle: HTMLElement;
  private readonly detailsToggle: HTMLButtonElement;
  private readonly detailsBody: HTMLElement;

  private visibleCommits: CommitNode[] = [];
  private isDetailsCollapsed = false;
  private lastState: ExplorerUiState | null = null;
  private pendingRevealHash: string | null = null;
  private storedColumnWidths: StoredColumnWidths;
  /** Width the graph column needs for the lanes currently shown; it can never be dragged below this. */
  private activeGraphWidth = MIN_GRAPH_COLUMN_WIDTH;

  constructor(
    private readonly callbacks: HistoryPaneCallbacks,
    initialColumnWidths: StoredColumnWidths = {},
  ) {
    this.storedColumnWidths = initialColumnWidths;
    const actions = ACTIONS.map(({ action, icon: iconName, tooltip }) => {
      const btn = button({ className: 'toolbar-button', label: GIT_ACTION_LABELS[action], title: tooltip, icon: iconName, showLabel: true });
      btn.addEventListener('click', () => callbacks.onGitAction(action));
      this.actionButtons.set(action, btn);
      return btn;
    });

    this.refreshButton = button({ className: 'toolbar-button', label: 'Refresh', title: 'Refresh repository', icon: 'refresh' });
    this.refreshButton.addEventListener('click', () => callbacks.onRefresh());

    this.gitGraphButton = button({
      className: 'toolbar-button',
      label: 'Open in Git Graph',
      title: 'Open this repository in the Git Graph extension',
      icon: 'graph',
      showLabel: true,
    });
    this.gitGraphButton.addEventListener('click', () => callbacks.onOpenInGitGraph());
    this.gitGraphButton.hidden = true;

    const toggles = BADGE_TOGGLES.map(({ kind, label, icon: iconName }) => {
      const btn = button({
        className: 'toolbar-button toggle-button',
        label,
        title: `Show ${label.toLowerCase()} in the Branch / Tag column`,
        icon: iconName,
        showLabel: true,
      });
      const count = el('span', { className: 'toggle-count' });
      btn.append(count);
      btn.addEventListener('click', () => callbacks.onToggleBadgeKind(kind));
      this.toggleButtons.set(kind, btn);
      this.toggleCounts.set(kind, count);
      return btn;
    });

    this.search = createSearchBox('Filter History', (value) => callbacks.onHistoryFilterChange(value));

    this.tabPinButton = button({
      className: 'toolbar-button toggle-button pin-button',
      label: 'Pin Tab',
      title: 'Keep this tab open when another sidebar view is selected',
      icon: 'pin',
      showLabel: true,
    });
    this.tabPinButton.addEventListener('click', () => callbacks.onToggleTabPinned());

    const toolbar = el('div', { className: 'toolbar', attrs: { role: 'toolbar', 'aria-label': 'Git history actions' } }, [
      el('div', { className: 'toolbar-group' }, [...actions, this.refreshButton, this.gitGraphButton]),
      el('div', { className: 'toolbar-separator', attrs: { role: 'separator' } }),
      el('div', { className: 'toolbar-group', attrs: { role: 'group', 'aria-label': 'Ref labels shown in the Branch / Tag column' } }, toggles),
      el('div', { className: 'toolbar-spacer' }),
      el('div', { className: 'toolbar-search' }, [this.search.element]),
      this.tabPinButton,
    ]);

    this.banner = el('div', { className: 'status-banner', attrs: { role: 'alert' } });
    this.banner.hidden = true;

    this.breadcrumbText = el('span', { className: 'breadcrumb-text' });
    this.clearPinsButton = button({ className: 'link-button', label: 'Clear filter', showLabel: true });
    this.clearPinsButton.addEventListener('click', () => callbacks.onClearFocus());
    this.refFilterStatus = el('span', { className: 'filter-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.refFilterStatus.hidden = true;
    this.commitCountStatus = el('span', { className: 'filter-status commit-count', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.commitCountStatus.hidden = true;
    this.busyIndicator = el('span', { className: 'busy-indicator', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.busyIndicator.hidden = true;
    const breadcrumb = el('div', { className: 'breadcrumb' }, [
      this.breadcrumbText,
      this.clearPinsButton,
      el('span', { className: 'toolbar-spacer' }),
      this.commitCountStatus,
      this.refFilterStatus,
      this.busyIndicator,
    ]);

    this.tbody = el('tbody');
    this.tbody.addEventListener('click', (event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('tr[data-hash]') : null;
      if (row?.dataset.hash) {
        callbacks.onSelectCommit(row.dataset.hash);
      }
    });
    this.tbody.addEventListener('contextmenu', (event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('tr[data-hash]') : null;
      const commit = row?.dataset.hash ? this.visibleCommits.find((c) => c.hash === row.dataset.hash) : undefined;
      if (commit) {
        event.preventDefault();
        callbacks.onSelectCommit(commit.hash);
        callbacks.onCommitContextMenu(commit, event.clientX, event.clientY);
      }
    });

    const cols = COLUMNS.map((col) => {
      const colEl = el('col', { className: `col-${col.key}` });
      this.columnEls.set(col.key, colEl);
      return colEl;
    });
    this.table = el('table', { className: 'history-table', attrs: { 'aria-label': 'Commit history' } }, [
      el('colgroup', {}, cols),
      el('thead', {}, [el('tr', {}, COLUMNS.map((col) => this.renderHeaderCell(col.key, col.label)))]),
      this.tbody,
    ]);
    this.applyColumnWidths();

    this.tableScroll = el('div', { className: 'table-scroll', attrs: { tabindex: '0', 'aria-label': 'Commit history, use arrow keys to select' } }, [this.table]);
    this.tableScroll.addEventListener('keydown', (event) => this.handleTableKeydown(event));

    this.detailsTitle = el('span', { className: 'details-title' });
    this.detailsToggle = button({ className: 'icon-button', label: 'Collapse commit details', icon: 'chevronDown' });
    this.detailsToggle.addEventListener('click', () => {
      this.isDetailsCollapsed = !this.isDetailsCollapsed;
      if (this.lastState) {
        this.renderDetails(this.lastState);
      }
    });
    const closeDetails = button({ className: 'icon-button', label: 'Close commit details', icon: 'close' });
    closeDetails.addEventListener('click', () => callbacks.onSelectCommit(null));
    this.detailsBody = el('div', { className: 'details-body' });
    this.details = el('section', { className: 'details', attrs: { 'aria-label': 'Commit details' } }, [
      el('div', { className: 'details-header' }, [this.detailsToggle, this.detailsTitle, el('span', { className: 'toolbar-spacer' }), closeDetails]),
      this.detailsBody,
    ]);
    this.details.hidden = true;

    this.element = el('section', { className: 'pane pane-right' }, [toolbar, this.banner, breadcrumb, this.tableScroll, this.details]);
  }

  public update(state: ExplorerUiState): void {
    const previousSelection = this.lastState?.selectedCommitHash ?? null;
    this.lastState = state;
    const { snapshot } = state;

    for (const [action, btn] of this.actionButtons) {
      btn.disabled = snapshot === null || state.isBusy;
      if (action === 'pull' || action === 'push') {
        const current = snapshot?.localBranches.find((b) => b.isCurrent);
        const reason = snapshot === null ? undefined : pullPushDisabledReason(action, snapshot.isDetachedHead, current?.upstream ?? null);
        btn.disabled ||= reason !== undefined;
        btn.title = reason ?? ACTIONS.find((a) => a.action === action)?.tooltip ?? GIT_ACTION_LABELS[action];
      }
    }
    this.refreshButton.disabled = state.isLoading || state.isBusy;
    this.refreshButton.classList.toggle('spinning', state.isLoading);
    this.gitGraphButton.hidden = !state.integrations.gitGraphAvailable;
    this.gitGraphButton.disabled = snapshot === null;
    this.busyIndicator.hidden = !state.isBusy;
    this.busyIndicator.textContent = state.isBusy ? state.busyMessage ?? 'Working\u2026' : '';

    this.tabPinButton.setAttribute('aria-pressed', String(state.tabPinned));
    this.tabPinButton.classList.toggle('active', state.tabPinned);
    const pinLabel = state.tabPinned ? 'Pinned' : 'Pin Tab';
    this.tabPinButton.setAttribute('aria-label', state.tabPinned ? 'Unpin tab' : 'Pin tab');
    this.tabPinButton.title = state.tabPinned
      ? 'Pinned: this tab stays open when another sidebar view is selected. Click to unpin.'
      : 'Keep this tab open when another sidebar view is selected';
    const pinLabelEl = this.tabPinButton.querySelector('.button-label');
    if (pinLabelEl) {
      pinLabelEl.textContent = pinLabel;
    }

    for (const summary of summarizeRefToggles(snapshot, state)) {
      const btn = this.toggleButtons.get(summary.kind);
      btn?.setAttribute('aria-pressed', String(summary.enabled));
      btn?.classList.toggle('active', summary.enabled);
      btn?.classList.toggle('empty', summary.count === 0);
      if (btn) {
        btn.title = `${summary.enabled ? 'Hide' : 'Show'} ${summary.noun} in the Branch / Tag column (${summary.count} in this repository)`;
      }
      const count = this.toggleCounts.get(summary.kind);
      if (count) {
        count.textContent = snapshot ? String(summary.count) : '';
        count.hidden = snapshot === null;
      }
    }
    this.search.sync(state.historyFilterText);

    this.banner.hidden = state.errorMessage === null;
    this.banner.textContent = state.errorMessage ?? '';

    this.renderBreadcrumb(state);
    this.renderRows(state);
    this.renderDetails(state);
    if (state.selectedCommitHash !== null && state.selectedCommitHash === this.pendingRevealHash) {
      this.tbody.querySelector('tr.selected')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      this.pendingRevealHash = null;
    } else if (state.selectedCommitHash !== null && state.selectedCommitHash !== previousSelection) {
      this.tbody.querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' });
    }
  }

  public revealCommit(hash: string): void {
    this.pendingRevealHash = hash;
  }

  private renderBreadcrumb(state: ExplorerUiState): void {
    const { snapshot } = state;
    const focus = snapshot ? describeHistoryFocus(snapshot, state) : [];
    this.clearPinsButton.hidden = !hasHistoryFocus(state);
    if (!snapshot) {
      this.breadcrumbText.textContent = 'Branches:';
    } else if (focus.length > 0) {
      this.breadcrumbText.textContent = `Branches: ${focus.join(', ')}`;
    } else {
      this.breadcrumbText.textContent = `Branches: All (${snapshot.currentBranch})`;
    }

    const refStatus = describeRefFilterStatus(snapshot, state);
    this.refFilterStatus.hidden = refStatus === null;
    this.refFilterStatus.textContent = refStatus ?? '';
  }

  private renderRows(state: ExplorerUiState): void {
    const { snapshot } = state;
    if (!snapshot) {
      this.visibleCommits = [];
      this.commitCountStatus.hidden = true;
      this.tbody.replaceChildren(this.placeholderRow(state.errorMessage ? 'No history available.' : 'Loading\u2026'));
      return;
    }
    this.visibleCommits = computeVisibleCommits(snapshot, state);
    const countText = describeCommitCount(snapshot, this.visibleCommits.length);
    this.commitCountStatus.hidden = countText === null;
    this.commitCountStatus.textContent = countText ?? '';
    if (this.visibleCommits.length === 0) {
      this.tbody.replaceChildren(this.placeholderRow(describeEmptyHistory(snapshot, state)));
      return;
    }
    const layout = computeGraphLayout(this.visibleCommits);
    this.activeGraphWidth = Math.max(MIN_GRAPH_COLUMN_WIDTH, graphWidth(layout[0]?.maxLanesInWindow ?? 1));
    this.applyColumnWidths();
    this.tbody.replaceChildren(...this.visibleCommits.map((commit, i) => this.renderRow(commit, layout[i], snapshot, state)));
  }

  private renderHeaderCell(key: ColumnKey, label: string): HTMLTableCellElement {
    const resizer = el('span', {
      className: 'col-resizer',
      title: 'Drag to resize, double-click to reset',
      attrs: { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': `Resize ${label} column` },
    });
    resizer.addEventListener('pointerdown', (event) => this.beginColumnResize(event, key, resizer));
    resizer.addEventListener('dblclick', (event) => {
      event.preventDefault();
      this.resetColumn(key);
    });
    return el('th', { className: `col-${key}`, attrs: { scope: 'col' } }, [el('span', { className: 'th-label', text: label }), resizer]);
  }

  /**
   * Writes the column widths through the CSSOM (inline `style` attributes are blocked by the CSP). The message
   * column stays fluid until the user sizes it; once any width is fixed the table's minimum is the column sum.
   */
  private applyColumnWidths(): void {
    const widths = resolveColumnWidths(this.storedColumnWidths, this.activeGraphWidth);
    const messageIsFluid = this.storedColumnWidths.message === undefined;
    for (const [key, colEl] of this.columnEls) {
      colEl.style.width = key === 'message' && messageIsFluid ? '' : `${widths[key]}px`;
    }
    const total = `${computeTableMinWidth(widths, this.activeGraphWidth)}px`;
    this.table.style.minWidth = total;
    this.table.style.width = messageIsFluid ? '' : total;
  }

  private setStoredWidth(key: ColumnKey, width: number | null): void {
    const next: Partial<Record<ColumnKey, number>> = { ...this.storedColumnWidths };
    if (width === null) {
      delete next[key];
    } else {
      next[key] = width;
    }
    this.storedColumnWidths = next;
    this.applyColumnWidths();
  }

  private beginColumnResize(event: PointerEvent, key: ColumnKey, resizer: HTMLElement): void {
    const th = resizer.parentElement;
    if (event.button !== 0 || !th) {
      return;
    }
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('resizing');
    const startX = event.clientX;
    const startWidth = th.getBoundingClientRect().width;
    let moved = false;

    const onMove = (move: PointerEvent): void => {
      // A plain click must not turn a fluid column into a fixed-width one.
      if (!moved && move.clientX === startX) {
        return;
      }
      moved = true;
      this.setStoredWidth(key, clampColumnWidth(key, startWidth + (move.clientX - startX), this.activeGraphWidth));
    };
    const onEnd = (): void => {
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onEnd);
      resizer.removeEventListener('pointercancel', onEnd);
      resizer.classList.remove('resizing');
      if (resizer.hasPointerCapture(event.pointerId)) {
        resizer.releasePointerCapture(event.pointerId);
      }
      if (moved) {
        this.callbacks.onColumnWidthsChange(this.storedColumnWidths);
      }
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onEnd);
    resizer.addEventListener('pointercancel', onEnd);
  }

  /** Back to the default width (the message column goes back to filling the free space). */
  private resetColumn(key: ColumnKey): void {
    this.setStoredWidth(key, null);
    this.callbacks.onColumnWidthsChange(this.storedColumnWidths);
  }

  private renderRow(commit: CommitNode, graph: GraphRowLayout, snapshot: RepoSnapshot, state: ExplorerUiState): HTMLTableRowElement {
    const selected = commit.hash === state.selectedCommitHash;

    return el(
      'tr',
      {
        className: selected ? 'commit-row selected' : 'commit-row',
        attrs: { 'data-hash': commit.hash, 'aria-selected': String(selected) },
      },
      [
        el('td', { className: 'col-refs' }, [
          el('div', { className: 'ref-pills' }, renderPills(filterVisibleBadges(commit.refs, state), snapshot)),
        ]),
        el('td', { className: 'col-graph' }, [buildGraphCellSvg(graph, ROW_HEIGHT)]),
        el('td', { className: 'col-message', text: commit.subject, title: commit.subject }),
        el('td', { className: 'col-author', title: `${commit.authorName} <${commit.authorEmail}>` }, [
          el('span', { className: `avatar avatar-${avatarColorIndex(commit.authorName)}`, text: authorInitial(commit.authorName) }),
          el('span', { className: 'author-name', text: commit.authorName }),
        ]),
        el('td', { className: 'col-date', text: formatCommitDate(commit), title: commit.authorDateIso }),
        el('td', { className: 'col-id', text: commit.shortHash, title: commit.hash }),
      ],
    );
  }

  private placeholderRow(text: string): HTMLTableRowElement {
    const cell = el('td', { className: 'placeholder', text });
    cell.colSpan = COLUMNS.length;
    return el('tr', {}, [cell]);
  }

  private renderDetails(state: ExplorerUiState): void {
    const { snapshot } = state;
    const commit = snapshot?.commits.find((c) => c.hash === state.selectedCommitHash);
    if (!snapshot || !commit) {
      this.details.hidden = true;
      this.detailsBody.replaceChildren();
      return;
    }
    this.details.hidden = false;
    this.detailsTitle.textContent = `Commit ${commit.shortHash}`;
    this.detailsToggle.replaceChildren(icon(this.isDetailsCollapsed ? 'chevronRight' : 'chevronDown'));
    const toggleLabel = this.isDetailsCollapsed ? 'Expand commit details' : 'Collapse commit details';
    this.detailsToggle.setAttribute('aria-label', toggleLabel);
    this.detailsToggle.setAttribute('aria-expanded', String(!this.isDetailsCollapsed));
    this.detailsToggle.title = toggleLabel;
    this.detailsBody.hidden = this.isDetailsCollapsed;

    const copy = button({ className: 'toolbar-button', label: 'Copy Hash', title: 'Copy the full commit hash', icon: 'copy', showLabel: true });
    copy.addEventListener('click', () => this.callbacks.onCopyHash(commit.hash));

    const knownHashes = new Set(snapshot.commits.map((c) => c.hash));
    const parents =
      commit.parents.length === 0
        ? [el('span', { className: 'muted', text: 'None (root commit)' })]
        : commit.parents.map((parent) => {
            if (!knownHashes.has(parent)) {
              return el('code', { className: 'hash', text: parent.slice(0, 8), title: `${parent} (not loaded)` });
            }
            const link = button({ className: 'link-button hash', label: parent.slice(0, 8), title: `Select parent ${parent}`, showLabel: true });
            link.addEventListener('click', () => this.callbacks.onSelectCommit(parent));
            return link;
          });

    const field = (label: string, value: Node[]): HTMLElement[] => [
      el('dt', { text: label }),
      el('dd', {}, value),
    ];

    const details = state.commitDetails.get(commit.hash);
    const message = details
      ? el('pre', { className: 'details-message details-body-text', text: details.body || commit.subject })
      : el('span', { className: 'details-message', text: commit.subject });

    this.detailsBody.replaceChildren(
      el('dl', { className: 'details-grid' }, [
        ...field('Commit', [el('code', { className: 'hash full-hash', text: commit.hash }), copy]),
        ...field('Author', [el('span', { text: `${commit.authorName} <${commit.authorEmail}>` })]),
        ...field('Date', [el('span', { text: formatCommitDate(commit), title: commit.authorDateIso })]),
        ...field(commit.parents.length > 1 ? 'Parents' : 'Parent', parents),
        ...(commit.refs.length > 0 ? field('Refs', commit.refs.map((ref) => pill(ref, snapshot))) : []),
        ...field('Message', [message]),
      ]),
      this.renderChangedFiles(commit, details),
      this.renderDetailsActions(commit, state),
    );
  }

  private renderChangedFiles(commit: CommitNode, details: CommitDetails | undefined): HTMLElement {
    const heading = el('div', {
      className: 'changed-files-heading',
      text: details ? `Changed files (${details.files.length})` : 'Changed files',
    });
    if (!details) {
      return el('div', { className: 'changed-files' }, [heading, el('div', { className: 'muted', text: 'Loading\u2026' })]);
    }
    if (details.files.length === 0) {
      return el('div', { className: 'changed-files' }, [heading, el('div', { className: 'muted', text: 'No file changes.' })]);
    }
    const items = details.files.map((file) => {
      const statusLabel = FILE_STATUS_LABELS[file.status];
      const pathText = file.oldPath ? `${file.oldPath} \u2192 ${file.path}` : file.path;
      const fileButton = el('button', {
        className: 'changed-file',
        title: `${statusLabel}: ${pathText}\nClick to compare with the parent commit`,
        attrs: { type: 'button' },
      }, [
        el('span', { className: `file-status file-status-${file.status}`, text: file.status, attrs: { 'aria-label': statusLabel } }),
        el('span', { className: 'file-path', text: pathText }),
      ]);
      fileButton.addEventListener('click', () => this.callbacks.onOpenFileDiff(commit.hash, file));
      return el('li', {}, [fileButton]);
    });
    return el('div', { className: 'changed-files' }, [heading, el('ul', { className: 'changed-file-list' }, items)]);
  }

  private renderDetailsActions(commit: CommitNode, state: ExplorerUiState): HTMLElement {
    const actions: HTMLElement[] = [];
    if (state.integrations.githubRemoteUrl !== null) {
      const openOnGitHub = button({
        className: 'toolbar-button',
        label: 'Open on GitHub',
        title: `Open ${commit.shortHash} on ${state.integrations.githubRemoteUrl}`,
        icon: 'linkExternal',
        showLabel: true,
      });
      openOnGitHub.addEventListener('click', () => this.callbacks.onOpenCommitOnGitHub(commit.hash));
      const signIn = button({ className: 'link-button', label: 'Sign in to GitHub', title: 'Sign in with your GitHub account', showLabel: true });
      signIn.addEventListener('click', () => this.callbacks.onSignInGitHub());
      actions.push(openOnGitHub, signIn);
    }
    const footer = el('div', { className: 'details-actions' }, actions);
    footer.hidden = actions.length === 0;
    return footer;
  }

  private handleTableKeydown(event: KeyboardEvent): void {
    if (this.visibleCommits.length === 0) {
      return;
    }
    const current = this.visibleCommits.findIndex((c) => c.hash === this.lastState?.selectedCommitHash);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = Math.min(current + 1, this.visibleCommits.length - 1);
        break;
      case 'ArrowUp':
        next = current <= 0 ? 0 : current - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = this.visibleCommits.length - 1;
        break;
      case 'Escape':
        this.callbacks.onSelectCommit(null);
        event.preventDefault();
        return;
      case 'ContextMenu':
      case 'F10': {
        const commit = this.visibleCommits[current];
        const row = this.tbody.querySelector('tr.selected');
        if (!commit || !row || (event.key === 'F10' && !event.shiftKey)) {
          return;
        }
        const rect = row.getBoundingClientRect();
        this.callbacks.onCommitContextMenu(commit, rect.left + 48, rect.bottom);
        event.preventDefault();
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    this.callbacks.onSelectCommit(this.visibleCommits[next].hash);
  }
}
