import type { ChangedFileEntry, ChangedFileStatus, CommitDetails, CommitNode, RefBadge, RepoSnapshot } from '../../types/git';
import type { GitAction } from '../../types/messages';
import { GIT_ACTION_LABELS } from '../../types/messages';
import { button, createSearchBox, el, icon, type IconName } from './dom';
import type { GraphRowLayout } from './graphLayout';
import { computeGraphLayout } from './graphLayout';
import type { BadgeKindToggle, ExplorerUiState } from './state';
import { computeVisibleCommits, filterVisibleBadges, getPinnedBranches } from './state';

export interface HistoryPaneCallbacks {
  onGitAction(action: GitAction): void;
  onRefresh(): void;
  onToggleBadgeKind(kind: BadgeKindToggle): void;
  onHistoryFilterChange(text: string): void;
  onClearPins(): void;
  onSelectCommit(hash: string | null): void;
  onCopyHash(hash: string): void;
  onOpenFileDiff(hash: string, file: ChangedFileEntry): void;
  onOpenInGitGraph(): void;
  onOpenCommitOnGitHub(hash: string): void;
  onSignInGitHub(): void;
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

const COLUMNS = [
  { key: 'refs', label: 'Branch / Tag' },
  { key: 'graph', label: 'Graph' },
  { key: 'message', label: 'Message' },
  { key: 'author', label: 'Author' },
  { key: 'date', label: 'Date' },
  { key: 'id', label: 'ID' },
] as const;

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
/** Sum of the fixed `refs`, `author`, `date` and `id` column widths in styles.css. */
const FIXED_COLUMNS_WIDTH = 155 + 150 + 140 + 84;
const MIN_MESSAGE_COLUMN_WIDTH = 180;

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

const BADGE_TOGGLES: ReadonlyArray<{ kind: BadgeKindToggle; label: string; icon: IconName; stateKey: keyof ExplorerUiState }> = [
  { kind: 'local', label: 'Local Branches', icon: 'branch', stateKey: 'showLocalBranchBadges' },
  { kind: 'remote', label: 'Remote Branches', icon: 'remote', stateKey: 'showRemoteBranchBadges' },
  { kind: 'tag', label: 'Tags', icon: 'tag', stateKey: 'showTagBadges' },
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

/** Right pane: action/filter toolbar, branch breadcrumb, commit history table and details footer. */
export class HistoryPane {
  public readonly element: HTMLElement;

  private readonly actionButtons: HTMLButtonElement[] = [];
  private readonly refreshButton: HTMLButtonElement;
  private readonly gitGraphButton: HTMLButtonElement;
  private readonly busyIndicator: HTMLElement;
  private readonly toggleButtons = new Map<BadgeKindToggle, HTMLButtonElement>();
  private readonly search: ReturnType<typeof createSearchBox>;
  private readonly banner: HTMLElement;
  private readonly breadcrumbText: HTMLElement;
  private readonly clearPinsButton: HTMLButtonElement;
  private readonly tableScroll: HTMLElement;
  private readonly table: HTMLTableElement;
  private readonly tbody: HTMLTableSectionElement;
  private readonly graphCol: HTMLTableColElement;
  private readonly details: HTMLElement;
  private readonly detailsTitle: HTMLElement;
  private readonly detailsToggle: HTMLButtonElement;
  private readonly detailsBody: HTMLElement;

  private visibleCommits: CommitNode[] = [];
  private isDetailsCollapsed = false;
  private lastState: ExplorerUiState | null = null;

  constructor(private readonly callbacks: HistoryPaneCallbacks) {
    const actions = ACTIONS.map(({ action, icon: iconName, tooltip }) => {
      const btn = button({ className: 'toolbar-button', label: GIT_ACTION_LABELS[action], title: tooltip, icon: iconName, showLabel: true });
      btn.addEventListener('click', () => callbacks.onGitAction(action));
      this.actionButtons.push(btn);
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
      btn.addEventListener('click', () => callbacks.onToggleBadgeKind(kind));
      this.toggleButtons.set(kind, btn);
      return btn;
    });

    this.search = createSearchBox('Filter History', (value) => callbacks.onHistoryFilterChange(value));

    const toolbar = el('div', { className: 'toolbar', attrs: { role: 'toolbar', 'aria-label': 'Git history actions' } }, [
      el('div', { className: 'toolbar-group' }, [...actions, this.refreshButton, this.gitGraphButton]),
      el('div', { className: 'toolbar-separator', attrs: { role: 'separator' } }),
      el('div', { className: 'toolbar-group' }, toggles),
      el('div', { className: 'toolbar-spacer' }),
      el('div', { className: 'toolbar-search' }, [this.search.element]),
    ]);

    this.banner = el('div', { className: 'status-banner', attrs: { role: 'alert' } });
    this.banner.hidden = true;

    this.breadcrumbText = el('span', { className: 'breadcrumb-text' });
    this.clearPinsButton = button({ className: 'link-button', label: 'Clear filter', showLabel: true });
    this.clearPinsButton.addEventListener('click', () => callbacks.onClearPins());
    this.busyIndicator = el('span', { className: 'busy-indicator', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.busyIndicator.hidden = true;
    const breadcrumb = el('div', { className: 'breadcrumb' }, [
      this.breadcrumbText,
      this.clearPinsButton,
      el('span', { className: 'toolbar-spacer' }),
      this.busyIndicator,
    ]);

    this.tbody = el('tbody');
    this.tbody.addEventListener('click', (event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('tr[data-hash]') : null;
      if (row?.dataset.hash) {
        callbacks.onSelectCommit(row.dataset.hash);
      }
    });

    const cols = COLUMNS.map((col) => el('col', { className: `col-${col.key}` }));
    this.graphCol = cols[COLUMNS.findIndex((col) => col.key === 'graph')];
    this.table = el('table', { className: 'history-table', attrs: { 'aria-label': 'Commit history' } }, [
      el('colgroup', {}, cols),
      el('thead', {}, [el('tr', {}, COLUMNS.map((col) => el('th', { className: `col-${col.key}`, text: col.label, attrs: { scope: 'col' } })))]),
      this.tbody,
    ]);

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

    for (const btn of this.actionButtons) {
      btn.disabled = snapshot === null || state.isBusy;
    }
    this.refreshButton.disabled = state.isLoading || state.isBusy;
    this.refreshButton.classList.toggle('spinning', state.isLoading);
    this.gitGraphButton.hidden = !state.integrations.gitGraphAvailable;
    this.gitGraphButton.disabled = snapshot === null;
    this.busyIndicator.hidden = !state.isBusy;
    this.busyIndicator.textContent = state.isBusy ? state.busyMessage ?? 'Working\u2026' : '';

    for (const { kind, stateKey } of BADGE_TOGGLES) {
      const pressed = state[stateKey] === true;
      const btn = this.toggleButtons.get(kind);
      btn?.setAttribute('aria-pressed', String(pressed));
      btn?.classList.toggle('active', pressed);
    }
    this.search.sync(state.historyFilterText);

    this.banner.hidden = state.errorMessage === null;
    this.banner.textContent = state.errorMessage ?? '';

    this.renderBreadcrumb(state);
    this.renderRows(state);
    this.renderDetails(state);
    if (state.selectedCommitHash !== null && state.selectedCommitHash !== previousSelection) {
      this.tbody.querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' });
    }
  }

  private renderBreadcrumb(state: ExplorerUiState): void {
    const { snapshot } = state;
    const pinned = snapshot ? getPinnedBranches(snapshot, state) : [];
    this.clearPinsButton.hidden = pinned.length === 0;
    if (!snapshot) {
      this.breadcrumbText.textContent = 'Branches:';
    } else if (pinned.length > 0) {
      this.breadcrumbText.textContent = `Branches: ${pinned.map((b) => b.name).join(', ')}`;
    } else {
      this.breadcrumbText.textContent = `Branches: All (${snapshot.currentBranch})`;
    }
  }

  private renderRows(state: ExplorerUiState): void {
    const { snapshot } = state;
    if (!snapshot) {
      this.visibleCommits = [];
      this.tbody.replaceChildren(this.placeholderRow(state.errorMessage ? 'No history available.' : 'Loading\u2026'));
      return;
    }
    this.visibleCommits = computeVisibleCommits(snapshot, state);
    if (this.visibleCommits.length === 0) {
      const filtered = state.historyFilterText.trim() !== '' || state.pinnedBranchFullNames.size > 0;
      this.tbody.replaceChildren(this.placeholderRow(filtered ? 'No commits match the current filters.' : 'No commits yet.'));
      return;
    }
    const layout = computeGraphLayout(this.visibleCommits);
    const graphColumnWidth = Math.max(MIN_GRAPH_COLUMN_WIDTH, graphWidth(layout[0]?.maxLanesInWindow ?? 1));
    // CSSOM assignment is permitted by the CSP (unlike inline style attributes).
    this.graphCol.style.width = `${graphColumnWidth}px`;
    this.table.style.minWidth = `${FIXED_COLUMNS_WIDTH + MIN_MESSAGE_COLUMN_WIDTH + graphColumnWidth}px`;
    this.tbody.replaceChildren(...this.visibleCommits.map((commit, i) => this.renderRow(commit, layout[i], snapshot, state)));
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
      default:
        return;
    }
    event.preventDefault();
    this.callbacks.onSelectCommit(this.visibleCommits[next].hash);
  }
}
