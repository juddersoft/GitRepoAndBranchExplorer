import * as vscode from 'vscode';
import { AUTO_CLOSE_DELAY_MS, decideAutoClose } from './panelLifecycle';
import type { WebviewSurface } from './RepoCoordinator';
import { RepoCoordinator } from './RepoCoordinator';
import { getLocalResourceRoots, getWebviewHtml } from './webviewResources';

export const OPEN_REPOSITORY_COMMAND = 'gitRepoAndBranchExplorer.openRepository';
export const REFRESH_COMMAND = 'gitRepoAndBranchExplorer.refresh';
/** Built-in command that selects (and, if needed, shows) this extension's Activity Bar container. */
export const SHOW_CONTAINER_COMMAND = 'workbench.view.extension.gitRepoAndBranchExplorer-container';
const TAB_PINNED_KEY = 'gitRepoAndBranchExplorer.tabPinned';
const MOVE_TO_FIRST_TAB_TIMEOUT_MS = 1500;

const PANEL_TITLE = 'Git Repository';

/**
 * Singleton editor-area panel, analogous to Visual Studio's "Git Repository" window. It renders the timeline
 * (toolbar, commit graph, history and commit details); the branch/remote/tag tree lives in the Activity Bar
 * view. Both are views of the same {@link RepoCoordinator}.
 */
export class GitRepoPanel {
  public static readonly viewType = 'gitRepoAndBranchExplorer.panel';
  private static currentPanel: GitRepoPanel | undefined;
  private static coordinator: RepoCoordinator | undefined;
  private static pinStore: vscode.Memento | undefined;
  private static tabPinned = false;
  private static sidebarVisible = false;
  private static opening = false;
  private static autoCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private static autoCloseDeferred = false;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly surface: WebviewSurface;
  private disposed = false;

  /**
   * Restores the persisted pin, creates the coordinator shared with the sidebar view and watches window
   * focus so a deferred auto-close can still happen.
   */
  public static initialize(context: vscode.ExtensionContext): RepoCoordinator {
    GitRepoPanel.pinStore = context.globalState;
    GitRepoPanel.tabPinned = context.globalState.get<boolean>(TAB_PINNED_KEY, false);
    const coordinator = new RepoCoordinator({
      getTabPinned: () => GitRepoPanel.tabPinned,
      setTabPinned: (pinned) => GitRepoPanel.setTabPinned(pinned),
      openPanel: () => void GitRepoPanel.createOrShow(context.extensionUri),
      onCurrentBranchChange: (currentBranch) => GitRepoPanel.currentPanel?.setBranchTitle(currentBranch),
    });
    GitRepoPanel.coordinator = coordinator;
    context.subscriptions.push(
      coordinator,
      vscode.window.onDidChangeWindowState((windowState) => {
        if (windowState.focused && GitRepoPanel.autoCloseDeferred) {
          GitRepoPanel.autoCloseDeferred = false;
          GitRepoPanel.scheduleAutoClose();
        }
      }),
    );
    return coordinator;
  }

  /**
   * Opens (or reveals) the panel, moves its tab to the far left and makes sure this extension's Activity Bar
   * container is the selected one, so unpinned-tab auto-close tracks the container the user is looking at.
   */
  public static async createOrShow(extensionUri: vscode.Uri): Promise<void> {
    const coordinator = GitRepoPanel.coordinator;
    if (GitRepoPanel.opening || !coordinator) {
      return;
    }
    GitRepoPanel.opening = true;
    GitRepoPanel.cancelAutoClose();
    try {
      const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
      let instance = GitRepoPanel.currentPanel;

      if (instance) {
        instance.panel.reveal(instance.panel.viewColumn ?? column);
      } else {
        const panel = vscode.window.createWebviewPanel(GitRepoPanel.viewType, PANEL_TITLE, column, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: getLocalResourceRoots(extensionUri),
        });
        instance = new GitRepoPanel(panel, extensionUri, coordinator);
        GitRepoPanel.currentPanel = instance;
      }

      await instance.moveToFirstTab();
      await GitRepoPanel.ensureContainerSelected(instance);
    } finally {
      GitRepoPanel.opening = false;
    }
  }

  /** Called by the sidebar view whenever it becomes visible or hidden. */
  public static setSidebarVisible(visible: boolean): void {
    GitRepoPanel.sidebarVisible = visible;
    if (visible) {
      GitRepoPanel.cancelAutoClose();
    } else {
      GitRepoPanel.scheduleAutoClose();
    }
  }

  public static isTabPinned(): boolean {
    return GitRepoPanel.tabPinned;
  }

  public static setTabPinned(pinned: boolean): void {
    GitRepoPanel.tabPinned = pinned;
    void GitRepoPanel.pinStore?.update(TAB_PINNED_KEY, pinned);
    if (pinned) {
      GitRepoPanel.cancelAutoClose();
    }
  }

  public static refresh(): void {
    GitRepoPanel.coordinator?.refresh();
  }

  public static disposeCurrent(): void {
    GitRepoPanel.cancelAutoClose();
    GitRepoPanel.currentPanel?.dispose();
  }

  private static async ensureContainerSelected(instance: GitRepoPanel): Promise<void> {
    if (GitRepoPanel.sidebarVisible) {
      return;
    }
    try {
      await vscode.commands.executeCommand(SHOW_CONTAINER_COMMAND);
      // Selecting the container focuses its view; hand focus back to the panel the user asked for.
      if (!instance.disposed) {
        instance.panel.reveal(instance.panel.viewColumn);
      }
    } catch {
      // The Activity Bar indicator is cosmetic; never let it prevent the panel from opening.
    }
  }

  private static scheduleAutoClose(): void {
    GitRepoPanel.cancelAutoClose();
    if (!GitRepoPanel.currentPanel) {
      return;
    }
    GitRepoPanel.autoCloseTimer = setTimeout(() => {
      GitRepoPanel.autoCloseTimer = undefined;
      const decision = decideAutoClose({
        tabPinned: GitRepoPanel.tabPinned,
        panelOpening: GitRepoPanel.opening,
        windowFocused: vscode.window.state.focused,
        sidebarVisible: GitRepoPanel.sidebarVisible,
      });
      if (decision === 'defer') {
        GitRepoPanel.autoCloseDeferred = true;
      } else if (decision === 'close') {
        GitRepoPanel.currentPanel?.dispose();
      }
    }, AUTO_CLOSE_DELAY_MS);
  }

  private static cancelAutoClose(): void {
    if (GitRepoPanel.autoCloseTimer !== undefined) {
      clearTimeout(GitRepoPanel.autoCloseTimer);
      GitRepoPanel.autoCloseTimer = undefined;
    }
    GitRepoPanel.autoCloseDeferred = false;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly coordinator: RepoCoordinator,
  ) {
    this.surface = {
      id: 'editor',
      post: (message) => {
        if (!this.disposed) {
          void this.panel.webview.postMessage(message);
        }
      },
    };
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'git-repo-icon.svg');
    this.panel.webview.html = getWebviewHtml(this.panel.webview, extensionUri, 'webview');

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.coordinator.handleMessage('editor', message),
      null,
      this.disposables,
    );
    this.coordinator.attach(this.surface);
  }

  private setBranchTitle(currentBranch: string | null): void {
    if (!this.disposed) {
      this.panel.title = currentBranch === null ? PANEL_TITLE : `${PANEL_TITLE} (${currentBranch})`;
    }
  }

  /** Moves the panel's tab to the far left of its group, but only while it really is the active editor. */
  private async moveToFirstTab(): Promise<void> {
    if (!this.panel.active) {
      await new Promise<void>((resolve) => {
        const subscription = this.panel.onDidChangeViewState((event) => {
          if (event.webviewPanel.active) {
            finish();
          }
        });
        const timer = setTimeout(finish, MOVE_TO_FIRST_TAB_TIMEOUT_MS);
        function finish(): void {
          clearTimeout(timer);
          subscription.dispose();
          resolve();
        }
        if (this.panel.active) {
          finish();
        }
      });
    }
    if (this.disposed || !this.panel.active) {
      return;
    }
    try {
      await vscode.commands.executeCommand('moveActiveEditor', { to: 'first', by: 'tab' });
    } catch {
      // Tab placement is a nicety; the panel is still usable where it is.
    }
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.coordinator.detach(this.surface);
    if (GitRepoPanel.currentPanel === this) {
      GitRepoPanel.currentPanel = undefined;
      GitRepoPanel.cancelAutoClose();
    }
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
