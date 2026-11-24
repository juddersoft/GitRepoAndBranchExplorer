import type { CommitNode } from '../../types/git';
import type { ExtensionToWebviewMessage, GitAction } from '../../types/messages';
import { isExtensionToWebviewMessage } from '../../types/messages';
import { ContextMenu } from './ContextMenu';
import type { StoredColumnWidths } from './columnResize';
import { sanitizeStoredColumnWidths } from './columnResize';
import type { MenuActionId } from './contextMenuModel';
import { buildCommitMenu } from './contextMenuModel';
import { el } from './dom';
import { HistoryPane } from './HistoryPane';
import { computeVisibleCommits } from './state';
import type { BadgeKindToggle, ExplorerUiState } from './state';
import {
  cacheCommitDetails,
  createInitialState,
  normalizeSelection,
  reconcileStateWithSnapshot,
  selectionFromState,
  selectionPatch,
  selectRefPatch,
} from './state';
import { vscode } from './vscodeApi';

/**
 * Editor-tab entry point: the Git action toolbar, ref toggles, filter, commit graph, history table and commit
 * details. The Branch / Remote / Tag tree lives in the Activity Bar view (sidebar.ts); the extension host
 * keeps the snapshot, selection, isolated branches and busy status identical in both.
 */

interface PersistedState {
  showLocalBranchBadges: boolean;
  showRemoteBranchBadges: boolean;
  showTagBadges: boolean;
  columnWidths: StoredColumnWidths;
}

const vscodeStateKeys = ['showLocalBranchBadges', 'showRemoteBranchBadges', 'showTagBadges'] as const;

function readPersistedState(raw: unknown): Partial<Omit<PersistedState, 'columnWidths'>> {
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const r = raw as Record<string, unknown>;
  const result: Partial<Omit<PersistedState, 'columnWidths'>> = {};
  for (const key of vscodeStateKeys) {
    if (typeof r[key] === 'boolean') {
      result[key] = r[key] as boolean;
    }
  }
  return result;
}

function readPersistedColumnWidths(raw: unknown): StoredColumnWidths {
  return typeof raw === 'object' && raw !== null ? sanitizeStoredColumnWidths((raw as Record<string, unknown>).columnWidths) : {};
}

let state: ExplorerUiState = { ...createInitialState(), ...readPersistedState(vscode.getState()) };
let columnWidths: StoredColumnWidths = readPersistedColumnWidths(vscode.getState());
const knownRemoteNames = new Set<string>();
let pendingRevealCommitHash: string | null = null;

function persist(): void {
  const data: PersistedState = {
    showLocalBranchBadges: state.showLocalBranchBadges,
    showRemoteBranchBadges: state.showRemoteBranchBadges,
    showTagBadges: state.showTagBadges,
    columnWidths,
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

const contextMenu = new ContextMenu();

function postGitAction(action: GitAction, target?: string): void {
  vscode.postMessage({ type: 'gitAction', payload: target === undefined ? { action } : { action, target } });
}

function runCommitMenuAction(id: MenuActionId, commit: CommitNode): void {
  switch (id) {
    case 'copyHash':
      vscode.postMessage({ type: 'copyCommitHash', payload: { hash: commit.hash } });
      break;
    case 'createBranchHere':
      vscode.postMessage({ type: 'createBranchAtRef', payload: { startPoint: commit.hash } });
      break;
    case 'cherryPick':
    case 'revert':
    case 'revertMerge':
    case 'resetMixed':
    case 'resetHard':
      postGitAction(id, commit.hash);
      break;
    case 'openGitGraph':
      vscode.postMessage({ type: 'openInGitGraph' });
      break;
    case 'openGitHub':
      vscode.postMessage({ type: 'openCommitOnGitHub', payload: { hash: commit.hash } });
      break;
    default:
      break;
  }
}

function showCommitContextMenu(commit: CommitNode, x: number, y: number): void {
  if (state.snapshot) {
    contextMenu.show(x, y, buildCommitMenu(state.snapshot, state, commit), (id) => runCommitMenuAction(id, commit));
  }
}

const historyPane = new HistoryPane({
  onGitAction: (action) => postGitAction(action),
  onRefresh: requestRefresh,
  onToggleBadgeKind: (kind) => {
    const key = BADGE_STATE_KEYS[kind];
    setState({ [key]: !state[key] });
    persist();
  },
  onToggleTabPinned: () => {
    const pinned = !state.tabPinned;
    setState({ tabPinned: pinned });
    vscode.postMessage({ type: 'setTabPinned', payload: { pinned } });
  },
  onHistoryFilterChange: (text) => setState({ historyFilterText: text }),
  onClearFocus: () => {
    setState({ pinnedBranchFullNames: new Set(), ...selectRefPatch(null) });
    vscode.postMessage({ type: 'syncState', payload: selectionFromState(state) });
  },
  onSelectCommit: selectCommit,
  onCommitContextMenu: showCommitContextMenu,
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
  onColumnWidthsChange: (widths) => {
    columnWidths = widths;
    persist();
  },
}, columnWidths);

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

function render(): void {
  historyPane.update(state);
}

function requestRefresh(): void {
  setState({ isLoading: true });
  vscode.postMessage({ type: 'requestRefresh' });
}

function applyRevealCommit(hash: string): void {
  if (state.snapshot === null) {
    pendingRevealCommitHash = hash;
    return;
  }
  const commitExists = state.snapshot.commits.some((commit) => commit.hash === hash);
  if (!commitExists) {
    return;
  }
  const isVisible = computeVisibleCommits(state.snapshot, state)
    .some((commit) => commit.hash === hash);
  if (!isVisible) {
    const selectionChanged =
      state.selectedBranchFullName !== null ||
      state.selectedBranchRef !== null ||
      state.pinnedBranchFullNames.size > 0;
    state = {
      ...state,
      selectedBranchFullName: null,
      selectedBranchRef: null,
      pinnedBranchFullNames: new Set(),
      historyFilterText: '',
    };
    if (selectionChanged) {
      vscode.postMessage({ type: 'syncState', payload: selectionFromState(state) });
    }
  }
  historyPane.revealCommit(hash);
  selectCommit(hash);
}

function handleMessage(message: ExtensionToWebviewMessage): void {
  switch (message.type) {
    case 'initState':
      // The extension sends initState at the start of every load.
      setState({
        isLoading: true,
        ...(message.payload.tabPinned === undefined ? {} : { tabPinned: message.payload.tabPinned }),
        ...(message.payload.showCheckedOutBadge === undefined ? {} : { showCheckedOutBadge: message.payload.showCheckedOutBadge }),
        ...(message.payload.trackingOrder === undefined ? {} : { trackingOrder: message.payload.trackingOrder }),
      });
      break;
    case 'repoSnapshot':
      state = reconcileStateWithSnapshot(state, message.payload, knownRemoteNames);
      message.payload.remoteGroups.forEach((group) => knownRemoteNames.add(group.remoteName));
      render();
      pendingDetailRequests.clear();
      requestCommitDetailsIfNeeded(state.selectedCommitHash);
      if (pendingRevealCommitHash !== null) {
        const hash = pendingRevealCommitHash;
        pendingRevealCommitHash = null;
        applyRevealCommit(hash);
      }
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
    case 'syncState':
      // Selection or isolation changed in the Activity Bar tree: focus the history on it.
      setState(selectionPatch(normalizeSelection(state.snapshot, message.payload)));
      break;
    case 'revealCommit': {
      applyRevealCommit(message.payload.hash);
      break;
    }
  }
}

function mount(): void {
  const app = document.getElementById('app');
  if (!app) {
    return;
  }
  app.replaceChildren(el('main', { className: 'split' }, [historyPane.element]));
  render();
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (isExtensionToWebviewMessage(event.data)) {
    handleMessage(event.data);
  }
});

mount();
vscode.postMessage({ type: 'webviewReady' });
