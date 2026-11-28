import type { ExtensionToWebviewMessage, GitAction } from '../../types/messages';
import { isExtensionToWebviewMessage } from '../../types/messages';
import { BranchTree } from './BranchTree';
import { ContextMenu } from './ContextMenu';
import type { MenuActionId } from './contextMenuModel';
import { buildRefMenu, buildRepoMenu, buildSettingsMenu, buildStashMenu, buildWorktreeMenu } from './contextMenuModel';
import { el } from './dom';
import type { ExplorerUiState, RefTarget } from './state';
import {
  createInitialState,
  normalizeRepoKey,
  normalizeSelection,
  normalizeTreeNodeKey,
  reconcileStateWithSnapshot,
  reconcileActiveRepoExpansion,
  selectionFromState,
  selectionPatch,
  selectRefPatch,
  toggleNodeExpansion,
  toggleSetMember,
} from './state';
import { vscode } from './vscodeApi';

/**
 * Activity Bar entry point: renders only the Branch / Remote / Tag tree. Selection, isolation, the busy
 * status and the snapshot are kept in step with the editor timeline by the extension host.
 */

function restoredExpandedNodes(): { loaded: boolean; nodes: Set<string>; collapsedRepoNodes: Set<string> } {
  const saved = vscode.getState();
  if (typeof saved !== 'object' || saved === null || !('expandedNodes' in saved)) {
    const initial = createInitialState();
    return { loaded: false, nodes: initial.expandedNodes, collapsedRepoNodes: initial.collapsedRepoNodes };
  }
  const expandedNodes = saved.expandedNodes;
  if (!Array.isArray(expandedNodes) || !expandedNodes.every((node): node is string => typeof node === 'string')) {
    const initial = createInitialState();
    return { loaded: false, nodes: initial.expandedNodes, collapsedRepoNodes: initial.collapsedRepoNodes };
  }
  const collapsedRepoNodes =
    'collapsedRepoNodes' in saved &&
    Array.isArray(saved.collapsedRepoNodes) &&
    saved.collapsedRepoNodes.every((node): node is string => typeof node === 'string')
      ? new Set(saved.collapsedRepoNodes.map(normalizeTreeNodeKey))
      : new Set<string>();
  return { loaded: true, nodes: new Set(expandedNodes.map(normalizeTreeNodeKey)), collapsedRepoNodes };
}

const restoredState = restoredExpandedNodes();
let state: ExplorerUiState = {
  ...createInitialState(),
  expandedNodes: restoredState.nodes,
  collapsedRepoNodes: restoredState.collapsedRepoNodes,
};
const knownRemoteNames = new Set<string>();
const contextMenu = new ContextMenu();

function setState(patch: Partial<ExplorerUiState>): void {
  state = { ...state, ...patch };
  render();
}

/** Applies a selection/isolation change made by the user here and tells the host so the timeline follows. */
function changeSelection(patch: Partial<ExplorerUiState>): void {
  setState(patch);
  vscode.postMessage({ type: 'syncState', payload: selectionFromState(state) });
}

function postGitAction(action: GitAction, target?: string): void {
  vscode.postMessage({ type: 'gitAction', payload: target === undefined ? { action } : { action, target } });
}

function postStashAction(action: 'inspectStash' | 'applyStash' | 'popStash' | 'dropStash', stash: { ref: string; hash: string }): void {
  if (action === 'inspectStash') {
    vscode.postMessage({ type: action, ref: stash.ref, hash: stash.hash });
    return;
  }
  vscode.postMessage({ type: action, ref: stash.ref });
}

function selectRef(target: RefTarget): void {
  // Skip no-op selections so a double-click (two clicks) does not rebuild the tree between them.
  if (state.selectedBranchFullName !== target.fullName) {
    changeSelection(selectRefPatch(target));
  }
}

function runRefMenuAction(id: MenuActionId, target: RefTarget): void {
  switch (id) {
    case 'checkout':
      if (target.branch) {
        vscode.postMessage({ type: 'checkoutBranch', payload: { branchName: target.branch.name } });
      }
      break;
    case 'checkoutRemote':
    case 'merge':
    case 'rebase':
    case 'deleteBranch':
      postGitAction(id === 'checkoutRemote' ? 'checkoutRemoteBranch' : id, target.name);
      break;
    case 'pushTag':
    case 'deleteTag':
      postGitAction(id, target.name);
      break;
    case 'renameBranch':
      postGitAction('renameBranch', target.name);
      break;
    case 'untrackBranch':
      postGitAction('untrackBranch', target.name);
      break;
    case 'createWorktree':
      postGitAction('createWorktree', target.name);
      break;
    case 'openWorktree':
      if (target.branch?.worktreePath) {
        postGitAction('openWorktree', target.branch.worktreePath);
      }
      break;
    case 'resetMixed':
    case 'resetHard':
      postGitAction(id, target.fullName);
      break;
    case 'pull':
    case 'fetch':
      postGitAction(id);
      break;
    case 'push':
    case 'pushAndOpenPr':
    case 'createPrInBrowser':
    case 'openBranchInBrowser':
      postGitAction(id, target.name);
      break;
    case 'stashChanges':
      vscode.postMessage({ type: 'stashChanges' });
      break;
    case 'createBranchHere':
      vscode.postMessage({
        type: 'openCreateBranchDialog',
        payload: {
          startPoint: target.name,
          sourceKind: target.kind === 'remote' ? 'remote' : target.kind === 'local' ? 'local' : 'tag',
        },
      });
      break;
    case 'isolate':
      changeSelection({ pinnedBranchFullNames: toggleSetMember(state.pinnedBranchFullNames, target.fullName) });
      break;
    default:
      break;
  }
}

function runRepoMenuAction(id: MenuActionId): void {
  switch (id) {
    case 'fetchTracked':
    case 'pull':
    case 'push':
    case 'pushAndOpenPr':
    case 'createPrInBrowser':
    case 'openRepoInBrowser':
    case 'publishRepository':
      postGitAction(id);
      break;
    case 'newBranch':
      vscode.postMessage({ type: 'openCreateBranchDialog', payload: { sourceKind: 'head' } });
      break;
    case 'createWorktree':
      postGitAction('createWorktree');
      break;
    case 'stashChanges':
      vscode.postMessage({ type: 'stashChanges' });
      break;
    case 'refresh':
      vscode.postMessage({ type: 'requestRefresh' });
      break;
    default:
      break;
  }
}

function runSettingsMenuAction(id: MenuActionId): void {
  switch (id) {
    case 'toggleCheckedOutBadge': {
      const show = !state.showCheckedOutBadge;
      setState({ showCheckedOutBadge: show });
      vscode.postMessage({ type: 'setShowCheckedOutBadge', payload: { show } });
      break;
    }
    case 'toggleFolderCounts': {
      const show = !state.showFolderCounts;
      setState({ showFolderCounts: show });
      vscode.postMessage({ type: 'setShowFolderCounts', payload: { show } });
      break;
    }
    case 'toggleTrackingOrder': {
      const order = state.trackingOrder === 'vscode' ? 'visualStudio' : 'vscode';
      branchTree.setTrackingOrder(order);
      setState({ trackingOrder: order });
      vscode.postMessage({ type: 'setTrackingOrder', payload: { order } });
      break;
    }
    default:
      break;
  }
}

function showRepoContextMenu(x: number, y: number): void {
  if (state.snapshot) {
    contextMenu.show(
      x,
      y,
      buildRepoMenu(
        state.snapshot,
        state,
        (state.snapshot.remotes?.length ?? 0) > 0 || state.snapshot.remoteGroups.length > 0,
      ),
      runRepoMenuAction,
    );
  }
}

function showSettingsMenu(x: number, y: number): void {
  contextMenu.show(
    x,
    y,
    buildSettingsMenu({
      showCheckedOutBadge: state.showCheckedOutBadge,
      showFolderCounts: state.showFolderCounts,
      trackingOrder: state.trackingOrder,
    }),
    runSettingsMenuAction,
  );
}

function showRefContextMenu(target: RefTarget, x: number, y: number): void {
  selectRef(target);
  if (state.snapshot) {
    contextMenu.show(x, y, buildRefMenu(state.snapshot, state, target), (id) => runRefMenuAction(id, target));
  }
}

function showWorktreeContextMenu(
  worktree: NonNullable<ExplorerUiState['snapshot']>['worktrees'][number],
  x: number,
  y: number,
): void {
  contextMenu.show(x, y, buildWorktreeMenu(worktree), (id) => {
    if (id === 'openWorktree' || id === 'removeWorktree' || id === 'copyWorktreePath') {
      postGitAction(id, worktree.path);
    }
  });
}

function showStashContextMenu(
  stash: NonNullable<NonNullable<ExplorerUiState['snapshot']>['stashes']>[number],
  x: number,
  y: number,
): void {
  contextMenu.show(x, y, buildStashMenu(stash, state), (id) => {
    if (id === 'inspectStash' || id === 'applyStash' || id === 'popStash' || id === 'dropStash') {
      postStashAction(id, stash);
    }
  });
}

const branchTree = new BranchTree({
  onFilterChange: (text) => setState({ branchFilterText: text }),
  onToggleNode: (key) => {
    const expansion = toggleNodeExpansion(state.expandedNodes, state.collapsedRepoNodes, key);
    setState(expansion);
    vscode.setState({
      expandedNodes: [...expansion.expandedNodes],
      collapsedRepoNodes: [...expansion.collapsedRepoNodes],
    });
  },
  onTogglePin: (fullName) => changeSelection({ pinnedBranchFullNames: toggleSetMember(state.pinnedBranchFullNames, fullName) }),
  onCheckout: (branch) => vscode.postMessage({ type: 'checkoutBranch', payload: { branchName: branch.name } }),
  onSelectRef: selectRef,
  onContextMenu: showRefContextMenu,
  onWorktreeContextMenu: showWorktreeContextMenu,
  onOpenWorktree: (worktreePath) => postGitAction('openWorktree', worktreePath),
  onInspectStash: (stash) => postStashAction('inspectStash', stash),
  onStashContextMenu: showStashContextMenu,
  onRepoContextMenu: showRepoContextMenu,
  onSelectRepository: (repoRoot) => {
    vscode.postMessage({ type: 'selectRepository', payload: { repoRoot } });
  },
  onSettingsMenu: showSettingsMenu,
  onCloneRepository: () => vscode.postMessage({ type: 'cloneRepository' }),
  onOpenTimeline: () => vscode.postMessage({ type: 'openRepositoryPanel' }),
});

function render(): void {
  branchTree.update(state);
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
      state = reconcileStateWithSnapshot(state, message.payload, knownRemoteNames, restoredState.loaded);
      state = {
        ...state,
        activeRepoRoot: message.payload.repoRoot,
        expandedNodes: reconcileActiveRepoExpansion(
          state.expandedNodes,
          state.collapsedRepoNodes,
          message.payload.repoRoot,
          true,
        ),
      };
      message.payload.remoteGroups.forEach((group) => knownRemoteNames.add(group.remoteName));
      vscode.setState({
        expandedNodes: [...state.expandedNodes],
        collapsedRepoNodes: [...state.collapsedRepoNodes],
      });
      render();
      break;
    case 'workspaceRepos': {
      const activeChanged =
        message.payload.activeRepoRoot !== null &&
        (state.activeRepoRoot === null ||
          normalizeRepoKey(message.payload.activeRepoRoot) !== normalizeRepoKey(state.activeRepoRoot));
      const activeRepo = message.payload.activeRepoRoot === null
        ? undefined
        : message.payload.repos.find(
            (repo) => normalizeRepoKey(repo.repoRoot) === normalizeRepoKey(message.payload.activeRepoRoot!),
          );
      const expandedNodes = reconcileActiveRepoExpansion(
        state.expandedNodes,
        state.collapsedRepoNodes,
        activeRepo?.repoRoot ?? message.payload.activeRepoRoot,
        activeChanged,
      );
      setState({
        workspaceRepos: message.payload.repos,
        activeRepoRoot: activeRepo?.repoRoot ?? message.payload.activeRepoRoot,
        expandedNodes,
      });
      vscode.setState({
        expandedNodes: [...expandedNodes],
        collapsedRepoNodes: [...state.collapsedRepoNodes],
      });
      break;
    }
    case 'repoError':
      setState({ snapshot: null, errorMessage: message.payload.message, isLoading: false });
      break;
    case 'syncState':
      setState(selectionPatch(normalizeSelection(state.snapshot, message.payload)));
      break;
    case 'actionStatus':
      setState({ isBusy: message.payload.busy, busyMessage: message.payload.message ?? null });
      break;
    case 'commitDetails':
      break;
    case 'integrationsInfo':
      setState({ integrations: message.payload });
      break;
  }
}

function mount(): void {
  const app = document.getElementById('app');
  if (!app) {
    return;
  }
  app.replaceChildren(el('main', { className: 'sidebar-root' }, [branchTree.element]));
  render();
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (isExtensionToWebviewMessage(event.data)) {
    handleMessage(event.data);
  }
});

mount();
vscode.postMessage({ type: 'webviewReady' });
