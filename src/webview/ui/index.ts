import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../types/messages';
import { isExtensionToWebviewMessage } from '../../types/messages';
import { BranchTree } from './BranchTree';
import { el } from './dom';
import { HistoryPane } from './HistoryPane';
import type { BadgeKindToggle, ExplorerUiState } from './state';
import { cacheCommitDetails, createInitialState, reconcileStateWithSnapshot, toggleSetMember } from './state';

interface VsCodeApi {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  sidebarWidth: number;
  isSidebarCollapsed: boolean;
  showLocalBranchBadges: boolean;
  showRemoteBranchBadges: boolean;
  showTagBadges: boolean;
}

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 160;
const MIN_HISTORY_WIDTH = 320;
const KEYBOARD_RESIZE_STEP = 16;

const vscode = acquireVsCodeApi();

function readPersistedState(raw: unknown): Partial<PersistedState> {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const r = raw as Record<string, unknown>;
  const result: Partial<PersistedState> = {};
  if (typeof r.sidebarWidth === 'number' && Number.isFinite(r.sidebarWidth)) {
    result.sidebarWidth = r.sidebarWidth;
  }
  for (const key of ['isSidebarCollapsed', 'showLocalBranchBadges', 'showRemoteBranchBadges', 'showTagBadges'] as const) {
    if (typeof r[key] === 'boolean') {
      result[key] = r[key] as boolean;
    }
  }
  return result;
}

const persisted = readPersistedState(vscode.getState());
let sidebarWidth = persisted.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH;
let state: ExplorerUiState = { ...createInitialState(), ...persisted };
const knownRemoteNames = new Set<string>();

function persist(): void {
  const data: PersistedState = {
    sidebarWidth,
    isSidebarCollapsed: state.isSidebarCollapsed,
    showLocalBranchBadges: state.showLocalBranchBadges,
    showRemoteBranchBadges: state.showRemoteBranchBadges,
    showTagBadges: state.showTagBadges,
  };
  vscode.setState(data);
}

function setState(patch: Partial<ExplorerUiState>): void {
  state = { ...state, ...patch };
  render();
}

const BADGE_STATE_KEYS: Readonly<Record<BadgeKindToggle, 'showLocalBranchBadges' | 'showRemoteBranchBadges' | 'showTagBadges'>> = {
  local: 'showLocalBranchBadges',
  remote: 'showRemoteBranchBadges',
  tag: 'showTagBadges',
};

const branchTree = new BranchTree({
  onFilterChange: (text) => setState({ branchFilterText: text }),
  onToggleNode: (key) => setState({ expandedNodes: toggleSetMember(state.expandedNodes, key) }),
  onTogglePin: (fullName) => setState({ pinnedBranchFullNames: toggleSetMember(state.pinnedBranchFullNames, fullName) }),
  onCheckout: (branch) => vscode.postMessage({ type: 'checkoutBranch', payload: { branchName: branch.name } }),
  onToggleSidebar: () => {
    setState({ isSidebarCollapsed: !state.isSidebarCollapsed });
    persist();
  },
});

const historyPane = new HistoryPane({
  onGitAction: (action) => vscode.postMessage({ type: 'gitAction', payload: { action } }),
  onRefresh: requestRefresh,
  onToggleBadgeKind: (kind) => {
    const key = BADGE_STATE_KEYS[kind];
    setState({ [key]: !state[key] });
    persist();
  },
  onHistoryFilterChange: (text) => setState({ historyFilterText: text }),
  onClearPins: () => setState({ pinnedBranchFullNames: new Set() }),
  onSelectCommit: selectCommit,
  onCopyHash: (hash) => vscode.postMessage({ type: 'copyCommitHash', payload: { hash } }),
  onOpenFileDiff: (hash, file) =>
    vscode.postMessage({
      type: 'openFileDiff',
      payload: file.oldPath === undefined
        ? { hash, filePath: file.path, status: file.status }
        : { hash, filePath: file.path, oldPath: file.oldPath, status: file.status },
    }),
  onOpenInGitGraph: () => vscode.postMessage({ type: 'openInGitGraph' }),
  onOpenCommitOnGitHub: (hash) => vscode.postMessage({ type: 'openCommitOnGitHub', payload: { hash } }),
  onSignInGitHub: () => vscode.postMessage({ type: 'signInGitHub' }),
});

const pendingDetailRequests = new Set<string>();

function requestCommitDetailsIfNeeded(hash: string | null): void {
  if (hash === null || state.commitDetails.has(hash) || pendingDetailRequests.has(hash)) {
    return;
  }
  pendingDetailRequests.add(hash);
  vscode.postMessage({ type: 'requestCommitDetails', payload: { hash } });
}

function selectCommit(hash: string | null): void {
  setState({ selectedCommitHash: hash });
  requestCommitDetailsIfNeeded(hash);
}

const splitter = el('div', {
  className: 'splitter',
  title: 'Drag to resize. Double-click to reset.',
  attrs: {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize branch pane',
    tabindex: '0',
  },
});

function maxSidebarWidth(): number {
  return Math.max(MIN_SIDEBAR_WIDTH, window.innerWidth - MIN_HISTORY_WIDTH);
}

function applySidebarWidth(width: number): void {
  sidebarWidth = Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), maxSidebarWidth()));
  // CSSOM assignment (not a style attribute), so it is permitted by the webview CSP.
  branchTree.element.style.width = `${sidebarWidth}px`;
  splitter.setAttribute('aria-valuenow', String(sidebarWidth));
  splitter.setAttribute('aria-valuemin', String(MIN_SIDEBAR_WIDTH));
  splitter.setAttribute('aria-valuemax', String(maxSidebarWidth()));
}

function initSplitter(): void {
  let dragStartX = 0;
  let dragStartWidth = 0;

  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    dragStartX = event.clientX;
    dragStartWidth = sidebarWidth;
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    event.preventDefault();
  });
  splitter.addEventListener('pointermove', (event) => {
    if (splitter.hasPointerCapture(event.pointerId)) {
      applySidebarWidth(dragStartWidth + event.clientX - dragStartX);
    }
  });
  const endDrag = (event: PointerEvent): void => {
    if (splitter.hasPointerCapture(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing');
    persist();
  };
  splitter.addEventListener('pointerup', endDrag);
  splitter.addEventListener('pointercancel', endDrag);
  splitter.addEventListener('dblclick', () => {
    applySidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    persist();
  });
  splitter.addEventListener('keydown', (event) => {
    const delta = event.key === 'ArrowLeft' ? -KEYBOARD_RESIZE_STEP : event.key === 'ArrowRight' ? KEYBOARD_RESIZE_STEP : 0;
    if (delta !== 0) {
      applySidebarWidth(sidebarWidth + delta);
      persist();
      event.preventDefault();
    }
  });
  window.addEventListener('resize', () => applySidebarWidth(sidebarWidth));
}

function render(): void {
  branchTree.element.hidden = state.isSidebarCollapsed;
  splitter.hidden = state.isSidebarCollapsed;
  branchTree.collapsedStrip.hidden = !state.isSidebarCollapsed;
  branchTree.update(state);
  historyPane.update(state);
}

function requestRefresh(): void {
  setState({ isLoading: true });
  vscode.postMessage({ type: 'requestRefresh' });
}

function handleMessage(message: ExtensionToWebviewMessage): void {
  switch (message.type) {
    case 'initState':
      // The extension sends initState at the start of every load.
      setState({ isLoading: true });
      break;
    case 'repoSnapshot':
      state = reconcileStateWithSnapshot(state, message.payload, knownRemoteNames);
      message.payload.remoteGroups.forEach((group) => knownRemoteNames.add(group.remoteName));
      render();
      pendingDetailRequests.clear();
      requestCommitDetailsIfNeeded(state.selectedCommitHash);
      break;
    case 'repoError':
      setState({ snapshot: null, errorMessage: message.payload.message, isLoading: false, selectedCommitHash: null });
      break;
    case 'commitDetails':
      pendingDetailRequests.delete(message.payload.hash);
      setState({ commitDetails: cacheCommitDetails(state.commitDetails, message.payload) });
      break;
    case 'integrationsInfo':
      setState({ integrations: message.payload });
      break;
    case 'actionStatus':
      setState({ isBusy: message.payload.busy, busyMessage: message.payload.message ?? null });
      break;
  }
}

function mount(): void {
  const app = document.getElementById('app');
  if (!app) {
    return;
  }
  app.replaceChildren(
    el('main', { className: 'split' }, [branchTree.collapsedStrip, branchTree.element, splitter, historyPane.element]),
  );
  initSplitter();
  applySidebarWidth(sidebarWidth);
  render();
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (isExtensionToWebviewMessage(event.data)) {
    handleMessage(event.data);
  }
});

mount();
vscode.postMessage({ type: 'webviewReady' });
