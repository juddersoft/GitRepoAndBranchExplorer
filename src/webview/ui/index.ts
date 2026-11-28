import type { CommitNode } from '../../types/git';
import type { ExtensionToWebviewMessage, GitAction } from '../../types/messages';
import { isExtensionToWebviewMessage } from '../../types/messages';
import { ContextMenu } from './ContextMenu';
import { CreateBranchModal } from './CreateBranchModal';
import { CreateWorktreeModal } from './CreateWorktreeModal';
import type { StoredColumnWidths } from './columnResize';
import { sanitizeStoredColumnWidths } from './columnResize';
import type { MenuActionId } from './contextMenuModel';
import { buildCommitMenu } from './contextMenuModel';
import { el } from './dom';
import { HistoryPane } from './HistoryPane';
import { computeVisibleCommits, parseHistoryFilterQuery } from './state';
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
let createWorktreeModal: CreateWorktreeModal | null = null;
let fileSearchRequestId = 0;
let activeFileSearch:
  | {
      requestId: number;
      queries: string[];
      results: Map<string, string[]>;
    }
  | null = null;

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
      vscode.postMessage({
        type: 'openCreateBranchDialog',
        payload: { startPoint: commit.hash, sourceKind: 'commit' },
      });
      break;
    case 'createTag':
      postGitAction('createTag', commit.hash);
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
    case 'openCommitInBrowser':
      postGitAction('openCommitInBrowser', commit.hash);
      break;
    default:
      break;
  }
}

function updateHistoryFilter(text: string): void {
  const fileTerms = [...new Set(parseHistoryFilterQuery(text).fileTerms)];
  const searchableTerms = fileTerms.every((term) => term.length <= 500)
    ? fileTerms
    : [];
  activeFileSearch = searchableTerms.length === 0
    ? null
    : {
        requestId: ++fileSearchRequestId,
        queries: searchableTerms,
        results: new Map(),
      };
  setState({
    historyFilterText: text,
    historyFileMatchingHashes: new Set(),
    historyFileSearchPending: activeFileSearch !== null,
  });
  const search = activeFileSearch;
  if (search !== null) {
    for (const query of search.queries) {
      vscode.postMessage({
        type: 'searchCommitsByFile',
        payload: { query, requestId: search.requestId },
      });
    }
  }
}

function showCommitContextMenu(commit: CommitNode, x: number, y: number): void {
  if (state.snapshot) {
    contextMenu.show(x, y, buildCommitMenu(state.snapshot, state, commit), (id) => runCommitMenuAction(id, commit));
  }
}

const historyPane = new HistoryPane({
  onGitAction: (action) => {
    if (action === 'createBranch') {
      vscode.postMessage({ type: 'openCreateBranchDialog', payload: { sourceKind: 'head' } });
    } else {
      postGitAction(action);
    }
  },
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
  onHistoryFilterChange: updateHistoryFilter,
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
  onOpenFile: (file) => vscode.postMessage({ type: 'openFile', payload: file }),
  onOpenInGitGraph: () => vscode.postMessage({ type: 'openInGitGraph' }),
  onOpenCommitInBrowser: (hash) => postGitAction('openCommitInBrowser', hash),
  onSignInGitHub: () => vscode.postMessage({ type: 'signInGitHub' }),
  onLoadMoreCommits: () => {
    setState({ isLoadingMore: true });
    vscode.postMessage({ type: 'loadMoreCommits' });
  },
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

function applyRevealCommit(hash: string, outsideGraph = false): void {
  if (state.snapshot === null) {
    pendingRevealCommitHash = hash;
    return;
  }
  if (outsideGraph) {
    selectCommit(hash);
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
      historyFileMatchingHashes: new Set(),
      historyFileSearchPending: false,
    };
    activeFileSearch = null;
    fileSearchRequestId++;
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
        showFolderCounts: message.payload.showFolderCounts,
        ...(message.payload.trackingOrder === undefined ? {} : { trackingOrder: message.payload.trackingOrder }),
      });
      break;
    case 'repoSnapshot':
      state = reconcileStateWithSnapshot(state, message.payload, knownRemoteNames);
      message.payload.remoteGroups.forEach((group) => knownRemoteNames.add(group.remoteName));
      if (parseHistoryFilterQuery(state.historyFilterText).fileTerms.length > 0) {
        updateHistoryFilter(state.historyFilterText);
      }
      render();
      pendingDetailRequests.clear();
      requestCommitDetailsIfNeeded(state.selectedCommitHash);
      if (pendingRevealCommitHash !== null) {
        const hash = pendingRevealCommitHash;
        pendingRevealCommitHash = null;
        applyRevealCommit(hash);
      }
      break;
    case 'commitsAppended': {
      const snapshot = state.snapshot;
      if (snapshot === null) {
        break;
      }
      const knownHashes = new Set(snapshot.commits.map((commit) => commit.hash));
      const appended = message.payload.commits.filter((commit) => {
        if (knownHashes.has(commit.hash)) {
          return false;
        }
        knownHashes.add(commit.hash);
        return true;
      });
      setState({
        snapshot: {
          ...snapshot,
          commits: [...snapshot.commits, ...appended],
          hasMoreCommits: message.payload.hasMoreCommits,
        },
        isLoadingMore: false,
      });
      if (parseHistoryFilterQuery(state.historyFilterText).fileTerms.length > 0) {
        updateHistoryFilter(state.historyFilterText);
      }
      break;
    }
    case 'repoError':
      setState({ snapshot: null, errorMessage: message.payload.message, isLoading: false, selectedCommitHash: null });
      break;
    case 'commitDetails':
      pendingDetailRequests.delete(message.payload.hash);
      setState({ commitDetails: cacheCommitDetails(state.commitDetails, message.payload) });
      break;
    case 'fileSearchResults': {
      const search = activeFileSearch;
      if (
        search === null ||
        message.payload.requestId !== search.requestId ||
        !search.queries.includes(message.payload.query) ||
        search.results.has(message.payload.query)
      ) {
        break;
      }
      search.results.set(
        message.payload.query,
        [...new Set(message.payload.matchingHashes.map((hash) => hash.toLowerCase()))],
      );
      if (search.results.size < search.queries.length) {
        break;
      }
      const first = new Set(search.results.get(search.queries[0]) ?? []);
      for (const query of search.queries.slice(1)) {
        const matches = new Set(search.results.get(query) ?? []);
        for (const hash of first) {
          if (!matches.has(hash)) {
            first.delete(hash);
          }
        }
      }
      setState({ historyFileMatchingHashes: first, historyFileSearchPending: false });
      break;
    }
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
      applyRevealCommit(message.payload.hash, message.payload.outsideGraph === true);
      break;
    }
    case 'showCreateBranchDialog': {
      const modal = new CreateBranchModal(
        message.payload,
        (payload) => vscode.postMessage({ type: 'submitCreateBranch', payload }),
      );
      modal.open();
      break;
    }
    case 'showCreateWorktreeDialog': {
      createWorktreeModal?.close();
      createWorktreeModal = new CreateWorktreeModal(
        message.payload,
        (payload) => {
          createWorktreeModal = null;
          vscode.postMessage({ type: 'submitCreateWorktree', payload });
        },
        (currentParentPath) =>
          vscode.postMessage({
            type: 'browseWorktreeParentFolder',
            payload: { currentParentPath },
          }),
      );
      createWorktreeModal.open();
      break;
    }
    case 'worktreeParentFolderSelected':
      createWorktreeModal?.updateParentFolder(
        message.payload.parentFolderPath,
        message.payload.existingChildNames,
      );
      break;
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
