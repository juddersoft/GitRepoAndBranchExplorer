import * as path from 'path';
import * as vscode from 'vscode';
import type { BlameLineInfo, FileBlameMap } from '../git/blameParser';
import { formatInlineBlame } from '../git/blameParser';
import type { GitBlameService } from '../git/gitBlameService';
import type { RepoCoordinator } from '../webview/RepoCoordinator';
import { resolveBlameRepository } from './blameRepoResolution';
import {
  BLAME_HOVER_ALLOWED_COMMANDS,
  BLAME_HOVER_COMMANDS,
  buildBlameHoverMarkdown,
} from './blameHover';
import {
  BLAME_AGE_BUCKETS,
  type BlameAgeBucket,
  buildBlameGutterEntries,
} from './blameGutter';

const TOGGLE_INLINE_BLAME_COMMAND = 'gitRepoAndBranchExplorer.toggleInlineBlame';
const SELECTION_DEBOUNCE_MS = 120;

const GUTTER_BUCKET_STYLES: Record<BlameAgeBucket, { border: string; backgroundColor: string }> = {
  uncommitted: {
    border: '0 0 0 3px solid rgba(160, 160, 160, 0.65)',
    backgroundColor: 'rgba(128, 128, 128, 0.08)',
  },
  age0: {
    border: '0 0 0 3px solid rgba(244, 126, 87, 0.9)',
    backgroundColor: 'rgba(244, 126, 87, 0.1)',
  },
  age1: {
    border: '0 0 0 3px solid rgba(224, 169, 96, 0.82)',
    backgroundColor: 'rgba(224, 169, 96, 0.08)',
  },
  age2: {
    border: '0 0 0 3px solid rgba(174, 180, 111, 0.78)',
    backgroundColor: 'rgba(174, 180, 111, 0.07)',
  },
  age3: {
    border: '0 0 0 3px solid rgba(111, 164, 176, 0.72)',
    backgroundColor: 'rgba(111, 164, 176, 0.07)',
  },
  age4: {
    border: '0 0 0 3px solid rgba(112, 128, 168, 0.62)',
    backgroundColor: 'rgba(112, 128, 168, 0.06)',
  },
};

interface BlameControllerOptions {
  blameService: GitBlameService;
  coordinator: RepoCoordinator;
  extensionUri: vscode.Uri;
}

interface BlameConfiguration {
  enabled: boolean;
  ignoreWhitespace: boolean;
  showStatusBar: boolean;
}

function readConfiguration(): BlameConfiguration {
  const configuration = vscode.workspace.getConfiguration('gitRepoAndBranchExplorer.blame');
  return {
    enabled: configuration.get<boolean>('enabled', true),
    ignoreWhitespace: configuration.get<boolean>('ignoreWhitespace', false),
    showStatusBar: configuration.get<boolean>('showStatusBar', true),
  };
}

function usesWindowsPaths(...paths: string[]): boolean {
  return process.platform === 'win32' || paths.some((value) => /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\'));
}

function repositoryRelativePath(repoRoot: string, filePath: string): string | null {
  const windows = usesWindowsPaths(repoRoot, filePath);
  const pathApi = windows ? path.win32 : path.posix;
  const root = pathApi.resolve(repoRoot);
  const file = pathApi.resolve(filePath);
  const comparableRoot = windows ? root.toLowerCase().replace(/\\/g, '/') : root;
  const comparableFile = windows ? file.toLowerCase().replace(/\\/g, '/') : file;
  if (comparableFile !== comparableRoot && !comparableFile.startsWith(`${comparableRoot.replace(/\/+$/, '')}/`)) {
    return null;
  }
  const relative = pathApi.relative(root, file);
  if (relative.length === 0 || pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${pathApi.sep}`)) {
    return null;
  }
  return relative.split(pathApi.sep).join('/');
}

function uncommittedLineInfo(lineNumber: number, filename: string, sourceLine: string): BlameLineInfo {
  return {
    lineNumber,
    originalLineNumber: lineNumber,
    hash: '0'.repeat(40),
    shortHash: '',
    isUncommitted: true,
    author: 'Not Committed Yet',
    authorEmail: '',
    authorTime: 0,
    authorTz: '',
    summary: 'This line has local uncommitted changes.',
    filename,
    sourceLine,
  };
}

export class BlameController implements vscode.Disposable {
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      margin: '0 0 0 24px',
    },
  });
  private readonly gutterDecorationTypes: ReadonlyMap<BlameAgeBucket, vscode.TextEditorDecorationType>;
  private readonly annotatedDocuments = new Set<string>();
  private readonly statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly blameService: GitBlameService;
  private readonly coordinator: RepoCoordinator;
  private readonly gutterRenderTokens = new WeakMap<vscode.TextEditor, number>();
  private configuration = readConfiguration();
  private requestToken = 0;
  private gutterRenderToken = 0;
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private decoratedEditor: vscode.TextEditor | undefined;
  private reloadingAfterRepositoryRelease = false;
  private disposed = false;

  constructor({ blameService, coordinator }: BlameControllerOptions) {
    this.blameService = blameService;
    this.coordinator = coordinator;
    this.gutterDecorationTypes = new Map(BLAME_AGE_BUCKETS.map((bucket) => {
      const style = GUTTER_BUCKET_STYLES[bucket];
      return [
        bucket,
        vscode.window.createTextEditorDecorationType({
          before: {
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            margin: '0 16px 0 0',
            textDecoration: 'none; font-family: var(--vscode-editor-font-family); font-size: 0.9em; padding: 0 8px 0 6px; white-space: pre;',
            border: style.border,
            backgroundColor: style.backgroundColor,
          },
        }),
      ] as const;
    }));
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this.refreshActiveEditor()),
      vscode.window.onDidChangeVisibleTextEditors(() => void this.refreshAnnotatedEditors()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor !== vscode.window.activeTextEditor) {
          return;
        }
        this.clearSelectionTimer();
        this.selectionTimer = setTimeout(() => {
          this.selectionTimer = undefined;
          void this.refreshActiveEditor();
        }, SELECTION_DEBOUNCE_MS);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!this.annotatedDocuments.has(event.document.uri.toString())) {
          return;
        }
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === event.document) {
            void this.renderAnnotateGutter(editor);
          }
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        const repoRoot = resolveBlameRepository(this.coordinator, document.uri.fsPath);
        const relativePath = repoRoot === null ? null : repositoryRelativePath(repoRoot, document.uri.fsPath);
        if (repoRoot !== null && relativePath !== null) {
          this.blameService.invalidateFile(repoRoot, relativePath);
          if (document === vscode.window.activeTextEditor?.document) {
            void this.refreshActiveEditor();
          }
        }
        void this.refreshAnnotatedEditors();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.annotatedDocuments.delete(document.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('gitRepoAndBranchExplorer.blame')) {
          this.configuration = readConfiguration();
          void this.refreshActiveEditor();
          void this.refreshAnnotatedEditors();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.refreshActiveEditor();
        void this.refreshAnnotatedEditors();
      }),
      this.coordinator.onDidRepositoryChange((repoRoot) => {
        if (repoRoot === null) {
          this.blameService.clearCache();
          if (!this.reloadingAfterRepositoryRelease) {
            this.reloadingAfterRepositoryRelease = true;
            this.coordinator.refresh();
          }
        } else {
          this.reloadingAfterRepositoryRelease = false;
          this.blameService.invalidateRepo(repoRoot);
        }
        void this.refreshActiveEditor();
        void this.refreshAnnotatedEditors();
      }),
    );
    this.coordinator.refresh();
    void this.refreshActiveEditor();
  }

  public async toggleEnabled(): Promise<void> {
    const next = !readConfiguration().enabled;
    const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await vscode.workspace
      .getConfiguration('gitRepoAndBranchExplorer')
      .update('blame.enabled', next, target);
    this.configuration = readConfiguration();
    await this.refreshActiveEditor();
  }

  public async toggleAnnotateForActiveEditor(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.clearAllGutterDecorations();
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || editor.document.uri.scheme !== 'file') {
      return;
    }

    const documentKey = editor.document.uri.toString();
    if (this.annotatedDocuments.delete(documentKey)) {
      this.invalidateGutterRendersForDocument(documentKey);
      this.clearGutterDecorationsForDocument(documentKey);
      await this.refreshActiveEditor();
      return;
    }

    this.annotatedDocuments.add(documentKey);
    editor.setDecorations(this.decorationType, []);
    if (this.decoratedEditor === editor) {
      this.decoratedEditor = undefined;
    }
    await Promise.all([
      this.renderAnnotateGutter(editor),
      this.refreshActiveEditor(),
    ]);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.requestToken++;
    this.gutterRenderToken++;
    this.clearSelectionTimer();
    this.clearPresentation();
    this.clearAllGutterDecorations();
    this.decorationType.dispose();
    for (const decorationType of this.gutterDecorationTypes.values()) {
      decorationType.dispose();
    }
    this.statusBarItem.dispose();
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private async refreshActiveEditor(): Promise<void> {
    const token = ++this.requestToken;
    const editor = vscode.window.activeTextEditor;
    this.clearPreviousEditorDecoration(editor);
    if (
      editor === undefined ||
      editor.document.uri.scheme !== 'file' ||
      !this.configuration.enabled ||
      !vscode.workspace.isTrusted
    ) {
      this.clearPresentation();
      return;
    }

    const repoRoot = resolveBlameRepository(this.coordinator, editor.document.uri.fsPath);
    const relativePath = repoRoot === null
      ? null
      : repositoryRelativePath(repoRoot, editor.document.uri.fsPath);
    if (repoRoot === null || relativePath === null) {
      this.clearPresentation();
      return;
    }

    const lineNumber = editor.selection.active.line + 1;
    const lineText = editor.document.lineAt(editor.selection.active.line).text;
    const options = { ignoreWhitespace: this.configuration.ignoreWhitespace };
    let blameMap: FileBlameMap | undefined;
    try {
      if (editor.document.isDirty) {
        blameMap = this.blameService.getCachedFileBlame(repoRoot, relativePath, options);
      } else {
        blameMap = await this.blameService.getFileBlame(repoRoot, relativePath, options) ?? undefined;
      }
    } catch (err) {
      if (token !== this.requestToken || this.disposed) {
        return;
      }
      this.clearPresentation();
      void vscode.window.showWarningMessage(
        `Could not read Git blame for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (token !== this.requestToken || this.disposed || editor !== vscode.window.activeTextEditor) {
      return;
    }

    const cachedInfo = blameMap?.get(lineNumber);
    const info =
      editor.document.isDirty && (
        cachedInfo === undefined ||
        lineNumber > editor.document.lineCount ||
        (cachedInfo.sourceLine !== undefined && cachedInfo.sourceLine !== lineText)
      )
        ? uncommittedLineInfo(lineNumber, relativePath, lineText)
        : cachedInfo ?? uncommittedLineInfo(lineNumber, relativePath, lineText);

    const hover = await this.createHoverMarkdown(info, repoRoot, relativePath);
    if (this.annotatedDocuments.has(editor.document.uri.toString())) {
      editor.setDecorations(this.decorationType, []);
      if (this.decoratedEditor === editor) {
        this.decoratedEditor = undefined;
      }
    } else {
      const range = new vscode.Range(
        editor.selection.active.line,
        lineText.length,
        editor.selection.active.line,
        lineText.length,
      );
      editor.setDecorations(this.decorationType, [{
        range,
        hoverMessage: hover,
        renderOptions: { after: { contentText: `  ${formatInlineBlame(info)}` } },
      }]);
      this.decoratedEditor = editor;
    }
    this.updateStatusBar(info, hover);
  }

  private async renderAnnotateGutter(editor: vscode.TextEditor): Promise<void> {
    const documentKey = editor.document.uri.toString();
    if (
      !vscode.workspace.isTrusted ||
      !this.annotatedDocuments.has(documentKey) ||
      editor.document.uri.scheme !== 'file'
    ) {
      this.invalidateGutterRender(editor);
      this.clearGutterDecorations(editor);
      return;
    }

    const token = ++this.gutterRenderToken;
    this.gutterRenderTokens.set(editor, token);
    const repoRoot = resolveBlameRepository(this.coordinator, editor.document.uri.fsPath);
    const relativePath = repoRoot === null
      ? null
      : repositoryRelativePath(repoRoot, editor.document.uri.fsPath);
    if (repoRoot === null || relativePath === null) {
      this.clearGutterDecorations(editor);
      return;
    }

    let blameMap: FileBlameMap;
    try {
      blameMap = await this.blameService.getFileBlame(
        repoRoot,
        relativePath,
        { ignoreWhitespace: this.configuration.ignoreWhitespace },
      ) ?? new Map<number, BlameLineInfo>();
    } catch (err) {
      if (!this.isCurrentGutterRender(editor, token, documentKey)) {
        return;
      }
      this.clearGutterDecorations(editor);
      void vscode.window.showWarningMessage(
        `Could not read Git blame for ${relativePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (!this.isCurrentGutterRender(editor, token, documentKey)) {
      return;
    }

    const entries = buildBlameGutterEntries(
      blameMap,
      editor.document.lineCount,
      editor.document.isDirty,
    );
    const hoverByHash = new Map<string, vscode.MarkdownString>();
    const decorationsByBucket = new Map<BlameAgeBucket, vscode.DecorationOptions[]>(
      BLAME_AGE_BUCKETS.map((bucket) => [bucket, []]),
    );

    for (const entry of entries) {
      let hover = hoverByHash.get(entry.info.hash);
      if (hover === undefined) {
        hover = await this.createHoverMarkdown(entry.info, repoRoot, relativePath);
        hoverByHash.set(entry.info.hash, hover);
      }
      const line = entry.lineNumber - 1;
      decorationsByBucket.get(entry.bucket)?.push({
        range: new vscode.Range(line, 0, line, 0),
        hoverMessage: hover,
        renderOptions: { before: { contentText: entry.label } },
      });
    }

    for (const bucket of BLAME_AGE_BUCKETS) {
      const decorationType = this.gutterDecorationTypes.get(bucket);
      if (decorationType !== undefined) {
        editor.setDecorations(decorationType, decorationsByBucket.get(bucket) ?? []);
      }
    }
  }

  private async createHoverMarkdown(
    info: BlameLineInfo,
    repoRoot: string,
    relativePath: string,
  ): Promise<vscode.MarkdownString> {
    const githubRemoteUrl = await this.coordinator.getGithubRemoteUrlForRepo(repoRoot);
    const hover = new vscode.MarkdownString(
      buildBlameHoverMarkdown({
        info,
        repoRoot,
        relativePath,
        ...(githubRemoteUrl === undefined ? {} : { githubRemoteUrl }),
      }),
    );
    hover.supportThemeIcons = true;
    hover.isTrusted = { enabledCommands: [...BLAME_HOVER_ALLOWED_COMMANDS] };
    return hover;
  }

  private isCurrentGutterRender(
    editor: vscode.TextEditor,
    token: number,
    documentKey: string,
  ): boolean {
    return (
      !this.disposed &&
      vscode.workspace.isTrusted &&
      this.annotatedDocuments.has(documentKey) &&
      this.gutterRenderTokens.get(editor) === token &&
      editor.document.uri.toString() === documentKey &&
      vscode.window.visibleTextEditors.includes(editor)
    );
  }

  private async refreshAnnotatedEditors(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      this.clearAllGutterDecorations();
      return;
    }
    await Promise.all(vscode.window.visibleTextEditors
      .filter((editor) => this.annotatedDocuments.has(editor.document.uri.toString()))
      .map((editor) => this.renderAnnotateGutter(editor)));
  }

  private invalidateGutterRender(editor: vscode.TextEditor): void {
    this.gutterRenderTokens.set(editor, ++this.gutterRenderToken);
  }

  private invalidateGutterRendersForDocument(documentKey: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === documentKey) {
        this.invalidateGutterRender(editor);
      }
    }
  }

  private clearGutterDecorations(editor: vscode.TextEditor): void {
    for (const decorationType of this.gutterDecorationTypes.values()) {
      editor.setDecorations(decorationType, []);
    }
  }

  private clearGutterDecorationsForDocument(documentKey: string): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === documentKey) {
        this.clearGutterDecorations(editor);
      }
    }
  }

  private clearAllGutterDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.invalidateGutterRender(editor);
      this.clearGutterDecorations(editor);
    }
  }

  private updateStatusBar(info: BlameLineInfo, hover: vscode.MarkdownString): void {
    if (!this.configuration.showStatusBar) {
      this.statusBarItem.hide();
      return;
    }
    this.statusBarItem.text = `$(git-commit) ${formatInlineBlame(info, Date.now(), 34)}`;
    this.statusBarItem.tooltip = hover;
    this.statusBarItem.command = info.isUncommitted
      ? { command: TOGGLE_INLINE_BLAME_COMMAND, title: 'Toggle inline Git blame' }
      : {
          command: BLAME_HOVER_COMMANDS.revealCommitInTimeline,
          title: 'Reveal commit in timeline',
          arguments: [{ hash: info.hash }],
        };
    this.statusBarItem.show();
  }

  private clearPreviousEditorDecoration(editor: vscode.TextEditor | undefined): void {
    if (this.decoratedEditor !== undefined && this.decoratedEditor !== editor) {
      this.decoratedEditor.setDecorations(this.decorationType, []);
      this.decoratedEditor = undefined;
      this.statusBarItem.hide();
    }
  }

  private clearPresentation(): void {
    if (this.decoratedEditor !== undefined) {
      this.decoratedEditor.setDecorations(this.decorationType, []);
      this.decoratedEditor = undefined;
    } else {
      vscode.window.activeTextEditor?.setDecorations(this.decorationType, []);
    }
    this.statusBarItem.hide();
  }

  private clearSelectionTimer(): void {
    if (this.selectionTimer !== undefined) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = undefined;
    }
  }
}
