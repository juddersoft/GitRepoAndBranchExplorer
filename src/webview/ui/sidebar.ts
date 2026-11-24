import type { ExtensionToWebviewMessage, GitAction } from '../../types/messages';
import { isExtensionToWebviewMessage } from '../../types/messages';
import { BranchTree } from './BranchTree';
import { ContextMenu } from './ContextMenu';
import type { MenuActionId } from './contextMenuModel';
import { buildRefMenu, buildRepoMenu } from './contextMenuModel';
import { el } from './dom';
import type { ExplorerUiState, RefTarget } from './state';
import {
  createInitialState,
  normalizeSelection,
  reconcileStateWithSnapshot,
  selectionFromState,
  selectionPatch,
  selectRefPatch,
  toggleSetMember,
} from './state';
import { vscode } from './vscodeApi';

/**
 * Activity Bar entry point: renders only the Branch / Remote / Tag tree. Selection, isolation, the busy
 * status and the snapshot are kept in step with the editor timeline by the extension host.
 */

function restoredExpandedNodes(): { loaded: boolean; nodes: Set<string> } {
  const saved = vscode.getState();
  if (typeof saved !== 'object' || saved === null || !('expandedNodes' in saved)) {
    return { loaded: false, nodes: createInitialState().expandedNodes };
  }
  const expandedNodes = saved.expandedNodes;
  if (!Array.isArray(expandedNodes) || !expandedNodes.every((node): node is string => typeof node === 'string')) {
    return { loaded: false, nodes: createInitialState().expandedNodes };
  }
  return { loaded: true, nodes: new Set(expandedNodes) };
}

const restoredState = restoredExpandedNodes();
let state: ExplorerUiState = { ...createInitialState(), expandedNodes: restoredState.nodes };
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
    case 'resetMixed':
    case 'resetHard':
      postGitAction(id, target.fullName);
      break;
    case 'pull':
    case 'push':
    case 'fetch':
      postGitAction(id);
      break;
    case 'createBranchHere':
      vscode.postMessage({ type: 'createBranchAtRef', payload: { startPoint: target.name } });
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
      postGitAction(id);
      break;
    case 'newBranch':
      postGitAction('createBranch');
      break;
    case 'refresh':
      vscode.postMessage({ type: 'requestRefresh' });
      break;
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
      buildRepoMenu(state.snapshot, state, state.showCheckedOutBadge, state.showFolderCounts, state.trackingOrder),
      runRepoMenuAction,
    );
  }
}

function showRefContextMenu(target: RefTarget, x: number, y: number): void {
  selectRef(target);
  if (state.snapshot) {
    contextMenu.show(x, y, buildRefMenu(state.snapshot, state, target), (id) => runRefMenuAction(id, target));
  }
}

const branchTree = new BranchTree({
  onFilterChange: (text) => setState({ branchFilterText: text }),
  onToggleNode: (key) => {
    const expandedNodes = toggleSetMember(state.expandedNodes, key);
    setState({ expandedNodes });
    vscode.setState({ expandedNodes: [...expandedNodes] });
  },
  onTogglePin: (fullName) => changeSelection({ pinnedBranchFullNames: toggleSetMember(state.pinnedBranchFullNames, fullName) }),
  onCheckout: (branch) => vscode.postMessage({ type: 'checkoutBranch', payload: { branchName: branch.name } }),
  onSelectRef: selectRef,
  onContextMenu: showRefContextMenu,
  onRepoContextMenu: showRepoContextMenu,
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
      message.payload.remoteGroups.forEach((group) => knownRemoteNames.add(group.remoteName));
      render();
      break;
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
    case 'integrationsInfo':
      // Only the editor timeline shows commit details and the Git Graph/GitHub integrations.
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
