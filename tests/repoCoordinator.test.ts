import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchInfo, RepoSnapshot } from '../src/types/git';
import type { ExtensionToWebviewMessage, SyncStatePayload } from '../src/types/messages';

const mocks = vi.hoisted(() => ({
  getRepoSnapshot: vi.fn(),
  checkoutBranch: vi.fn(),
  getCommitDetails: vi.fn(),
  getGitHubRemoteUrl: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  fetchTrackedBranches: vi.fn(),
  pullCurrentBranch: vi.fn(),
  fetchAll: vi.fn(),
  pushCurrentBranch: vi.fn(),
  createBranch: vi.fn(),
  mergeBranch: vi.fn(),
  rebaseOnto: vi.fn(),
  cherryPickCommit: vi.fn(),
  revertCommit: vi.fn(),
  deleteLocalBranch: vi.fn(),
  checkoutRemoteBranch: vi.fn(),
  resetCurrentBranch: vi.fn(),
  revertMergeCommit: vi.fn(),
  openCommitFileDiff: vi.fn(),
  openGitHubCommit: vi.fn(),
  isTrusted: true,
  trustGrantedListeners: [] as Array<() => void>,
}));

vi.mock('vscode', () => {
  const disposable = { dispose: (): void => undefined };
  return {
    Disposable: class {
      constructor(private readonly callback: () => void) {}
      dispose(): void {
        this.callback();
      }
    },
    workspace: {
      workspaceFolders: [{ name: 'repo', uri: { fsPath: '/repo' } }],
      get isTrusted(): boolean {
        return mocks.isTrusted;
      },
      onDidChangeWorkspaceFolders: () => disposable,
      onDidGrantWorkspaceTrust: (listener: () => void) => {
        mocks.trustGrantedListeners.push(listener);
        return disposable;
      },
      createFileSystemWatcher: () => ({
        onDidCreate: () => disposable,
        onDidChange: () => disposable,
        onDidDelete: () => disposable,
        dispose: (): void => undefined,
      }),
    },
    extensions: { onDidChange: () => disposable },
    window: {
      showWarningMessage: mocks.showWarningMessage,
      showErrorMessage: mocks.showErrorMessage,
      showInformationMessage: mocks.showInformationMessage,
      withProgress: (_options: unknown, task: () => Promise<void>) => task(),
    },
    ProgressLocation: { Notification: 15 },
    RelativePattern: class {},
  };
});

vi.mock('../src/git/gitService', () => ({
  GitService: class {
    getRepoSnapshot = mocks.getRepoSnapshot;
    checkoutBranch = mocks.checkoutBranch;
    getGitHubRemoteUrl = mocks.getGitHubRemoteUrl;
    getCommitDetails = mocks.getCommitDetails;
    fetchTrackedBranches = mocks.fetchTrackedBranches;
    pullCurrentBranch = mocks.pullCurrentBranch;
    fetchAll = mocks.fetchAll;
    pushCurrentBranch = mocks.pushCurrentBranch;
    createBranch = mocks.createBranch;
    mergeBranch = mocks.mergeBranch;
    rebaseOnto = mocks.rebaseOnto;
    cherryPickCommit = mocks.cherryPickCommit;
    revertCommit = mocks.revertCommit;
    deleteLocalBranch = mocks.deleteLocalBranch;
    checkoutRemoteBranch = mocks.checkoutRemoteBranch;
    resetCurrentBranch = mocks.resetCurrentBranch;
    revertMergeCommit = mocks.revertMergeCommit;
  },
  isValidCommitHash: (value: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value),
}));
vi.mock('../src/github/githubService', () => ({
  GitHubService: class {
    openCommit = mocks.openGitHubCommit;
  },
}));
vi.mock('../src/git/gitDiffProvider', () => ({ openCommitFileDiff: mocks.openCommitFileDiff }));
vi.mock('../src/git/gitGraphInterop', () => ({ findGitGraphExtensionId: () => null, openInGitGraph: vi.fn() }));

import type { RepoCoordinatorHost, SurfaceId, WebviewSurface } from '../src/webview/RepoCoordinator';
import { RepoCoordinator } from '../src/webview/RepoCoordinator';

const sha = (char: string): string => char.repeat(40);

function branch(name: string, isCurrent: boolean): BranchInfo {
  return {
    name,
    displayName: name,
    fullName: `refs/heads/${name}`,
    isCurrent,
    isRemote: false,
    remoteName: null,
    tipHash: sha('a'),
    upstream: null,
    ahead: 0,
    behind: 0,
    upstreamGone: false,
  };
}

function makeSnapshot(branches: BranchInfo[]): RepoSnapshot {
  return {
    repoName: 'repo',
    repoRoot: '/repo',
    currentBranch: branches.find((b) => b.isCurrent)?.name ?? 'main',
    isDetachedHead: false,
    localBranches: branches,
    remoteGroups: [],
    tags: [{ name: 'v1', fullName: 'refs/tags/v1', targetHash: sha('a') }],
    commits: [],
  };
}

function commitNode(hash: string): RepoSnapshot['commits'][number] {
  return {
    hash,
    shortHash: hash.slice(0, 8),
    parents: [],
    subject: 'commit',
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authorDateIso: '2023-11-14T22:13:20+00:00',
    authorTimestamp: 1700000000,
    refs: [],
  };
}

const MAIN_AND_FEATURE = (): RepoSnapshot => makeSnapshot([branch('main', true), branch('feature', false)]);

interface FakeSurface extends WebviewSurface {
  messages: ExtensionToWebviewMessage[];
  ofType(type: ExtensionToWebviewMessage['type']): ExtensionToWebviewMessage[];
}

function fakeSurface(id: SurfaceId): FakeSurface {
  const messages: ExtensionToWebviewMessage[] = [];
  return {
    id,
    messages,
    post: (message) => void messages.push(message),
    ofType: (type) => messages.filter((m) => m.type === type),
  };
}

const selection = (fullName: string | null, ref: string | null, pinned: string[] = []): SyncStatePayload => ({
  selectedBranchFullName: fullName,
  selectedBranchRef: ref,
  pinnedBranchFullNames: pinned,
});

describe('RepoCoordinator', () => {
  let host: RepoCoordinatorHost & {
    setTabPinned: ReturnType<typeof vi.fn>;
    setShowCheckedOutBadge: ReturnType<typeof vi.fn>;
    setTrackingOrder: ReturnType<typeof vi.fn>;
    openPanel: ReturnType<typeof vi.fn>;
  };
  let showCheckedOutBadge = true;
  let trackingOrder: 'vscode' | 'visualStudio' = 'vscode';
  let coordinator: RepoCoordinator;
  let sidebar: FakeSurface;
  let editor: FakeSurface;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTrusted = true;
    mocks.trustGrantedListeners.length = 0;
    mocks.getRepoSnapshot.mockImplementation(async () => MAIN_AND_FEATURE());
    mocks.getGitHubRemoteUrl.mockResolvedValue(null);
    mocks.checkoutBranch.mockResolvedValue(undefined);
    mocks.openGitHubCommit.mockResolvedValue(true);
    showCheckedOutBadge = true;
    trackingOrder = 'vscode';
    host = {
      getTabPinned: () => false,
      setTabPinned: vi.fn(),
      getShowCheckedOutBadge: () => showCheckedOutBadge,
      setShowCheckedOutBadge: vi.fn(),
      getTrackingOrder: () => trackingOrder,
      setTrackingOrder: vi.fn((order: 'vscode' | 'visualStudio') => {
        trackingOrder = order;
      }),
      openPanel: vi.fn(),
      onCurrentBranchChange: vi.fn(),
    };
    coordinator = new RepoCoordinator(host);
    sidebar = fakeSurface('sidebar');
    editor = fakeSurface('editor');
  });

  async function openBoth(): Promise<void> {
    coordinator.attach(sidebar);
    coordinator.handleMessage('sidebar', { type: 'webviewReady' });
    await vi.waitFor(() => expect(sidebar.ofType('repoSnapshot')).toHaveLength(1));
    coordinator.attach(editor);
    coordinator.handleMessage('editor', { type: 'webviewReady' });
  }

  it('reveals a valid commit immediately and normalizes uppercase hashes', async () => {
    await openBoth();
    coordinator.revealCommit('A'.repeat(40));
    expect(editor.ofType('revealCommit')).toEqual([
      { type: 'revealCommit', payload: { hash: 'a'.repeat(40) } },
    ]);
  });

  it('rejects invalid revealCommit hashes without dispatching', async () => {
    await openBoth();
    for (const hash of ['abc123', '--all', 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65)]) {
      coordinator.revealCommit(hash);
    }
    expect(editor.ofType('revealCommit')).toEqual([]);
  });

  it('queues a reveal during cold start and flushes after the editor snapshot loads', async () => {
    const uppercaseSha256 = 'A'.repeat(64);
    coordinator.revealCommit(uppercaseSha256);
    expect(editor.ofType('revealCommit')).toEqual([]);

    coordinator.attach(editor);
    coordinator.handleMessage('editor', { type: 'webviewReady' });
    await vi.waitFor(() => expect(editor.ofType('revealCommit')).toEqual([
      { type: 'revealCommit', payload: { hash: 'a'.repeat(64) } },
    ]));
  });

  it('waits for editor readiness before revealing into a cached snapshot', async () => {
    const hash = 'b'.repeat(40);
    coordinator.attach(sidebar);
    coordinator.handleMessage('sidebar', { type: 'webviewReady' });
    await vi.waitFor(() => expect(sidebar.ofType('repoSnapshot')).toHaveLength(1));

    coordinator.attach(editor);
    coordinator.revealCommit(hash);
    expect(editor.ofType('revealCommit')).toEqual([]);

    coordinator.handleMessage('editor', { type: 'webviewReady' });
    const messageTypes = editor.messages.map((message) => message.type);
    const snapshotIndex = messageTypes.indexOf('repoSnapshot');
    const revealIndex = messageTypes.indexOf('revealCommit');
    expect(snapshotIndex).toBeGreaterThanOrEqual(0);
    expect(revealIndex).toBeGreaterThan(snapshotIndex);
    expect(editor.ofType('revealCommit')).toEqual([
      { type: 'revealCommit', payload: { hash } },
    ]);

    coordinator.handleMessage('editor', { type: 'webviewReady' });
    expect(editor.ofType('revealCommit')).toHaveLength(1);
  });

  it('notifies repository-change listeners until their disposable is invoked', async () => {
    const listener = vi.fn();
    const registration = coordinator.onDidRepositoryChange(listener);
    await openBoth();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('/repo'));

    registration.dispose();
    await vi.waitFor(() => expect(coordinator.getActiveRepoRoot()).toBe('/repo'));
    mocks.getRepoSnapshot.mockImplementation(async () => makeSnapshot([branch('main', false), branch('feature', true)]));
    coordinator.handleMessage('editor', { type: 'requestRefresh' });
    await vi.waitFor(() => expect(editor.ofType('repoSnapshot')).toHaveLength(2));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid GitHub commit hashes and blocks opening in untrusted workspaces', async () => {
    await expect(coordinator.openCommitOnGitHubByHash('not-a-hash')).resolves.toBe(false);
    expect(mocks.openGitHubCommit).not.toHaveBeenCalled();

    mocks.isTrusted = false;
    await expect(coordinator.openCommitOnGitHubByHash('A'.repeat(40))).resolves.toBe(false);
    expect(mocks.openGitHubCommit).not.toHaveBeenCalled();
  });

  it('opens a valid commit on GitHub only with a loaded GitHub remote', async () => {
    mocks.getGitHubRemoteUrl.mockResolvedValue('https://github.com/owner/repo');
    await openBoth();
    await expect(coordinator.openCommitOnGitHubByHash('A'.repeat(40))).resolves.toBe(true);
    expect(mocks.openGitHubCommit).toHaveBeenCalledWith(
      'https://github.com/owner/repo',
      'a'.repeat(40),
    );
  });

  it('loads once and gives the sidebar tree and the editor timeline the same snapshot', async () => {
    await openBoth();
    expect(mocks.getRepoSnapshot).toHaveBeenCalledTimes(1);
    for (const surface of [sidebar, editor]) {
      expect(surface.messages.map((m) => m.type).slice(0, 2)).toEqual(['initState', 'repoSnapshot']);
    }
    expect(sidebar.ofType('repoSnapshot')[0]).toEqual(editor.ofType('repoSnapshot')[0]);
    expect(host.onCurrentBranchChange).toHaveBeenCalledWith('main');
  });

  it('does not load or run Git commands in an untrusted workspace, then retries after trust', async () => {
    mocks.isTrusted = false;
    coordinator.attach(sidebar);
    coordinator.handleMessage('sidebar', { type: 'webviewReady' });

    expect(mocks.getRepoSnapshot).not.toHaveBeenCalled();
    expect(sidebar.ofType('repoError')).toContainEqual({
      type: 'repoError',
      payload: { code: 'UNTRUSTED_WORKSPACE', message: expect.stringContaining('Trust this workspace') },
    });

    mocks.isTrusted = true;
    for (const listener of mocks.trustGrantedListeners) {
      listener();
    }
    await vi.waitFor(() => expect(mocks.getRepoSnapshot).toHaveBeenCalledTimes(1));
  });

  it('blocks every refresh, mutation, detail and diff request while untrusted and clears diff authorization', async () => {
    mocks.isTrusted = false;
    const diffProvider = {
      setAllowedRepoRoots: vi.fn(),
      clearAllowedRepoRoots: vi.fn(),
    };
    coordinator = new RepoCoordinator(host, diffProvider as never);
    coordinator.attach(sidebar);

    coordinator.handleMessage('sidebar', { type: 'requestRefresh' });
    coordinator.handleMessage('sidebar', { type: 'checkoutBranch', payload: { branchName: 'main' } });
    for (const action of [
      'fetch',
      'fetchTracked',
      'pull',
      'push',
      'createBranch',
      'merge',
      'rebase',
      'cherryPick',
      'revert',
      'revertMerge',
      'deleteBranch',
      'checkoutRemoteBranch',
      'resetMixed',
      'resetHard',
    ]) {
      coordinator.handleMessage('sidebar', {
        type: 'gitAction',
        payload:
          action === 'merge' || action === 'rebase' || action === 'deleteBranch' || action === 'checkoutRemoteBranch'
            ? { action, target: 'main' }
            : action === 'cherryPick' || action === 'revert'
              ? { action, target: sha('a') }
              : action === 'revertMerge' || action === 'resetMixed' || action === 'resetHard'
                ? { action, target: sha('a') }
              : { action },
      });
    }
    coordinator.handleMessage('sidebar', { type: 'requestCommitDetails', payload: { hash: sha('a') } });
    coordinator.handleMessage('sidebar', {
      type: 'openFileDiff',
      payload: { hash: sha('a'), filePath: 'src/a.ts', status: 'M' },
    });

    expect(mocks.getRepoSnapshot).not.toHaveBeenCalled();
    for (const method of [
      mocks.checkoutBranch,
      mocks.fetchAll,
      mocks.fetchTrackedBranches,
      mocks.pullCurrentBranch,
      mocks.pushCurrentBranch,
      mocks.createBranch,
      mocks.mergeBranch,
      mocks.rebaseOnto,
      mocks.cherryPickCommit,
      mocks.revertCommit,
      mocks.deleteLocalBranch,
      mocks.checkoutRemoteBranch,
      mocks.resetCurrentBranch,
      mocks.revertMergeCommit,
      mocks.getCommitDetails,
      mocks.openCommitFileDiff,
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(diffProvider.clearAllowedRepoRoots).toHaveBeenCalled();
    expect(sidebar.ofType('repoError')).not.toHaveLength(0);
  });

  it('aborts reset when the modal is cancelled', async () => {
    await openBoth();
    mocks.showWarningMessage.mockResolvedValueOnce(undefined);

    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action: 'resetHard', target: 'refs/heads/feature' },
    });
    await vi.waitFor(() => expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('permanently discarded'),
      { modal: true },
      'Delete Changes (--hard)',
    ));
    expect(mocks.resetCurrentBranch).not.toHaveBeenCalled();
  });

  it.each([
    ['resetMixed', 'mixed', 'Reset (Keep Changes)'],
    ['resetHard', 'hard', 'Delete Changes (--hard)'],
  ] as const)('confirms %s and resolves the canonical ref before Git', async (action, mode, button) => {
    await openBoth();
    mocks.showWarningMessage.mockResolvedValueOnce(button);

    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action, target: 'refs/heads/feature' },
    });
    await vi.waitFor(() => expect(mocks.resetCurrentBranch).toHaveBeenCalledWith('/repo', 'refs/heads/feature', mode));
  });

  it('blocks reset on detached HEAD', async () => {
    const detached = { ...MAIN_AND_FEATURE(), isDetachedHead: true };
    mocks.getRepoSnapshot.mockImplementation(async () => detached);
    await openBoth();

    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action: 'resetMixed', target: 'refs/heads/feature' },
    });
    await vi.waitFor(() => expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Check out a branch before resetting the current branch.',
    ));
    expect(mocks.resetCurrentBranch).not.toHaveBeenCalled();
  });

  it('rejects revertMerge for a non-merge commit', async () => {
    const snap = {
      ...MAIN_AND_FEATURE(),
      commits: [{ ...commitNode(sha('c')), parents: [sha('a')] }],
    };
    mocks.getRepoSnapshot.mockImplementation(async () => snap);
    await openBoth();

    coordinator.handleMessage('editor', {
      type: 'gitAction',
      payload: { action: 'revertMerge', target: sha('c') },
    });
    await vi.waitFor(() => expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      'Revert Merge requires a merge commit from the loaded repository history.',
    ));
    expect(mocks.revertMergeCommit).not.toHaveBeenCalled();
  });

  it('confirms and executes merge revert with mainline 1', async () => {
    const snap = {
      ...MAIN_AND_FEATURE(),
      commits: [{ ...commitNode(sha('c')), parents: [sha('a'), sha('b')] }],
    };
    mocks.getRepoSnapshot.mockImplementation(async () => snap);
    await openBoth();
    mocks.showWarningMessage.mockResolvedValueOnce('Revert Merge');

    coordinator.handleMessage('editor', {
      type: 'gitAction',
      payload: { action: 'revertMerge', target: sha('c') },
    });
    await vi.waitFor(() => expect(mocks.revertMergeCommit).toHaveBeenCalledWith('/repo', sha('c'), 1));
  });

  it('aborts merge revert when confirmation is cancelled', async () => {
    const snap = {
      ...MAIN_AND_FEATURE(),
      commits: [{ ...commitNode(sha('c')), parents: [sha('a'), sha('b')] }],
    };
    mocks.getRepoSnapshot.mockImplementation(async () => snap);
    await openBoth();
    mocks.showWarningMessage.mockResolvedValueOnce(undefined);

    coordinator.handleMessage('editor', {
      type: 'gitAction',
      payload: { action: 'revertMerge', target: sha('c') },
    });
    await vi.waitFor(() => expect(mocks.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('mainline parent 1'),
      { modal: true },
      'Revert Merge',
    ));
    expect(mocks.revertMergeCommit).not.toHaveBeenCalled();
  });

  it('forwards a selection to the other view only, never echoing it to the sender', async () => {
    await openBoth();
    const picked = selection('refs/heads/feature', 'feature', ['refs/heads/main']);
    coordinator.handleMessage('sidebar', { type: 'syncState', payload: picked });

    expect(editor.ofType('syncState')).toEqual([
      { type: 'syncState', payload: selection(null, null) },
      { type: 'syncState', payload: picked },
    ]);
    expect(sidebar.ofType('syncState')).toEqual([]);

    const cleared = selection(null, null);
    coordinator.handleMessage('editor', { type: 'syncState', payload: cleared });
    expect(sidebar.ofType('syncState')).toEqual([{ type: 'syncState', payload: cleared }]);
    expect(editor.ofType('syncState')).toHaveLength(2);
  });

  it('does not rebroadcast a selection that is already current', async () => {
    await openBoth();
    const picked = selection('refs/tags/v1', 'v1');
    coordinator.handleMessage('sidebar', { type: 'syncState', payload: picked });
    coordinator.handleMessage('sidebar', { type: 'syncState', payload: picked });
    expect(editor.ofType('syncState')).toHaveLength(2);
  });

  it('corrects a selection that names refs the repository does not have', async () => {
    await openBoth();
    coordinator.handleMessage('sidebar', {
      type: 'syncState',
      payload: selection('refs/heads/ghost', 'ghost', ['refs/heads/feature', 'refs/heads/ghost']),
    });
    const corrected = selection(null, null, ['refs/heads/feature']);
    expect(sidebar.ofType('syncState')).toEqual([{ type: 'syncState', payload: corrected }]);
    expect(editor.ofType('syncState')).toEqual([
      { type: 'syncState', payload: selection(null, null) },
      { type: 'syncState', payload: corrected },
    ]);
  });

  it('drops malformed or forged messages without touching state or Git', async () => {
    await openBoth();
    coordinator.handleMessage('sidebar', { type: 'syncState', payload: selection('--force', '--force') });
    coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'merge', target: '--upload-pack=x' } });
    coordinator.handleMessage('sidebar', { type: 'nope' });
    coordinator.handleMessage('sidebar', 'not an object');
    expect(editor.ofType('syncState')).toEqual([
      { type: 'syncState', payload: selection(null, null) },
    ]);
    expect(mocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it('brings a view that opens later up to date, including the current selection', async () => {
    coordinator.attach(sidebar);
    coordinator.handleMessage('sidebar', { type: 'webviewReady' });
    await vi.waitFor(() => expect(sidebar.ofType('repoSnapshot')).toHaveLength(1));
    const picked = selection('refs/heads/feature', 'feature', ['refs/heads/feature']);
    coordinator.handleMessage('sidebar', { type: 'syncState', payload: picked });

    coordinator.attach(editor);
    coordinator.handleMessage('editor', { type: 'webviewReady' });

    expect(editor.messages.map((m) => m.type)).toEqual(['initState', 'repoSnapshot', 'syncState', 'integrationsInfo']);
    expect(editor.ofType('syncState')[0]).toEqual({ type: 'syncState', payload: picked });
    // The cached snapshot is replayed instead of re-running Git.
    expect(mocks.getRepoSnapshot).toHaveBeenCalledTimes(1);
  });

  it('keeps the selection reconciled when a refresh removes the selected branch', async () => {
    await openBoth();
    coordinator.handleMessage('sidebar', {
      type: 'syncState',
      payload: selection('refs/heads/feature', 'feature', ['refs/heads/feature']),
    });
    mocks.getRepoSnapshot.mockImplementation(async () => makeSnapshot([branch('main', true)]));
    coordinator.handleMessage('editor', { type: 'requestRefresh' });
    await vi.waitFor(() => expect(editor.ofType('repoSnapshot')).toHaveLength(2));

    const late = fakeSurface('editor');
    coordinator.attach(late);
    coordinator.handleMessage('editor', { type: 'webviewReady' });
    expect(late.ofType('syncState')).toEqual([{ type: 'syncState', payload: selection(null, null) }]);
  });

  it('mirrors a checkout started in the sidebar as busy status on both views, then refreshes both', async () => {
    await openBoth();
    mocks.getRepoSnapshot.mockImplementation(async () => makeSnapshot([branch('main', false), branch('feature', true)]));
    coordinator.handleMessage('sidebar', { type: 'checkoutBranch', payload: { branchName: 'feature' } });

    await vi.waitFor(() => expect(editor.ofType('repoSnapshot')).toHaveLength(2));
    expect(mocks.checkoutBranch).toHaveBeenCalledWith('/repo', 'feature');
    for (const surface of [sidebar, editor]) {
      const statuses = surface.ofType('actionStatus').map((m) => (m.type === 'actionStatus' ? m.payload.busy : null));
      expect(statuses).toEqual([true, false]);
    }
    expect(host.onCurrentBranchChange).toHaveBeenLastCalledWith('feature');
  });

  it('shows an in-flight operation to a view that opens while it is running', async () => {
    await openBoth();
    let finish: () => void = () => undefined;
    mocks.checkoutBranch.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    coordinator.handleMessage('sidebar', { type: 'checkoutBranch', payload: { branchName: 'feature' } });
    await vi.waitFor(() => expect(sidebar.ofType('actionStatus')).toHaveLength(1));

    const late = fakeSurface('editor');
    coordinator.attach(late);
    coordinator.handleMessage('editor', { type: 'webviewReady' });
    expect(late.ofType('actionStatus')).toEqual([
      { type: 'actionStatus', payload: { busy: true, message: 'Checking out feature\u2026' } },
    ]);
    finish();
    await vi.waitFor(() => expect(sidebar.ofType('actionStatus')).toHaveLength(2));
  });

  it('answers commit details only to the view that asked', async () => {
    const details = { hash: sha('a'), body: 'msg', files: [] };
    mocks.getCommitDetails.mockResolvedValue(details);
    await openBoth();

    coordinator.handleMessage('editor', { type: 'requestCommitDetails', payload: { hash: sha('a') } });
    await vi.waitFor(() => expect(editor.ofType('commitDetails')).toEqual([{ type: 'commitDetails', payload: details }]));
    expect(sidebar.ofType('commitDetails')).toEqual([]);
  });

  it('routes pin changes and panel requests to the host', async () => {
    await openBoth();
    coordinator.handleMessage('editor', { type: 'setTabPinned', payload: { pinned: true } });
    coordinator.handleMessage('sidebar', { type: 'openRepositoryPanel' });
    expect(host.setTabPinned).toHaveBeenCalledWith(true);
    expect(host.openPanel).toHaveBeenCalledTimes(1);
  });

  it('delegates the checked-out badge preference to the host and publishes it to every view', async () => {
    await openBoth();
    expect(sidebar.ofType('initState')[0].payload).toMatchObject({ showCheckedOutBadge: true });

    coordinator.handleMessage('sidebar', { type: 'setShowCheckedOutBadge', payload: { show: false } });
    expect(host.setShowCheckedOutBadge).toHaveBeenCalledWith(false);

    showCheckedOutBadge = false;
    coordinator.publishInitState();
    for (const surface of [sidebar, editor]) {
      const inits = surface.ofType('initState');
      expect(inits[inits.length - 1].payload).toMatchObject({ showCheckedOutBadge: false });
      // The snapshot follows so a webview that treats initState as "loading started" settles again.
      expect(surface.messages[surface.messages.length - 1].type).toBe('repoSnapshot');
    }
  });

  it('includes the default tracking order and broadcasts persisted order changes with the snapshot', async () => {
    await openBoth();
    expect(coordinator.getInitState()).toMatchObject({ trackingOrder: 'vscode' });
    expect(sidebar.ofType('initState')[0].payload).toMatchObject({ trackingOrder: 'vscode' });

    coordinator.handleMessage('sidebar', { type: 'setTrackingOrder', payload: { order: 'visualStudio' } });

    expect(host.setTrackingOrder).toHaveBeenCalledWith('visualStudio');
    for (const surface of [sidebar, editor]) {
      const inits = surface.ofType('initState');
      expect(inits[inits.length - 1].payload).toMatchObject({ trackingOrder: 'visualStudio' });
      expect(surface.messages[surface.messages.length - 1].type).toBe('repoSnapshot');
      expect(surface.ofType('repoSnapshot')).toHaveLength(2);
    }
  });

  it('forgets the repository once every view is gone and reloads for the next one', async () => {
    await openBoth();
    coordinator.handleMessage('sidebar', { type: 'syncState', payload: selection('refs/heads/feature', 'feature') });
    coordinator.detach(editor);
    coordinator.detach(sidebar);

    const reopened = fakeSurface('editor');
    coordinator.attach(reopened);
    coordinator.handleMessage('editor', { type: 'webviewReady' });
    await vi.waitFor(() => expect(reopened.ofType('repoSnapshot')).toHaveLength(1));
    expect(mocks.getRepoSnapshot).toHaveBeenCalledTimes(2);
    expect(reopened.ofType('syncState')).toEqual([]);
  });

  describe('repository menu operations', () => {
    const tracking = (name: string, isCurrent: boolean, patch: Partial<BranchInfo> = {}): BranchInfo => ({
      ...branch(name, isCurrent),
      ...patch,
    });
    const trackedSnapshot = (branches: BranchInfo[]): RepoSnapshot => ({
      ...makeSnapshot(branches),
      remoteGroups: [{ remoteName: 'origin', branches: [] }],
    });
    const loadWith = async (snap: RepoSnapshot): Promise<void> => {
      mocks.getRepoSnapshot.mockImplementation(async () => snap);
      await openBoth();
    };

    it('fetches tracked branches, reloads, and reports which branches were skipped', async () => {
      const snap = trackedSnapshot([tracking('main', true, { upstream: 'origin/main' }), tracking('feature', false)]);
      mocks.fetchTrackedBranches.mockResolvedValue({
        remotes: ['origin'],
        trackedBranches: ['main'],
        skippedBranches: ['feature'],
        fetchedRemotes: ['origin'],
      });
      await loadWith(snap);
      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'fetchTracked' } });

      await vi.waitFor(() => expect(editor.ofType('repoSnapshot')).toHaveLength(2));
      expect(mocks.fetchTrackedBranches).toHaveBeenCalledWith('/repo', snap.localBranches, snap.remoteGroups);
      expect(mocks.showInformationMessage).toHaveBeenCalledWith(
        'Fetched origin for 1 tracked branch. Skipped 1 branch without an upstream: feature.',
      );
      const statuses = sidebar.ofType('actionStatus').map((m) => (m.type === 'actionStatus' ? m.payload.message : null));
      expect(statuses[0]).toBe('Fetching tracked branches\u2026');
    });

    it('does not run Git when no branch tracks a remote, and says so', async () => {
      await loadWith(trackedSnapshot([tracking('main', true), tracking('feature', false)]));
      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'fetchTracked' } });

      await vi.waitFor(() => expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/nothing to fetch/i)));
      expect(mocks.fetchTrackedBranches).not.toHaveBeenCalled();
      expect(sidebar.ofType('actionStatus')).toEqual([]);
    });

    it('reports a failed fetch as an error without a success summary', async () => {
      await loadWith(trackedSnapshot([tracking('main', true, { upstream: 'origin/main' })]));
      mocks.fetchTrackedBranches.mockRejectedValue(new Error('origin: network down'));
      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'fetchTracked' } });

      await vi.waitFor(() => expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('origin: network down')));
      expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    });

    it('refuses to pull when the upstream of the checked-out branch is gone', async () => {
      await loadWith(trackedSnapshot([tracking('main', true, { upstream: 'origin/main', upstreamGone: true })]));
      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'pull' } });

      await vi.waitFor(() => expect(mocks.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/no longer exists/i)));
      expect(mocks.pullCurrentBranch).not.toHaveBeenCalled();
    });
  });

  it('keeps serving the sidebar after the editor tab closes', async () => {
    await openBoth();
    coordinator.detach(editor);
    coordinator.handleMessage('sidebar', { type: 'requestRefresh' });
    await vi.waitFor(() => expect(sidebar.ofType('repoSnapshot')).toHaveLength(2));
  });

  it('ignores a stale detach from a replaced view', async () => {
    await openBoth();
    const replacement = fakeSurface('editor');
    coordinator.attach(replacement);
    coordinator.detach(editor);
    coordinator.handleMessage('sidebar', { type: 'requestRefresh' });
    await vi.waitFor(() => expect(replacement.ofType('repoSnapshot')).toHaveLength(1));
  });
});
