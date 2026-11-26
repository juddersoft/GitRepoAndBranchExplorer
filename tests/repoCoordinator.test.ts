import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitExecutionError } from '../src/git/gitExecutor';
import type { BranchInfo, RepoSnapshot } from '../src/types/git';
import type { ExtensionToWebviewMessage, SyncStatePayload } from '../src/types/messages';

const mocks = vi.hoisted(() => ({
  getRepoSnapshot: vi.fn(),
  getCommitPage: vi.fn(),
  checkoutBranch: vi.fn(),
  getCommitDetails: vi.fn(),
  getGitHubRemoteUrl: vi.fn(),
  getRemoteUrl: vi.fn(),
  getRemoteRawUrl: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
  showInputBox: vi.fn(),
  showOpenDialog: vi.fn(),
  fetchTrackedBranches: vi.fn(),
  pullCurrentBranch: vi.fn(),
  fetchAll: vi.fn(),
  pushCurrentBranch: vi.fn(),
  pushToRemoteBranch: vi.fn(),
  openExternal: vi.fn(),
  createBranch: vi.fn(),
  hasWorkingTreeChanges: vi.fn(),
  resolveCommitHash: vi.fn(),
  stashChanges: vi.fn(),
  discardWorkingTreeChanges: vi.fn(),
  addWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  clipboardWriteText: vi.fn(),
  renameLocalBranch: vi.fn(),
  unsetBranchUpstream: vi.fn(),
  addRemote: vi.fn(),
  initBareRepository: vi.fn(),
  getPublishSession: vi.fn(),
  listPublishOwners: vi.fn(),
  createRepository: vi.fn(),
  mergeBranch: vi.fn(),
  rebaseOnto: vi.fn(),
  cherryPickCommit: vi.fn(),
  revertCommit: vi.fn(),
  deleteLocalBranch: vi.fn(),
  checkoutRemoteBranch: vi.fn(),
  resetCurrentBranch: vi.fn(),
  revertMergeCommit: vi.fn(),
  openCommitFileDiff: vi.fn(),
  buildShowUri: vi.fn(),
  stat: vi.fn(),
  showTextDocument: vi.fn(),
  openGitHubCommit: vi.fn(),
  isTrusted: true,
  trustGrantedListeners: [] as Array<() => void>,
  getCommands: vi.fn(),
  executeCommand: vi.fn(),
  discoverWorkspaceRepositories: vi.fn(),
  createFileSystemWatcher: vi.fn(),
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
      onDidChangeConfiguration: () => disposable,
      getConfiguration: () => ({ get: (_key: string, fallback: string) => fallback }),
      createFileSystemWatcher: mocks.createFileSystemWatcher,
    },
    extensions: { onDidChange: () => disposable },
    window: {
      showWarningMessage: mocks.showWarningMessage,
      showErrorMessage: mocks.showErrorMessage,
      showInformationMessage: mocks.showInformationMessage,
      showQuickPick: mocks.showQuickPick,
      showInputBox: mocks.showInputBox,
      showOpenDialog: mocks.showOpenDialog,
      withProgress: (_options: unknown, task: () => Promise<void>) => task(),
      showTextDocument: mocks.showTextDocument,
    },
    Uri: {
      file: (fsPath: string) => ({ scheme: 'file', fsPath }),
      parse: (url: string, strict: boolean) => ({ url, strict }),
    },
    env: { openExternal: mocks.openExternal, clipboard: { writeText: mocks.clipboardWriteText } },
    commands: {
      getCommands: mocks.getCommands,
      executeCommand: mocks.executeCommand,
    },
    ProgressLocation: { Notification: 15 },
    RelativePattern: class {
      constructor(
        public readonly base: string,
        public readonly pattern: string,
      ) {}
    },
  };
});

vi.mock('../src/git/gitService', () => ({
  GitService: class {
    getRepoSnapshot = mocks.getRepoSnapshot;
    getCommitPage = mocks.getCommitPage;
    checkoutBranch = mocks.checkoutBranch;
    getGitHubRemoteUrl = mocks.getGitHubRemoteUrl;
    getRemoteUrl = mocks.getRemoteUrl;
    getRemoteRawUrl = mocks.getRemoteRawUrl;
    getCommitDetails = mocks.getCommitDetails;
    fetchTrackedBranches = mocks.fetchTrackedBranches;
    pullCurrentBranch = mocks.pullCurrentBranch;
    fetchAll = mocks.fetchAll;
    pushCurrentBranch = mocks.pushCurrentBranch;
    pushToRemoteBranch = mocks.pushToRemoteBranch;
    createBranch = mocks.createBranch;
    hasWorkingTreeChanges = mocks.hasWorkingTreeChanges;
    resolveCommitHash = mocks.resolveCommitHash;
    stashChanges = mocks.stashChanges;
    discardWorkingTreeChanges = mocks.discardWorkingTreeChanges;
    addWorktree = mocks.addWorktree;
    removeWorktree = mocks.removeWorktree;
    renameLocalBranch = mocks.renameLocalBranch;
    unsetBranchUpstream = mocks.unsetBranchUpstream;
    addRemote = mocks.addRemote;
    initBareRepository = mocks.initBareRepository;
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

vi.mock('fs', () => ({ promises: { stat: mocks.stat } }));
vi.mock('../src/github/githubService', () => ({
  GitHubService: class {
    openCommit = mocks.openGitHubCommit;
    getPublishSession = mocks.getPublishSession;
    listPublishOwners = mocks.listPublishOwners;
    createRepository = mocks.createRepository;
  },
}));
vi.mock('../src/git/gitDiffProvider', () => ({
  openCommitFileDiff: mocks.openCommitFileDiff,
  buildShowUri: mocks.buildShowUri,
  normalizeRepoRootPath: (root: string) => root.replace(/[\\/]+$/, '').toLowerCase(),
}));
vi.mock('../src/git/repoDiscovery', () => ({
  canonicalizeRepoPath: (root: string) => {
    const trimmed = root.replace(/[\\/]+$/, '');
    return /^[A-Za-z]:/.test(trimmed) ? trimmed.toLowerCase().replace(/\//g, '\\') : trimmed;
  },
  discoverWorkspaceRepositories: mocks.discoverWorkspaceRepositories,
}));
vi.mock('../src/git/gitGraphInterop', () => ({ findGitGraphExtensionId: () => null, openInGitGraph: vi.fn() }));

import type { RepoCoordinatorHost, SurfaceId, WebviewSurface } from '../src/webview/RepoCoordinator';
import { RepoCoordinator } from '../src/webview/RepoCoordinator';

const sha = (char: string): string => char.repeat(40);
const indexedSha = (index: number): string => index.toString(16).padStart(40, '0');

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
    worktrees: [],
    tags: [{ name: 'v1', fullName: 'refs/tags/v1', targetHash: sha('a') }],
    commits: [],
    hasMoreCommits: false,
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
    setShowFolderCounts: ReturnType<typeof vi.fn>;
    setTrackingOrder: ReturnType<typeof vi.fn>;
    openPanel: ReturnType<typeof vi.fn>;
  };
  let showCheckedOutBadge = true;
  let showFolderCounts = true;
  let trackingOrder: 'vscode' | 'visualStudio' = 'vscode';
  let coordinator: RepoCoordinator;
  let sidebar: FakeSurface;
  let editor: FakeSurface;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTrusted = true;
    mocks.trustGrantedListeners.length = 0;
    mocks.getRepoSnapshot.mockImplementation(async () => MAIN_AND_FEATURE());
    mocks.createFileSystemWatcher.mockImplementation(() => ({
      onDidCreate: () => ({ dispose: (): void => undefined }),
      onDidChange: () => ({ dispose: (): void => undefined }),
      onDidDelete: () => ({ dispose: (): void => undefined }),
      dispose: vi.fn(),
    }));
    mocks.discoverWorkspaceRepositories.mockResolvedValue([{
      repoRoot: '/repo',
      repoName: 'repo',
      commonDir: '/repo/.git',
      currentBranch: 'main',
      isDetachedHead: false,
    }]);
    mocks.getCommitPage.mockResolvedValue({ commits: [], hasMoreCommits: false });
    mocks.getCommitDetails.mockResolvedValue({ hash: sha('d'), body: 'details', files: [] });
    mocks.getGitHubRemoteUrl.mockResolvedValue(null);
    mocks.getRemoteUrl.mockResolvedValue(null);
    mocks.getRemoteRawUrl.mockResolvedValue('https://example.com/owner/repo.git');
    mocks.getCommands.mockResolvedValue([]);
    mocks.executeCommand.mockResolvedValue(undefined);
    mocks.checkoutBranch.mockResolvedValue(undefined);
    mocks.hasWorkingTreeChanges.mockResolvedValue(false);
    mocks.resolveCommitHash.mockResolvedValue(sha('a'));
    mocks.createBranch.mockResolvedValue(undefined);
    mocks.addWorktree.mockResolvedValue(undefined);
    mocks.removeWorktree.mockResolvedValue(undefined);
    mocks.clipboardWriteText.mockResolvedValue(undefined);
    mocks.stashChanges.mockResolvedValue(undefined);
    mocks.discardWorkingTreeChanges.mockResolvedValue(undefined);
    mocks.renameLocalBranch.mockResolvedValue(undefined);
    mocks.addRemote.mockResolvedValue(undefined);
    mocks.initBareRepository.mockResolvedValue(undefined);
    mocks.getPublishSession.mockResolvedValue({ accessToken: 'token', account: { label: 'Alice' } });
    mocks.listPublishOwners.mockResolvedValue([{ login: 'alice', type: 'user' }]);
    mocks.createRepository.mockResolvedValue({
      cloneUrl: 'https://github.com/alice/project.git',
      htmlUrl: 'https://github.com/alice/project',
      fullName: 'alice/project',
      isPrivate: true,
    });
    mocks.openGitHubCommit.mockResolvedValue(true);
    mocks.openExternal.mockResolvedValue(true);
    showCheckedOutBadge = true;
    showFolderCounts = true;
    mocks.stat.mockResolvedValue({ isFile: () => true });
    mocks.buildShowUri.mockImplementation((repoRoot: string, revSpec: string, filePath: string) => ({
      scheme: 'git-repo-explorer-show',
      repoRoot,
      revSpec,
      filePath,
    }));
    mocks.showTextDocument.mockResolvedValue(undefined);
    trackingOrder = 'vscode';
    host = {
      getTabPinned: () => false,
      setTabPinned: vi.fn(),
      getShowCheckedOutBadge: () => showCheckedOutBadge,
      setShowCheckedOutBadge: vi.fn(),
      getShowFolderCounts: () => showFolderCounts,
      setShowFolderCounts: vi.fn((show: boolean) => {
        showFolderCounts = show;
      }),
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

  it('switches only to discovered repositories and resets repo-scoped selection', async () => {
    const diffProvider = {
      setAllowedRepoRoots: vi.fn(),
      clearAllowedRepoRoots: vi.fn(),
    };
    mocks.discoverWorkspaceRepositories.mockResolvedValue([
      { repoRoot: '/repo', repoName: 'repo', commonDir: '/repo/.git', currentBranch: 'main' },
      { repoRoot: '/other', repoName: 'other', commonDir: '/other/.git', currentBranch: 'dev' },
    ]);
    mocks.getRepoSnapshot.mockImplementation(async (root: string) => ({
      ...MAIN_AND_FEATURE(),
      repoRoot: root,
      repoName: path.basename(root),
    }));
    coordinator = new RepoCoordinator(host, diffProvider as never);
    sidebar = fakeSurface('sidebar');
    await openBoth();
    coordinator.handleMessage('sidebar', {
      type: 'syncState',
      payload: selection('refs/heads/feature', 'feature', ['refs/heads/main']),
    });

    mocks.getRepoSnapshot.mockClear();
    mocks.discoverWorkspaceRepositories.mockClear();
    coordinator.handleMessage('sidebar', {
      type: 'selectRepository',
      payload: { repoRoot: '/repo-evil' },
    });
    expect(mocks.getRepoSnapshot).not.toHaveBeenCalled();
    expect(mocks.discoverWorkspaceRepositories).not.toHaveBeenCalled();
    expect(mocks.fetchAll).not.toHaveBeenCalled();

    coordinator.handleMessage('sidebar', {
      type: 'selectRepository',
      payload: { repoRoot: '/other' },
    });
    await vi.waitFor(() => expect(coordinator.getActiveRepoRoot()).toBe('/other'));
    expect(mocks.getRepoSnapshot).toHaveBeenLastCalledWith('/other');
    expect(sidebar.ofType('syncState').at(-1)).toMatchObject({
      payload: { selectedBranchFullName: null, selectedBranchRef: null, pinnedBranchFullNames: [] },
    });
    expect([...diffProvider.setAllowedRepoRoots.mock.calls.at(-1)?.[0] as Iterable<string>]).toEqual([
      '/repo',
      '/other',
    ]);
    expect(mocks.createFileSystemWatcher.mock.calls.map((call) => call[0]?.base)).toEqual([
      '/repo',
      '/other',
    ]);
  });

  it('reuses the exact discovered root when Git returns a differently formatted Windows path', async () => {
    const discoveredRoot = String.raw`F:\Syncthing\Projects\Repo`;
    mocks.discoverWorkspaceRepositories.mockResolvedValue([
      {
        repoRoot: discoveredRoot,
        repoName: 'Repo',
        commonDir: String.raw`F:\Syncthing\Projects\Repo\.git`,
        currentBranch: 'main',
      },
    ]);
    mocks.getRepoSnapshot.mockResolvedValue({
      ...MAIN_AND_FEATURE(),
      repoRoot: 'f:/Syncthing/Projects/Repo',
      repoName: 'Repo',
    });

    await openBoth();

    expect(sidebar.ofType('workspaceRepos').at(-1)).toMatchObject({
      payload: { activeRepoRoot: discoveredRoot },
    });
    expect(sidebar.ofType('repoSnapshot').at(-1)).toMatchObject({
      payload: { repoRoot: discoveredRoot },
    });
    expect(coordinator.getActiveRepoRoot()).toBe(discoveredRoot);
  });

  it('finds the longest owning repository for file blame and resolves its remote', async () => {
    mocks.discoverWorkspaceRepositories.mockResolvedValue([
      { repoRoot: '/work', repoName: 'work', commonDir: '/work/.git' },
      { repoRoot: '/work/child', repoName: 'child', commonDir: '/work/child/.git' },
    ]);
    mocks.getRepoSnapshot.mockImplementation(async () => ({ ...MAIN_AND_FEATURE(), repoRoot: '/work' }));
    mocks.getGitHubRemoteUrl.mockImplementation(async (root: string) =>
      root === '/work/child' ? 'https://github.com/example/child' : 'https://github.com/example/work',
    );
    await openBoth();

    expect(coordinator.getRepoRootForFile('/work/child/src/file.ts')).toBe('/work/child');
    expect(coordinator.getRepoRootForFile('/work-sibling/file.ts')).toBeNull();
    await expect(coordinator.getGithubRemoteUrlForRepo('/work/child')).resolves.toBe(
      'https://github.com/example/child',
    );
  });

  it('matches the longest Windows repository root case-insensitively without sibling collisions', async () => {
    mocks.discoverWorkspaceRepositories.mockResolvedValue([
      { repoRoot: 'C:\\Repos\\App', repoName: 'App', commonDir: 'C:\\Repos\\App\\.git' },
      { repoRoot: 'C:\\Repos\\App\\Nested', repoName: 'Nested', commonDir: 'C:\\Repos\\App\\Nested\\.git' },
    ]);
    mocks.getRepoSnapshot.mockImplementation(async () => ({
      ...MAIN_AND_FEATURE(),
      repoRoot: 'C:\\Repos\\App',
      repoName: 'App',
    }));
    await openBoth();

    expect(coordinator.getRepoRootForFile('c:\\repos\\APP\\nested\\src\\file.ts')).toBe(
      'C:\\Repos\\App\\Nested',
    );
    expect(coordinator.getRepoRootForFile('C:\\REPOS\\app-evil\\file.ts')).toBeNull();
  });

  it('loads more commits single-flight and broadcasts only deduplicated appends', async () => {
    const snapshot = MAIN_AND_FEATURE();
    snapshot.commits = [commitNode(sha('a'))];
    snapshot.hasMoreCommits = true;
    mocks.getRepoSnapshot.mockResolvedValue(snapshot);
    let resolvePage: ((value: { commits: RepoSnapshot['commits']; hasMoreCommits: boolean }) => void) | undefined;
    mocks.getCommitPage.mockImplementation(
      () => new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    await openBoth();

    coordinator.handleMessage('editor', { type: 'loadMoreCommits' });
    coordinator.handleMessage('editor', { type: 'loadMoreCommits' });
    expect(mocks.getCommitPage).toHaveBeenCalledTimes(1);
    resolvePage?.({
      commits: [commitNode(sha('a')), commitNode(sha('b'))],
      hasMoreCommits: false,
    });

    await vi.waitFor(() => expect(editor.ofType('commitsAppended')).toEqual([
      {
        type: 'commitsAppended',
        payload: { commits: [commitNode(sha('b'))], hasMoreCommits: false },
      },
    ]));
    expect(sidebar.ofType('commitsAppended')).toEqual(editor.ofType('commitsAppended'));
  });

  it('queues a smart remote branch dialog and sends it to a ready editor', async () => {
      const snapshot = MAIN_AND_FEATURE();
      const remote: BranchInfo = {
        ...branch('origin/feature/pdj/foo', false),
        displayName: 'feature/pdj/foo',
        fullName: 'refs/remotes/origin/feature/pdj/foo',
        isRemote: true,
        remoteName: 'origin',
      };
      snapshot.remoteGroups = [{ remoteName: 'origin', branches: [remote] }];
      mocks.getRepoSnapshot.mockResolvedValue(snapshot);
      await openBoth();

      coordinator.handleMessage('sidebar', {
        type: 'openCreateBranchDialog',
        payload: { startPoint: remote.name, sourceKind: 'remote' },
      });

      expect(host.openPanel).toHaveBeenCalled();
      expect(editor.ofType('showCreateBranchDialog')).toContainEqual({
        type: 'showCreateBranchDialog',
        payload: {
          sourceKind: 'remote',
          startPoint: remote.fullName,
          startLabel: remote.name,
          initialName: 'feature/pdj/foo',
          remoteTrackingRef: remote.name,
          existingLocalBranches: ['main', 'feature'],
        },
      });
    });

    it('creates a branch without checkout without inspecting the worktree', async () => {
      await openBoth();
      coordinator.handleMessage('editor', {
        type: 'submitCreateBranch',
        payload: { branchName: 'topic/new', checkout: false, track: false },
      });
      await vi.waitFor(() => expect(mocks.createBranch).toHaveBeenCalledWith(
        '/repo',
        'topic/new',
        undefined,
        { checkout: false, track: false },
      ));
      expect(mocks.hasWorkingTreeChanges).not.toHaveBeenCalled();
    });

    it('stashes a dirty worktree before checking out a new branch', async () => {
      await openBoth();
      mocks.hasWorkingTreeChanges.mockResolvedValue(true);
      mocks.showQuickPick.mockResolvedValueOnce({ label: 'Stash Changes & Switch' });
      coordinator.handleMessage('editor', {
        type: 'submitCreateBranch',
        payload: { branchName: 'topic/stashed', checkout: true, track: false },
      });

      await vi.waitFor(() => expect(mocks.createBranch).toHaveBeenCalled());
      expect(mocks.stashChanges).toHaveBeenCalledWith('/repo', 'Auto-stash before creating topic/stashed');
      expect(mocks.stashChanges.mock.invocationCallOrder[0]).toBeLessThan(mocks.createBranch.mock.invocationCallOrder[0]);
    });

    it('confirms destructive discard before creating a branch', async () => {
      await openBoth();
      mocks.hasWorkingTreeChanges.mockResolvedValue(true);
      mocks.showQuickPick
        .mockResolvedValueOnce({ label: 'Discard Changes & Switch' })
        .mockResolvedValueOnce({ label: 'Yes, Discard All Changes' });
      coordinator.handleMessage('editor', {
        type: 'submitCreateBranch',
        payload: { branchName: 'topic/discard', checkout: true, track: false },
      });

      await vi.waitFor(() => expect(mocks.discardWorkingTreeChanges).toHaveBeenCalledWith('/repo'));
      expect(mocks.showQuickPick).toHaveBeenNthCalledWith(2, expect.any(Array), {
        title: 'Confirm Permanent Discard',
        placeHolder:
          'Permanently discard all uncommitted and untracked changes? This action cannot be undone.',
        ignoreFocusOut: true,
      });
    });

    it('renames a known local branch and refreshes the snapshot', async () => {
      await openBoth();
      mocks.showInputBox.mockResolvedValue('feature-renamed');
      coordinator.handleMessage('sidebar', {
        type: 'gitAction',
        payload: { action: 'renameBranch', target: 'feature' },
      });
      await vi.waitFor(() => expect(mocks.renameLocalBranch).toHaveBeenCalledWith(
        '/repo',
        'feature',
        'feature-renamed',
      ));
  });

  it('untracks a known local branch upstream', async () => {
    const snapshot = makeSnapshot([
      { ...branch('main', true), upstream: 'origin/main' },
      branch('feature', false),
    ]);
    mocks.getRepoSnapshot.mockResolvedValue(snapshot);
    await openBoth();

    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action: 'untrackBranch', target: 'main' },
    });

    await vi.waitFor(() => expect(mocks.unsetBranchUpstream).toHaveBeenCalledWith('/repo', 'main'));
  });

  it('shows an irreversible silent delete confirmation', async () => {
    await openBoth();
    mocks.showQuickPick.mockResolvedValueOnce({ label: 'Delete Branch "feature"' });

    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action: 'deleteBranch', target: 'feature' },
    });

    await vi.waitFor(() => expect(mocks.deleteLocalBranch).toHaveBeenCalledWith('/repo', 'feature'));
    expect(mocks.showQuickPick).toHaveBeenCalledWith(expect.any(Array), {
      title: 'Delete Branch "feature"',
      placeHolder:
        'Warning: You are about to permanently delete local branch "feature". This action cannot be undone.',
      ignoreFocusOut: true,
    });
  });

  it('offers guided repository publish choices', async () => {
    await openBoth();
    mocks.showQuickPick.mockResolvedValueOnce({ label: 'Cancel' });

    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action: 'publishRepository' },
    });

    await vi.waitFor(() => expect(mocks.showQuickPick).toHaveBeenCalled());
    const items = mocks.showQuickPick.mock.calls[0][0];
    expect(items.map((item: { label: string }) => item.label)).toEqual([
      'Create & Publish Repository on GitHub…',
      'Create Local Bare Remote on Disk…',
      'Add Existing Remote URL (origin)…',
      'Cancel',
    ]);
  });

  it('adds an origin remote manually from the publish workflow', async () => {
    await openBoth();
    mocks.showQuickPick.mockResolvedValueOnce({ label: 'Add Existing Remote URL (origin)…' });
    mocks.showInputBox.mockResolvedValueOnce('https://github.com/user/repo.git');

    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action: 'publishRepository' },
    });

    await vi.waitFor(() => expect(mocks.addRemote).toHaveBeenCalledWith(
      '/repo',
      'origin',
      'https://github.com/user/repo.git',
    ));
  });

  it('auto-pages a deep reveal until the commit is found', async () => {
    const snapshot = MAIN_AND_FEATURE();
    snapshot.commits = [commitNode(indexedSha(1))];
    snapshot.hasMoreCommits = true;
    const target = indexedSha(3);
    mocks.getRepoSnapshot.mockResolvedValue(snapshot);
    mocks.getCommitPage
      .mockResolvedValueOnce({ commits: [commitNode(indexedSha(2))], hasMoreCommits: true })
      .mockResolvedValueOnce({ commits: [commitNode(target)], hasMoreCommits: false });
    await openBoth();

    coordinator.revealCommit(target);
    await vi.waitFor(() => expect(editor.ofType('revealCommit')).toEqual([
      { type: 'revealCommit', payload: { hash: target } },
    ]));
    expect(mocks.getCommitPage).toHaveBeenCalledTimes(2);
    expect(mocks.getCommitPage).toHaveBeenNthCalledWith(1, '/repo', 1);
    expect(mocks.getCommitPage).toHaveBeenNthCalledWith(2, '/repo', 2);
  });

  it('falls back to direct details after the deep reveal search cap', async () => {
    const snapshot = MAIN_AND_FEATURE();
    snapshot.commits = [commitNode(indexedSha(1))];
    snapshot.hasMoreCommits = true;
    const target = sha('f');
    mocks.getRepoSnapshot.mockResolvedValue(snapshot);
    mocks.getCommitPage.mockImplementation(async (_repoRoot: string, skip: number) => ({
      commits: [commitNode(indexedSha(skip + 1))],
      hasMoreCommits: true,
    }));
    const details = { hash: target, body: 'outside history', files: [] };
    mocks.getCommitDetails.mockResolvedValue(details);
    await openBoth();

    coordinator.revealCommit(target);
    await vi.waitFor(() => expect(editor.ofType('revealCommit')).toEqual([
      { type: 'revealCommit', payload: { hash: target, outsideGraph: true } },
    ]));
    expect(mocks.getCommitPage).toHaveBeenCalledTimes(10);
    expect(editor.ofType('commitDetails')).toContainEqual({ type: 'commitDetails', payload: details });
  });

  it('reveals a valid commit immediately and normalizes uppercase hashes', async () => {
    const snapshot = MAIN_AND_FEATURE();
    snapshot.commits = [commitNode(sha('a'))];
    mocks.getRepoSnapshot.mockResolvedValue(snapshot);
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
    mocks.getCommitDetails.mockResolvedValue({ hash: 'a'.repeat(64), body: 'details', files: [] });
    coordinator.revealCommit(uppercaseSha256);
    expect(editor.ofType('revealCommit')).toEqual([]);

    coordinator.attach(editor);
    coordinator.handleMessage('editor', { type: 'webviewReady' });
    await vi.waitFor(() => expect(editor.ofType('revealCommit')).toEqual([
      { type: 'revealCommit', payload: { hash: 'a'.repeat(64), outsideGraph: true } },
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
    await vi.waitFor(() => expect(editor.ofType('revealCommit')).toHaveLength(1));
    const messageTypes = editor.messages.map((message) => message.type);
    const snapshotIndex = messageTypes.indexOf('repoSnapshot');
    const revealIndex = messageTypes.indexOf('revealCommit');
    expect(snapshotIndex).toBeGreaterThanOrEqual(0);
    expect(revealIndex).toBeGreaterThan(snapshotIndex);
    expect(editor.ofType('revealCommit')).toEqual([
      { type: 'revealCommit', payload: { hash, outsideGraph: true } },
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
      expect(surface.messages.map((m) => m.type).slice(0, 3)).toEqual(['initState', 'workspaceRepos', 'repoSnapshot']);
    }
    expect(sidebar.ofType('repoSnapshot')[0]).toEqual(editor.ofType('repoSnapshot')[0]);
    expect(host.onCurrentBranchChange).toHaveBeenCalledWith('main');
  });

  it('does not load or run Git commands in an untrusted workspace, then retries after trust', async () => {
    mocks.isTrusted = false;
    coordinator.attach(sidebar);
    coordinator.handleMessage('sidebar', { type: 'webviewReady' });

    expect(mocks.getRepoSnapshot).not.toHaveBeenCalled();
    expect(mocks.discoverWorkspaceRepositories).not.toHaveBeenCalled();
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

  it('authorizes diffs for every discovered repository', async () => {
    const diffProvider = {
      setAllowedRepoRoots: vi.fn(),
      clearAllowedRepoRoots: vi.fn(),
    };
    mocks.discoverWorkspaceRepositories.mockResolvedValue([
      { repoRoot: '/repo', repoName: 'repo', commonDir: '/repo/.git' },
      { repoRoot: '/other', repoName: 'other', commonDir: '/other/.git' },
    ]);
    coordinator = new RepoCoordinator(host, diffProvider as never);
    coordinator.attach(sidebar);
    coordinator.handleMessage('sidebar', { type: 'webviewReady' });
    await vi.waitFor(() => expect(diffProvider.setAllowedRepoRoots).toHaveBeenCalledTimes(1));
    expect([...diffProvider.setAllowedRepoRoots.mock.calls[0]?.[0] as Iterable<string>]).toEqual([
      '/repo',
      '/other',
    ]);
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

    expect(editor.messages.map((m) => m.type)).toEqual(['initState', 'workspaceRepos', 'repoSnapshot', 'syncState', 'integrationsInfo']);
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

  it('persists and synchronizes folder branch count changes with the snapshot', async () => {
    await openBoth();
    expect(sidebar.ofType('initState')[0].payload).toMatchObject({ showFolderCounts: true });

    coordinator.handleMessage('sidebar', { type: 'setShowFolderCounts', payload: { show: false } });

    expect(host.setShowFolderCounts).toHaveBeenCalledWith(false);
    for (const surface of [sidebar, editor]) {
      const inits = surface.ofType('initState');
      expect(inits[inits.length - 1].payload).toMatchObject({ showFolderCounts: false });
      expect(surface.messages[surface.messages.length - 1].type).toBe('repoSnapshot');
      expect(surface.ofType('repoSnapshot')).toHaveLength(2);
    }
  });

  it('rejects openFile operations in an untrusted workspace', async () => {
    await openBoth();
    mocks.isTrusted = false;

    coordinator.handleMessage('editor', {
      type: 'openFile',
      payload: { hash: sha('a'), filePath: 'src/a.ts', status: 'M' },
    });

    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.showTextDocument).not.toHaveBeenCalled();
  });

  it('rejects openFile path traversal without touching the filesystem', async () => {
    await openBoth();

    coordinator.handleMessage('editor', {
      type: 'openFile',
      payload: { hash: sha('a'), filePath: 'src/../../outside.ts', status: 'M' },
    });

    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.buildShowUri).not.toHaveBeenCalled();
    expect(mocks.showTextDocument).not.toHaveBeenCalled();
  });

  it('opens an existing working-tree file directly', async () => {
    await openBoth();

    coordinator.handleMessage('editor', {
      type: 'openFile',
      payload: { hash: sha('a'), filePath: 'src/a.ts', status: 'M' },
    });

    await vi.waitFor(() => expect(mocks.showTextDocument).toHaveBeenCalledTimes(1));
    expect(mocks.stat).toHaveBeenCalledTimes(1);
    expect(mocks.showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: 'file', fsPath: expect.stringMatching(/src[\\/]a\.ts$/) }),
    );
    expect(mocks.buildShowUri).not.toHaveBeenCalled();
  });

  it('opens deleted and missing files from a read-only commit revision', async () => {
    await openBoth();

    coordinator.handleMessage('editor', {
      type: 'openFile',
      payload: { hash: sha('a'), filePath: 'deleted.ts', status: 'D' },
    });
    await vi.waitFor(() => expect(mocks.showTextDocument).toHaveBeenCalledTimes(1));
    expect(mocks.buildShowUri).toHaveBeenLastCalledWith(
      '/repo',
      `${sha('a')}~1:deleted.ts`,
      'deleted.ts',
    );
    expect(mocks.stat).not.toHaveBeenCalled();

    mocks.stat.mockRejectedValueOnce(new Error('ENOENT'));
    coordinator.handleMessage('editor', {
      type: 'openFile',
      payload: { hash: sha('b'), filePath: 'missing.ts', status: 'M' },
    });
    await vi.waitFor(() => expect(mocks.showTextDocument).toHaveBeenCalledTimes(2));
    expect(mocks.buildShowUri).toHaveBeenLastCalledWith(
      '/repo',
      `${sha('b')}:missing.ts`,
      'missing.ts',
    );
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

  describe('push recovery and provider browser actions', () => {
    const snapshotWith = (localBranches: BranchInfo[], remotes = ['origin']): RepoSnapshot => ({
      ...makeSnapshot(localBranches),
      remoteGroups: remotes.map((remoteName) => ({ remoteName, branches: [] })),
    });

    it('creates and tracks a remote branch for an unpushed branch', async () => {
      const snap = snapshotWith([{ ...branch('feature/new', true), upstream: null }]);
      mocks.getRepoSnapshot.mockResolvedValue(snap);
      mocks.showQuickPick.mockResolvedValueOnce({ label: 'Create Remote Branch "origin/feature/new"' });
      await openBoth();

      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'push', target: 'feature/new' } });

      await vi.waitFor(() => expect(mocks.pushToRemoteBranch).toHaveBeenCalledWith(
        '/repo',
        'origin',
        'feature/new',
        'feature/new',
        true,
      ));
      expect(mocks.showQuickPick).toHaveBeenCalledWith(
        [
          {
            label: 'Create Remote Branch "origin/feature/new"',
            detail: 'Destination: https://example.com/owner/repo.git',
          },
          { label: 'Cancel' },
        ],
        {
          title: 'Publish Branch to Remote',
          placeHolder: 'Branch "feature/new" does not exist on "origin" yet',
          ignoreFocusOut: true,
        },
      );
    });

    it('blocks publishing in a local-only repository and offers repository setup', async () => {
      const snap = snapshotWith([{ ...branch('feature/local', true), upstream: null }], []);
      mocks.getRepoSnapshot.mockResolvedValue(snap);
      mocks.showQuickPick.mockResolvedValueOnce({ label: 'Cancel' });
      await openBoth();

      coordinator.handleMessage('sidebar', {
        type: 'gitAction',
        payload: { action: 'push', target: 'feature/local' },
      });

      await vi.waitFor(() => expect(mocks.showQuickPick).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ label: 'Create & Publish Repository on GitHub…' }),
        expect.objectContaining({ label: 'Create Local Bare Remote on Disk…' }),
        expect.objectContaining({ label: 'Add Existing Remote URL (origin)…' }),
      ]), {
        title: 'Publish Repository / Add Remote',
        ignoreFocusOut: true,
      }));
      expect(mocks.pushToRemoteBranch).not.toHaveBeenCalled();
      expect(mocks.pushCurrentBranch).not.toHaveBeenCalled();
    });

    it('shows a hosted or local destination and offers GitHub for a local-path remote', async () => {
      mocks.getRepoSnapshot.mockResolvedValue(snapshotWith([
        { ...branch('feature/local', true), upstream: null },
      ]));
      mocks.getRemoteRawUrl.mockResolvedValue(String.raw`C:\Backups\repo.git`);
      mocks.showQuickPick.mockResolvedValueOnce({ label: 'Cancel' });
      await openBoth();

      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'push', target: 'feature/local' } });
      await vi.waitFor(() => expect(mocks.showQuickPick).toHaveBeenCalled());
      const localItems = mocks.showQuickPick.mock.calls[0][0];
      expect(localItems).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: 'Create Remote Branch "origin/feature/local"',
          detail: String.raw`Destination: Local drive: C:\Backups\repo.git`,
        }),
        expect.objectContaining({ label: 'Create & Publish Repository on GitHub…' }),
      ]));

      mocks.getRemoteRawUrl.mockResolvedValue('git@github.com:owner/repo.git');
      mocks.showQuickPick.mockResolvedValueOnce({ label: 'Cancel' });
      coordinator.handleMessage('sidebar', { type: 'requestRefresh' });
      await vi.waitFor(() => expect(sidebar.ofType('repoSnapshot').length).toBeGreaterThan(1));
      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'push', target: 'feature/local' } });
      await vi.waitFor(() => expect(mocks.showQuickPick).toHaveBeenCalledTimes(2));
      expect(mocks.showQuickPick.mock.calls[1][0][0]).toMatchObject({
        detail: 'Destination: GitHub: https://github.com/owner/repo',
      });
    });

    it('recovers a renamed branch by creating the new remote branch', async () => {
      const renamed = { ...branch('feature/renamed', true), upstream: 'origin/feature/old' };
      mocks.getRepoSnapshot.mockResolvedValue(snapshotWith([renamed]));
      mocks.showQuickPick.mockResolvedValueOnce({ label: 'Create New Remote Branch (origin/feature/renamed)' });
      await openBoth();

      coordinator.handleMessage('sidebar', {
        type: 'gitAction',
        payload: { action: 'push', target: 'feature/renamed' },
      });

      await vi.waitFor(() => expect(mocks.pushToRemoteBranch).toHaveBeenCalledWith(
        '/repo',
        'origin',
        'feature/renamed',
        'feature/renamed',
        true,
      ));
    });

    it('can push a renamed branch to its existing old remote name', async () => {
      const renamed = { ...branch('feature/renamed', true), upstream: 'origin/feature/old' };
      mocks.getRepoSnapshot.mockResolvedValue(snapshotWith([renamed]));
      mocks.showQuickPick.mockResolvedValueOnce({
        label: 'Push to Existing Remote Branch (origin/feature/old)',
      });
      await openBoth();

      coordinator.handleMessage('sidebar', {
        type: 'gitAction',
        payload: { action: 'push', target: 'feature/renamed' },
      });

      await vi.waitFor(() => expect(mocks.pushToRemoteBranch).toHaveBeenCalledWith(
        '/repo',
        'origin',
        'feature/renamed',
        'feature/old',
        false,
      ));
    });

    it('shows the resolved local destination and GitHub alternative for a renamed branch', async () => {
      mocks.getRepoSnapshot.mockResolvedValue(snapshotWith([
        { ...branch('feature/renamed', true), upstream: 'origin/feature/old' },
      ]));
      mocks.getRemoteRawUrl.mockResolvedValue('/srv/git/repo.git');
      mocks.showQuickPick.mockResolvedValueOnce({ label: 'Cancel' });
      await openBoth();

      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'push' } });
      await vi.waitFor(() => expect(mocks.showQuickPick).toHaveBeenCalled());
      expect(mocks.showQuickPick.mock.calls[0][0]).toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: 'Create New Remote Branch (origin/feature/renamed)',
          detail: expect.stringContaining('Destination: Local drive: /srv/git/repo.git'),
        }),
        expect.objectContaining({ label: 'Create & Publish Repository on GitHub…' }),
      ]));
    });

    it.each([
      ['user', [], 'origin'],
      ['org', ['origin'], 'github'],
    ] as const)('guides %s GitHub publication and wires the %s remote', async (ownerType, remotes, expectedRemote) => {
      mocks.getRepoSnapshot.mockResolvedValue(snapshotWith([{ ...branch('main', true) }], [...remotes]));
      mocks.listPublishOwners.mockResolvedValue([{ login: ownerType === 'user' ? 'alice' : 'acme', type: ownerType }]);
      mocks.showQuickPick
        .mockResolvedValueOnce({ label: 'Create & Publish Repository on GitHub…' })
        .mockResolvedValueOnce({
          label: ownerType === 'user' ? 'alice' : 'acme',
          ownerLogin: ownerType === 'user' ? 'alice' : 'acme',
          ownerType,
        })
        .mockResolvedValueOnce({ label: 'Private Repository', isPrivate: true })
        .mockResolvedValueOnce({ label: "Create Repository & Push 'main'" });
      mocks.showInputBox.mockResolvedValueOnce('new-project');
      await openBoth();

      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'publishRepository' } });
      await vi.waitFor(() => expect(mocks.pushToRemoteBranch).toHaveBeenCalledWith(
        '/repo',
        expectedRemote,
        'main',
        'main',
        true,
      ));
      expect(mocks.createRepository).toHaveBeenCalledWith('token', {
        ownerLogin: ownerType === 'user' ? 'alice' : 'acme',
        ownerType,
        name: 'new-project',
        isPrivate: true,
      });
      expect(mocks.addRemote).toHaveBeenCalledWith('/repo', expectedRemote, 'https://github.com/alice/project.git');
    });

    it('makes no GitHub API request when repository creation is cancelled at confirmation', async () => {
      mocks.getRepoSnapshot.mockResolvedValue(snapshotWith([{ ...branch('main', true) }], []));
      mocks.showQuickPick
        .mockResolvedValueOnce({ label: 'Create & Publish Repository on GitHub…' })
        .mockResolvedValueOnce({ label: 'alice', ownerLogin: 'alice', ownerType: 'user' })
        .mockResolvedValueOnce({ label: 'Private Repository', isPrivate: true })
        .mockResolvedValueOnce({ label: 'Cancel' });
      mocks.showInputBox.mockResolvedValueOnce('not-created');
      await openBoth();

      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'publishRepository' } });
      await vi.waitFor(() => expect(mocks.showQuickPick).toHaveBeenCalledTimes(4));
      expect(mocks.createRepository).not.toHaveBeenCalled();
      expect(mocks.addRemote).not.toHaveBeenCalled();
      expect(mocks.pushToRemoteBranch).not.toHaveBeenCalled();
    });

    it('creates and publishes to a local bare remote on disk', async () => {
      mocks.getRepoSnapshot.mockResolvedValue(snapshotWith([{ ...branch('main', true) }], ['origin']));
      mocks.showQuickPick
        .mockResolvedValueOnce({ label: 'Create Local Bare Remote on Disk…' })
        .mockResolvedValueOnce({ label: 'Create Bare Remote & Push' });
      mocks.showOpenDialog.mockResolvedValueOnce([{ fsPath: '/backups' }]);
      mocks.showInputBox.mockResolvedValueOnce('project-copy.git');
      await openBoth();

      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'publishRepository' } });
      await vi.waitFor(() => expect(mocks.pushToRemoteBranch).toHaveBeenCalledWith(
        '/repo',
        'local-backup',
        'main',
        'main',
        true,
      ));
      const expectedPath = path.join('/backups', 'project-copy.git');
      expect(mocks.initBareRepository).toHaveBeenCalledWith(expectedPath, 'main');
      expect(mocks.addRemote).toHaveBeenCalledWith('/repo', 'local-backup', expectedPath);
    });

    it('cancels renamed-branch recovery without pushing', async () => {
      mocks.getRepoSnapshot.mockResolvedValue(snapshotWith([
        { ...branch('feature/renamed', true), upstream: 'origin/feature/old' },
      ]));
      mocks.showQuickPick.mockResolvedValueOnce({ label: 'Cancel' });
      await openBoth();
      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'push' } });
      await Promise.resolve();
      expect(mocks.pushToRemoteBranch).not.toHaveBeenCalled();
      expect(mocks.pushCurrentBranch).not.toHaveBeenCalled();
    });

    it('opens a pre-filled PR page after push and remote resolution', async () => {
      mocks.getRepoSnapshot.mockResolvedValue(snapshotWith([
        { ...branch('feature/pr', true), upstream: 'origin/feature/pr' },
      ]));
      mocks.getRemoteUrl.mockResolvedValue('https://github.com/owner/repo');
      await openBoth();
      coordinator.handleMessage('sidebar', {
        type: 'gitAction',
        payload: { action: 'pushAndOpenPr', target: 'feature/pr' },
      });

      await vi.waitFor(() => expect(mocks.openExternal).toHaveBeenCalledWith({
        url: 'https://github.com/owner/repo/compare/feature/pr?expand=1',
        strict: true,
      }));
    });

    it('offers Create PR after a regular feature push but not for main', async () => {
      mocks.getRepoSnapshot.mockResolvedValue(snapshotWith([
        { ...branch('feature/pr', true), upstream: 'origin/feature/pr' },
      ]));
      mocks.getRemoteUrl.mockResolvedValue('https://github.com/owner/repo');
      await openBoth();
      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'push' } });
      await vi.waitFor(() => expect(mocks.showInformationMessage).toHaveBeenCalledWith(
        'Pushed "feature/pr" to origin.',
        'Create PR in Browser',
      ));

      vi.clearAllMocks();
      const mainSnapshot = snapshotWith([{ ...branch('main', true), upstream: 'origin/main' }]);
      mocks.getRepoSnapshot.mockResolvedValue(mainSnapshot);
      coordinator.handleMessage('sidebar', { type: 'requestRefresh' });
      await vi.waitFor(() => expect(sidebar.ofType('repoSnapshot').length).toBeGreaterThan(2));
      coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'push' } });
      await vi.waitFor(() => expect(mocks.pushCurrentBranch).toHaveBeenCalled());
      expect(mocks.showInformationMessage).not.toHaveBeenCalled();
    });

    it('opens repository, branch, commit and PR URLs in the browser', async () => {
      const local = { ...branch('feature/web', true), upstream: 'origin/feature/web' };
      const remote: BranchInfo = {
        ...local,
        name: 'origin/feature/web',
        displayName: 'feature/web',
        fullName: 'refs/remotes/origin/feature/web',
        isCurrent: false,
        isRemote: true,
        remoteName: 'origin',
        upstream: null,
      };
      const snap = snapshotWith([local]);
      snap.remoteGroups = [{ remoteName: 'origin', branches: [remote] }];
      snap.commits = [commitNode(sha('a'))];
      mocks.getRepoSnapshot.mockResolvedValue(snap);
      mocks.getRemoteUrl.mockResolvedValue('git@gitlab.com:group/repo.git');
      await openBoth();

      for (const action of [
        { action: 'openRepoInBrowser' },
        { action: 'openBranchInBrowser', target: 'origin/feature/web' },
        { action: 'openCommitInBrowser', target: sha('a') },
        { action: 'createPrInBrowser', target: 'feature/web' },
      ]) {
        coordinator.handleMessage('sidebar', { type: 'gitAction', payload: action });
      }

      await vi.waitFor(() => expect(mocks.openExternal).toHaveBeenCalledTimes(4));
      const urls = mocks.openExternal.mock.calls.map(([value]: [{ url: string }]) => value.url);
      expect(urls).toEqual([
        'https://gitlab.com/group/repo',
        'https://gitlab.com/group/repo/-/tree/feature/web',
        `https://gitlab.com/group/repo/-/commit/${sha('a')}`,
        'https://gitlab.com/group/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fweb',
      ]);
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

  it('allows opening, copying and removing only exact paths from the loaded worktree snapshot', async () => {
    const linkedPath = '/repos/wt';
    mocks.getRepoSnapshot.mockResolvedValue({
      ...MAIN_AND_FEATURE(),
      worktrees: [
        {
          path: '/repo', headHash: sha('a'), branchName: 'main', isDetached: false, isBare: false,
          isMain: true, isCurrent: true, isLocked: false, isPrunable: false,
        },
        {
          path: linkedPath, headHash: sha('b'), branchName: 'feature', isDetached: false, isBare: false,
          isMain: false, isCurrent: false, isLocked: false, isPrunable: false,
        },
      ],
    });
    await openBoth();
    mocks.executeCommand.mockClear();

    for (const action of ['openWorktree', 'copyWorktreePath', 'removeWorktree'] as const) {
      coordinator.handleMessage('sidebar', {
        type: 'gitAction',
        payload: { action, target: '/repos/wt-evil' },
      });
    }
    await vi.waitFor(() => expect(mocks.showWarningMessage).toHaveBeenCalledTimes(3));
    expect(mocks.executeCommand).not.toHaveBeenCalledWith('vscode.openFolder', expect.anything(), expect.anything());
    expect(mocks.clipboardWriteText).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();

    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action: 'openWorktree', target: linkedPath },
    });
    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action: 'copyWorktreePath', target: linkedPath },
    });
    await vi.waitFor(() => expect(mocks.clipboardWriteText).toHaveBeenCalledWith(linkedPath));
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.openFolder',
      expect.objectContaining({ fsPath: linkedPath }),
      { forceNewWindow: true },
    );
  });

  it('adds all loaded worktree roots to the diff allowlist', async () => {
    const diffProvider = { setAllowedRepoRoots: vi.fn(), clearAllowedRepoRoots: vi.fn() };
    mocks.discoverWorkspaceRepositories.mockResolvedValue([
      { repoRoot: '/repo', repoName: 'repo', commonDir: '/repo/.git', currentBranch: 'main' },
      { repoRoot: '/other', repoName: 'other', commonDir: '/other/.git', currentBranch: 'dev' },
    ]);
    mocks.getRepoSnapshot.mockResolvedValue({
      ...MAIN_AND_FEATURE(),
      worktrees: [
        {
          path: '/repo', headHash: sha('a'), branchName: 'main', isDetached: false, isBare: false,
          isMain: true, isCurrent: true, isLocked: false, isPrunable: false,
        },
        {
          path: '/linked', headHash: sha('b'), branchName: 'feature', isDetached: false, isBare: false,
          isMain: false, isCurrent: false, isLocked: false, isPrunable: false,
        },
      ],
    });
    coordinator = new RepoCoordinator(host, diffProvider as never);
    await openBoth();
    expect([...diffProvider.setAllowedRepoRoots.mock.calls[0][0]]).toEqual(['/repo', '/other', '/linked']);
  });

  it("supports leaveInWorktree without changing or stashing the current worktree", async () => {
    mocks.hasWorkingTreeChanges.mockResolvedValue(true);
    mocks.showQuickPick
      .mockResolvedValueOnce({ label: 'Leave Changes Here & Create Worktree…' })
      .mockResolvedValueOnce({ label: 'Stay Here' });
    mocks.showOpenDialog.mockResolvedValueOnce([{ fsPath: '/worktrees' }]);
    mocks.showInputBox.mockResolvedValueOnce('repo-feature-new');
    mocks.stat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await openBoth();

    coordinator.handleMessage('sidebar', {
      type: 'submitCreateBranch',
      payload: { branchName: 'feature/new', checkout: true, track: false },
    });
    await vi.waitFor(() => expect(mocks.addWorktree).toHaveBeenCalledWith(
      '/repo',
      path.join('/worktrees', 'repo-feature-new'),
      { branchName: 'feature/new', createBranch: true, startPoint: undefined },
    ));
    expect(mocks.createBranch).not.toHaveBeenCalled();
    expect(mocks.stashChanges).not.toHaveBeenCalled();
    expect(mocks.discardWorkingTreeChanges).not.toHaveBeenCalled();
  });

  it('blocks main and current worktree removal without prompting or invoking Git', async () => {
    mocks.getRepoSnapshot.mockResolvedValue({
      ...MAIN_AND_FEATURE(),
      worktrees: [
        {
          path: '/repo', headHash: sha('a'), branchName: 'main', isDetached: false, isBare: false,
          isMain: true, isCurrent: true, isLocked: false, isPrunable: false,
        },
        {
          path: '/linked-current', headHash: sha('b'), branchName: 'feature', isDetached: false, isBare: false,
          isMain: false, isCurrent: true, isLocked: false, isPrunable: false,
        },
      ],
    });
    await openBoth();

    for (const target of ['/repo', '/linked-current']) {
      coordinator.handleMessage('sidebar', {
        type: 'gitAction',
        payload: { action: 'removeWorktree', target },
      });
    }
    await vi.waitFor(() => expect(mocks.showWarningMessage).toHaveBeenCalledTimes(2));
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      'The main worktree cannot be removed.',
      'The currently open worktree cannot be removed.',
    ]));
  });

  it('requires silent force confirmation after a dirty worktree removal fails', async () => {
    const linkedPath = '/repos/dirty';
    mocks.getRepoSnapshot.mockResolvedValue({
      ...MAIN_AND_FEATURE(),
      worktrees: [
        {
          path: '/repo', headHash: sha('a'), branchName: 'main', isDetached: false, isBare: false,
          isMain: true, isCurrent: true, isLocked: false, isPrunable: false,
        },
        {
          path: linkedPath, headHash: sha('b'), branchName: 'feature', isDetached: false, isBare: false,
          isMain: false, isCurrent: false, isLocked: false, isPrunable: false,
        },
      ],
    });
    mocks.removeWorktree
      .mockRejectedValueOnce(new GitExecutionError(
        'dirty worktree',
        'COMMAND_FAILED',
        128,
        'fatal: working trees containing modified or untracked files cannot be moved',
      ));
    mocks.showQuickPick
      .mockResolvedValueOnce({ label: 'Remove Worktree' })
      .mockResolvedValueOnce({ label: 'Force Remove Worktree' });
    await openBoth();

    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action: 'removeWorktree', target: linkedPath },
    });

    await vi.waitFor(() => expect(mocks.removeWorktree).toHaveBeenCalledTimes(2));
    expect(mocks.removeWorktree).toHaveBeenNthCalledWith(1, '/repo', linkedPath, false);
    expect(mocks.removeWorktree).toHaveBeenNthCalledWith(2, '/repo', linkedPath, true);
    expect(mocks.showQuickPick).toHaveBeenNthCalledWith(
      2,
      [{ label: 'Force Remove Worktree' }, { label: 'Cancel' }],
      expect.objectContaining({ title: 'Force Remove Worktree "feature"' }),
    );
  });

  it('blocks checkout and deletion for a local branch checked out in another worktree', async () => {
    mocks.getRepoSnapshot.mockResolvedValue({
      ...MAIN_AND_FEATURE(),
      localBranches: [
        branch('main', true),
        { ...branch('feature', false), worktreePath: '/repos/feature' },
      ],
    });
    await openBoth();

    coordinator.handleMessage('sidebar', {
      type: 'checkoutBranch',
      payload: { branchName: 'feature' },
    });
    coordinator.handleMessage('sidebar', {
      type: 'gitAction',
      payload: { action: 'deleteBranch', target: 'feature' },
    });

    await vi.waitFor(() => expect(mocks.showWarningMessage).toHaveBeenCalledTimes(2));
    expect(mocks.checkoutBranch).not.toHaveBeenCalled();
    expect(mocks.deleteLocalBranch).not.toHaveBeenCalled();
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
    expect(mocks.showWarningMessage.mock.calls.map((call) => call[0])).toEqual([
      'Branch "feature" is already checked out in another worktree: /repos/feature',
      'Branch "feature" is already checked out in another worktree: /repos/feature',
    ]);
  });
});
