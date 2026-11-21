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
}));

vi.mock('vscode', () => {
  const disposable = { dispose: (): void => undefined };
  return {
    workspace: {
      workspaceFolders: [{ name: 'repo', uri: { fsPath: '/repo' } }],
      onDidChangeWorkspaceFolders: () => disposable,
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
  },
  isValidCommitHash: (value: string): boolean => /^[0-9a-f]{40}$/i.test(value),
}));
vi.mock('../src/github/githubService', () => ({ GitHubService: class {} }));
vi.mock('../src/git/gitDiffProvider', () => ({ openCommitFileDiff: vi.fn() }));
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
  let host: RepoCoordinatorHost & { setTabPinned: ReturnType<typeof vi.fn>; openPanel: ReturnType<typeof vi.fn> };
  let coordinator: RepoCoordinator;
  let sidebar: FakeSurface;
  let editor: FakeSurface;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRepoSnapshot.mockImplementation(async () => MAIN_AND_FEATURE());
    mocks.getGitHubRemoteUrl.mockResolvedValue(null);
    mocks.checkoutBranch.mockResolvedValue(undefined);
    host = {
      getTabPinned: () => false,
      setTabPinned: vi.fn(),
      openPanel: vi.fn(),
      onCurrentBranchChange: vi.fn(),
    };
    coordinator = new RepoCoordinator(host);
    sidebar = fakeSurface('sidebar');
    editor = fakeSurface('editor');
  });

  async function openBoth(): Promise<void> {
    coordinator.attach(sidebar);
    coordinator.attach(editor);
    coordinator.handleMessage('sidebar', { type: 'webviewReady' });
    await vi.waitFor(() => expect(editor.ofType('repoSnapshot')).toHaveLength(1));
  }

  it('loads once and gives the sidebar tree and the editor timeline the same snapshot', async () => {
    await openBoth();
    expect(mocks.getRepoSnapshot).toHaveBeenCalledTimes(1);
    for (const surface of [sidebar, editor]) {
      expect(surface.messages.map((m) => m.type).slice(0, 2)).toEqual(['initState', 'repoSnapshot']);
    }
    expect(sidebar.ofType('repoSnapshot')[0]).toEqual(editor.ofType('repoSnapshot')[0]);
    expect(host.onCurrentBranchChange).toHaveBeenCalledWith('main');
  });

  it('forwards a selection to the other view only, never echoing it to the sender', async () => {
    await openBoth();
    const picked = selection('refs/heads/feature', 'feature', ['refs/heads/main']);
    coordinator.handleMessage('sidebar', { type: 'syncState', payload: picked });

    expect(editor.ofType('syncState')).toEqual([{ type: 'syncState', payload: picked }]);
    expect(sidebar.ofType('syncState')).toEqual([]);

    const cleared = selection(null, null);
    coordinator.handleMessage('editor', { type: 'syncState', payload: cleared });
    expect(sidebar.ofType('syncState')).toEqual([{ type: 'syncState', payload: cleared }]);
    expect(editor.ofType('syncState')).toHaveLength(1);
  });

  it('does not rebroadcast a selection that is already current', async () => {
    await openBoth();
    const picked = selection('refs/tags/v1', 'v1');
    coordinator.handleMessage('sidebar', { type: 'syncState', payload: picked });
    coordinator.handleMessage('sidebar', { type: 'syncState', payload: picked });
    expect(editor.ofType('syncState')).toHaveLength(1);
  });

  it('corrects a selection that names refs the repository does not have', async () => {
    await openBoth();
    coordinator.handleMessage('sidebar', {
      type: 'syncState',
      payload: selection('refs/heads/ghost', 'ghost', ['refs/heads/feature', 'refs/heads/ghost']),
    });
    const corrected = selection(null, null, ['refs/heads/feature']);
    expect(sidebar.ofType('syncState')).toEqual([{ type: 'syncState', payload: corrected }]);
    expect(editor.ofType('syncState')).toEqual([{ type: 'syncState', payload: corrected }]);
  });

  it('drops malformed or forged messages without touching state or Git', async () => {
    await openBoth();
    coordinator.handleMessage('sidebar', { type: 'syncState', payload: selection('--force', '--force') });
    coordinator.handleMessage('sidebar', { type: 'gitAction', payload: { action: 'merge', target: '--upload-pack=x' } });
    coordinator.handleMessage('sidebar', { type: 'nope' });
    coordinator.handleMessage('sidebar', 'not an object');
    expect(editor.ofType('syncState')).toEqual([]);
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
