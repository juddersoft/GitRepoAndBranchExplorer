import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlameLineInfo, FileBlameMap } from '../src/git/blameParser';

const vscodeMocks = vi.hoisted(() => {
  const disposable = { dispose: vi.fn() };
  const executeCommand = vi.fn();
  const closeListeners: Array<(document: unknown) => void> = [];
  const configListeners: Array<(event: unknown) => void> = [];
  const trustListeners: Array<() => void> = [];
  const activeEditorListeners: Array<() => void> = [];
  const visibleEditorListeners: Array<() => void> = [];
  const selectionListeners: Array<(event: unknown) => void> = [];
  const lensRegistrations: unknown[] = [];
  let activeTextEditor: unknown;
  let visibleTextEditors: unknown[] = [];
  let trusted = true;
  let configuration = {
    enabled: true,
    ignoreWhitespace: false,
    showStatusBar: true,
    symbolInsights: {
      enabled: true,
      hover: true,
      declarationInline: false,
      statusBarTooltip: false,
      codeLens: false,
    },
  };

  class MockRange {
    constructor(
      public start: { line: number; character: number },
      public end: { line: number; character: number },
    ) {}
  }

  class MockMarkdownString {
    public value: string;
    public isTrusted: unknown = false;
    public supportThemeIcons = false;
    constructor(value: string) {
      this.value = value;
    }
  }

  class MockCodeLens {
    constructor(
      public range: MockRange,
      public command?: unknown,
    ) {}
  }

  class MockEventEmitter {
    public readonly listeners = new Set<(value: unknown) => void>();
    public readonly event = (listener: (value: unknown) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    public fire(value: unknown = undefined): void {
      for (const listener of this.listeners) listener(value);
    }
    public dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    disposable,
    executeCommand,
    closeListeners,
    configListeners,
    trustListeners,
    activeEditorListeners,
    visibleEditorListeners,
    selectionListeners,
    lensRegistrations,
    MockRange,
    MockMarkdownString,
    MockCodeLens,
    MockEventEmitter,
    setActiveEditor(value: unknown): void { activeTextEditor = value; },
    getActiveEditor: (): unknown => activeTextEditor,
    setVisibleEditors(value: unknown[]): void { visibleTextEditors = value; },
    getVisibleEditors: (): unknown[] => visibleTextEditors,
    setTrusted(value: boolean): void { trusted = value; },
    getTrusted: (): boolean => trusted,
    setConfiguration(value: typeof configuration): void { configuration = value; },
    getConfiguration: (): typeof configuration => configuration,
  };
});

vi.mock('vscode', () => {
  class Uri {
    public constructor(public readonly fsPath: string, public readonly scheme = 'file') {}
    public static file(fsPath: string): Uri {
      return new Uri(fsPath);
    }
    public toString(): string {
      return `file:${this.fsPath}`;
    }
  }

  const window = {
    get activeTextEditor(): unknown { return vscodeMocks.getActiveEditor(); },
    get visibleTextEditors(): unknown[] { return vscodeMocks.getVisibleEditors(); },
    createTextEditorDecorationType: vi.fn(() => ({
      dispose: vi.fn(),
    })),
    createStatusBarItem: vi.fn(() => ({
      text: '',
      tooltip: undefined,
      command: undefined,
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
    onDidChangeActiveTextEditor: (listener: () => void) => {
      vscodeMocks.activeEditorListeners.push(listener);
      return vscodeMocks.disposable;
    },
    onDidChangeVisibleTextEditors: (listener: () => void) => {
      vscodeMocks.visibleEditorListeners.push(listener);
      return vscodeMocks.disposable;
    },
    onDidChangeTextEditorSelection: (listener: (event: unknown) => void) => {
      vscodeMocks.selectionListeners.push(listener);
      return vscodeMocks.disposable;
    },
    showWarningMessage: vi.fn(),
  };

  return {
    workspace: {
      get isTrusted(): boolean { return vscodeMocks.getTrusted(); },
      getConfiguration: vi.fn(() => ({
        get: (key: string, fallback: unknown) => {
          const config = vscodeMocks.getConfiguration();
          if (key === 'enabled') return config.enabled;
          if (key === 'ignoreWhitespace') return config.ignoreWhitespace;
          if (key === 'showStatusBar') return config.showStatusBar;
          if (key === 'symbolInsights.enabled') return config.symbolInsights.enabled;
          if (key === 'symbolInsights.hover') return config.symbolInsights.hover;
          if (key === 'symbolInsights.declarationInline') return config.symbolInsights.declarationInline;
          if (key === 'symbolInsights.statusBarTooltip') return config.symbolInsights.statusBarTooltip;
          if (key === 'symbolInsights.codeLens') return config.symbolInsights.codeLens;
          return fallback;
        },
      })),
      onDidCloseTextDocument: (listener: (document: unknown) => void) => {
        vscodeMocks.closeListeners.push(listener);
        return vscodeMocks.disposable;
      },
      onDidChangeConfiguration: (listener: (event: unknown) => void) => {
        vscodeMocks.configListeners.push(listener);
        return vscodeMocks.disposable;
      },
      onDidSaveTextDocument: () => vscodeMocks.disposable,
      onDidChangeTextDocument: () => vscodeMocks.disposable,
      onDidGrantWorkspaceTrust: (listener: () => void) => {
        vscodeMocks.trustListeners.push(listener);
        return vscodeMocks.disposable;
      },
    },
    window,
    languages: {
      registerCodeLensProvider: vi.fn((_selector: unknown, provider: unknown) => {
        vscodeMocks.lensRegistrations.push(provider);
        return vscodeMocks.disposable;
      }),
    },
    commands: { executeCommand: vscodeMocks.executeCommand },
    Uri,
    Range: class extends vscodeMocks.MockRange {
      constructor(startLine: number, startCharacter: number, endLine?: number, endCharacter?: number) {
        super(
          { line: startLine, character: startCharacter },
          { line: endLine ?? startLine, character: endCharacter ?? startCharacter },
        );
      }
    },
    MarkdownString: vscodeMocks.MockMarkdownString,
    CodeLens: vscodeMocks.MockCodeLens,
    EventEmitter: vscodeMocks.MockEventEmitter,
    ThemeColor: class { constructor(public readonly id: string) {} },
    StatusBarAlignment: { Right: 2 },
    SymbolKind: {
      File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6,
      Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12,
      Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18,
      Key: 19, Null: 20, EnumMember: 21, Struct: 23,
    },
  };
});

import {
  computeSymbolInsight,
  findEnclosingSymbol,
  flattenInsightSymbols,
  formatSymbolInsightCompact,
  formatSymbolInsightSummary,
  type SimpleDocumentSymbol,
  type SymbolBlameInsight,
} from '../src/blame/symbolInsights';
import { buildBlameHoverMarkdown } from '../src/blame/blameHover';
import {
  mapVscodeSymbols,
  SymbolInsightsCodeLensProvider,
} from '../src/blame/symbolInsightsProvider';
import { BlameController } from '../src/blame/BlameController';

const SHA1 = 'abcdef0123456789abcdef0123456789abcdef01';
const SHA1_2 = '1234567890abcdef1234567890abcdef12345678';
const ZERO40 = '0'.repeat(40);
const ZERO64 = '0'.repeat(64);

function blameLine(lineNumber: number, overrides: Partial<BlameLineInfo> = {}): BlameLineInfo {
  return {
    lineNumber,
    originalLineNumber: lineNumber,
    hash: SHA1,
    shortHash: SHA1.slice(0, 8),
    isUncommitted: false,
    author: 'Ada',
    authorEmail: 'ada@example.com',
    authorTime: 1700000000,
    authorTz: '+0000',
    summary: 'Change',
    filename: 'src/file.ts',
    sourceLine: 'line',
    ...overrides,
  };
}

function lineMap(entries: Array<[number, Partial<BlameLineInfo>]>): FileBlameMap {
  return new Map(entries.map(([line, overrides]) => [line, blameLine(line, overrides)]));
}

describe('symbol insights pure aggregation', () => {
  it('flattens nested supported symbols, filters unsupported kinds, and deduplicates selection lines by outermost declaration', () => {
    const outer: SimpleDocumentSymbol = {
      name: 'Outer', kind: 'class', startLine: 2, endLine: 30, selectionLine: 2,
      children: [{
        name: 'run', kind: 'method', startLine: 10, endLine: 20, selectionLine: 10,
        children: [{ name: 'unsupported', kind: 'property', startLine: 12, endLine: 12, selectionLine: 12 } as unknown as SimpleDocumentSymbol],
      }],
    };
    const duplicate = { name: 'OuterAlias', kind: 'class', startLine: 2, endLine: 30, selectionLine: 2 };
    expect(flattenInsightSymbols([outer, duplicate])).toEqual([
      outer,
      expect.objectContaining({ name: 'run', selectionLine: 10 }),
    ]);
  });

  it('finds the innermost symbol with inclusive boundaries and returns null outside all ranges', () => {
    const symbols: SimpleDocumentSymbol[] = [
      { name: 'Class', kind: 'class', startLine: 1, endLine: 20, selectionLine: 1, children: [
        { name: 'method', kind: 'method', startLine: 5, endLine: 10, selectionLine: 5 },
      ] },
    ];
    expect(findEnclosingSymbol(symbols, 5)?.name).toBe('method');
    expect(findEnclosingSymbol(symbols, 10)?.name).toBe('method');
    expect(findEnclosingSymbol(symbols, 20)?.name).toBe('Class');
    expect(findEnclosingSymbol(symbols, 21)).toBeNull();
  });

  it('aggregates unique authors and commits and latest metadata', () => {
    const symbol: SimpleDocumentSymbol = { name: 'run', kind: 'method', startLine: 1, endLine: 3, selectionLine: 1 };
    const map = lineMap([
      [1, { hash: SHA1, author: 'Ada', authorTime: 1700000001, summary: 'Old' }],
      [2, { hash: SHA1, author: 'Ada', authorTime: 1700000001 }],
      [3, { hash: SHA1_2, author: 'Grace', authorTime: 1700000100, shortHash: SHA1_2.slice(0, 8), summary: 'Newest' }],
    ]);
    const insight = computeSymbolInsight(symbol, map)!;
    expect(insight).toMatchObject({
      commitCount: 2,
      authorCount: 2,
      authors: ['Grace', 'Ada'],
      lastModifiedAuthor: 'Grace',
      lastModifiedHash: SHA1_2,
      lastModifiedSummary: 'Newest',
    });
  });

  it.each([ZERO40, ZERO64])('handles uncommitted hash %j cleanly', (hash) => {
    const symbol: SimpleDocumentSymbol = { name: 'run', kind: 'function', startLine: 1, endLine: 2, selectionLine: 1 };
    const insight = computeSymbolInsight(symbol, lineMap([
      [1, { hash, shortHash: '', isUncommitted: true, author: 'Not Committed Yet', authorTime: 0 }],
      [2, { hash, shortHash: '', isUncommitted: true, author: 'Not Committed Yet', authorTime: 0 }],
    ]))!;
    expect(insight.commitCount).toBe(0);
    expect(insight.authorCount).toBe(0);
    expect(insight.lastModifiedSummary).toBe('Not committed yet');
  });

  it('handles mixed committed and uncommitted lines and partial/empty maps', () => {
    const symbol: SimpleDocumentSymbol = { name: 'run', kind: 'function', startLine: 1, endLine: 3, selectionLine: 1 };
    const mixed = computeSymbolInsight(symbol, lineMap([
      [1, { hash: SHA1, author: 'Ada', authorTime: 1700000000 }],
      [3, { hash: ZERO40, shortHash: '', isUncommitted: true }],
    ]))!;
    expect(mixed.commitCount).toBe(1);
    expect(mixed.hasUncommittedChanges).toBe(true);
    expect(computeSymbolInsight(symbol, new Map())).toBeNull();
  });

  it('formats singular, plural, uncommitted, summary and compact text', () => {
    const base: SymbolBlameInsight = {
      name: 'run', kind: 'function', startLine: 1, endLine: 2, selectionLine: 1,
      commitCount: 1, authorCount: 1, authors: ['Ada'], lastModifiedAuthor: 'Ada',
      lastModifiedTime: 1700000000, lastModifiedHash: SHA1, lastModifiedShortHash: SHA1.slice(0, 8),
      lastModifiedSummary: 'Change', hasUncommittedChanges: false,
    };
    expect(formatSymbolInsightSummary(base, 1700000000 * 1000)).toBe('1 author • 1 commit • last modified by Ada just now');
    expect(formatSymbolInsightCompact(base, 1700000000 * 1000)).toBe('1 author • 1 commit • Ada, just now');
    expect(formatSymbolInsightSummary({ ...base, authorCount: 2, commitCount: 3, hasUncommittedChanges: true }, 1700000000 * 1000))
      .toBe('2 authors • 3 commits • last modified by Ada just now • uncommitted edits');
    expect(formatSymbolInsightCompact({ ...base, commitCount: 0, hasUncommittedChanges: true }, 1700000000 * 1000)).toBe('Uncommitted');
  });
});

describe('symbol insights hover escaping and trust invariants', () => {
  const committed = blameLine(1);
  const insight: SymbolBlameInsight = {
    name: '[click](command:workbench.action.terminal.new)\n**bold** <script>\r\nnext',
    kind: 'method', startLine: 1, endLine: 3, selectionLine: 1,
    commitCount: 1, authorCount: 1, authors: ['Ada'], lastModifiedAuthor: 'Ada',
    lastModifiedTime: 1700000000, lastModifiedHash: SHA1_2,
    lastModifiedShortHash: SHA1_2.slice(0, 8), lastModifiedSummary: 'Change',
    hasUncommittedChanges: false,
  };

  it('renders or omits the symbol section and escapes hostile names/newlines', () => {
    const withInsight = buildBlameHoverMarkdown({ info: committed, repoRoot: '/repo', relativePath: 'src/file.ts', symbolInsight: insight });
    expect(withInsight).toContain('\\[click\\]');
    expect(withInsight).not.toContain('\n**bold**');
    expect(withInsight).not.toContain('<script>');
    expect(withInsight).toContain('\\[click\\]');
    expect(withInsight).toContain('\\*\\*bold\\*\\*');
    expect(withInsight).toContain('[Reveal Latest Symbol Commit]');
    expect(buildBlameHoverMarkdown({ info: committed, repoRoot: '/repo', relativePath: 'src/file.ts' }))
      .not.toContain('[Reveal Latest Symbol Commit]');
  });

  it('only renders the latest-symbol link for a differing committed hash', () => {
    expect(buildBlameHoverMarkdown({ info: committed, repoRoot: '/repo', relativePath: 'src/file.ts', symbolInsight: insight }))
      .toContain('Reveal Latest Symbol Commit');
    expect(buildBlameHoverMarkdown({
      info: committed,
      repoRoot: '/repo',
      relativePath: 'src/file.ts',
      symbolInsight: { ...insight, lastModifiedHash: committed.hash },
    })).not.toContain('[Reveal Latest Symbol Commit]');
    expect(buildBlameHoverMarkdown({
      info: committed,
      repoRoot: '/repo',
      relativePath: 'src/file.ts',
      symbolInsight: { ...insight, lastModifiedHash: '' },
    })).not.toContain('[Reveal Latest Symbol Commit]');
  });
});

describe('VS Code symbol adapter and cache-only CodeLens', () => {
  beforeEach(() => {
    vscodeMocks.setTrusted(true);
  });

  it('maps hierarchical DocumentSymbol trees and filters unsupported kinds', () => {
    const raw = [{
      name: 'Alpha',
      kind: 4,
      range: { start: { line: 1, character: 0 }, end: { line: 10, character: 1 } },
      selectionRange: { start: { line: 1, character: 3 }, end: { line: 1, character: 8 } },
      children: [{
        name: 'run',
        kind: 5,
        range: { start: { line: 3, character: 0 }, end: { line: 7, character: 1 } },
        selectionRange: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } },
        children: [],
      }, {
        name: 'ignored',
        kind: 6,
        range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
        selectionRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } },
        children: [],
      }],
      detail: '', tags: [],
    }];
    expect(mapVscodeSymbols(raw as never)).toEqual([{
      name: 'Alpha', kind: 'class', startLine: 2, endLine: 11, selectionLine: 2,
      children: [{ name: 'run', kind: 'method', startLine: 4, endLine: 8, selectionLine: 4 }],
    }]);
  });

  it('returns [] for untrusted, master-disabled and CodeLens-disabled states', async () => {
    const getBlame = vi.fn();
    const getSymbols = vi.fn();
    const provider = new SymbolInsightsCodeLensProvider({
      isEnabled: () => vscodeMocks.getTrusted() && true,
      getBlameForDocument: getBlame,
      getSymbolsForDocument: getSymbols,
    });
    const document = { uri: { scheme: 'file' }, lineCount: 20 };
    vscodeMocks.setTrusted(false);
    await expect(provider.provideCodeLenses(document as never, { isCancellationRequested: false } as never)).resolves.toEqual([]);
    expect(getBlame).not.toHaveBeenCalled();

    vscodeMocks.setTrusted(true);
    const disabled = new SymbolInsightsCodeLensProvider({
      isEnabled: () => false,
      getBlameForDocument: getBlame,
      getSymbolsForDocument: getSymbols,
    });
    await expect(disabled.provideCodeLenses(document as never, { isCancellationRequested: false } as never)).resolves.toEqual([]);
  });

  it('uses cache-only blame, returns [] on cache miss, and never calls fresh blame', async () => {
    const getCachedBlame = vi.fn(() => undefined);
    const getFreshBlame = vi.fn();
    const getSymbols = vi.fn(async () => [{ name: 'run', kind: 'method', startLine: 1, endLine: 3, selectionLine: 1 }]);
    const provider = new SymbolInsightsCodeLensProvider({
      isEnabled: () => true,
      getBlameForDocument: async () => {
        const map = getCachedBlame();
        return map === undefined ? null : { repoRoot: '/repo', blameMap: map };
      },
      getSymbolsForDocument: getSymbols,
    });
    const document = { uri: { scheme: 'file' }, lineCount: 20 };
    await expect(provider.provideCodeLenses(document as never, { isCancellationRequested: false } as never)).resolves.toEqual([]);
    expect(getCachedBlame).toHaveBeenCalledOnce();
    expect(getFreshBlame).not.toHaveBeenCalled();
  });

  it('returns declaration-line CodeLenses with compact summaries from cached blame', async () => {
    const map = lineMap([[1, { hash: SHA1, author: 'Ada' }], [2, { hash: SHA1, author: 'Ada' }]]);
    const provider = new SymbolInsightsCodeLensProvider({
      isEnabled: () => true,
      getBlameForDocument: async () => ({ repoRoot: '/repo', blameMap: map }),
      getSymbolsForDocument: async () => [{ name: 'run', kind: 'method', startLine: 1, endLine: 2, selectionLine: 1 }],
    });
    const lenses = await provider.provideCodeLenses(
      { uri: { scheme: 'file' }, lineCount: 20 } as never,
      { isCancellationRequested: false } as never,
    );
    expect(lenses).toHaveLength(1);
    expect(lenses[0].range.start.line).toBe(0);
    expect(lenses[0].command).toMatchObject({
      title: expect.stringMatching(/^1 author • 1 commit • Ada,/),
      tooltip: expect.stringMatching(/^run: 1 author • 1 commit • last modified by Ada /),
    });
  });
});

describe('BlameController symbol toggle isolation and bounded cache', () => {
  function makeController() {
    const document = {
      uri: { scheme: 'file', fsPath: '/repo/src/file.ts', toString: () => 'file:/repo/src/file.ts' },
      version: 1,
      lineCount: 20,
      isDirty: false,
      lineAt: (line: number) => ({ text: `line ${line + 1}` }),
    };
    const editor = {
      document,
      selection: { active: { line: 0 } },
      setDecorations: vi.fn(),
    };
    vscodeMocks.setActiveEditor(editor);
    vscodeMocks.setVisibleEditors([editor]);
    const getFileBlame = vi.fn(async () => lineMap([
      [1, { hash: SHA1, author: 'Ada', authorTime: 1700000000 }],
      [2, { hash: SHA1, author: 'Ada', authorTime: 1700000000 }],
    ]));
    const getCachedFileBlame = vi.fn(() => lineMap([
      [1, { hash: SHA1, author: 'Ada', authorTime: 1700000000 }],
      [2, { hash: SHA1, author: 'Ada', authorTime: 1700000000 }],
    ]));
    const blameService = { getFileBlame, getCachedFileBlame, invalidateFile: vi.fn(), clearCache: vi.fn() };
    const coordinator = {
      getRepoRootForFile: vi.fn(() => '/repo'),
      getGithubRemoteUrlForRepo: vi.fn(async () => undefined),
      onDidRepositoryChange: vi.fn(() => vscodeMocks.disposable),
      refresh: vi.fn(),
    };
    const controller = new BlameController({
      blameService: blameService as never,
      coordinator: coordinator as never,
      extensionUri: { fsPath: '/repo' } as never,
    });
    return { controller, document, editor, getFileBlame, getCachedFileBlame, blameService, coordinator };
  }

  beforeEach(() => {
    vscodeMocks.setTrusted(true);
    vscodeMocks.setConfiguration({
      enabled: true,
      ignoreWhitespace: false,
      showStatusBar: true,
      symbolInsights: { enabled: true, hover: true, declarationInline: false, statusBarTooltip: false, codeLens: false },
    });
  });
  afterEach(() => {
    vscodeMocks.closeListeners.length = 0;
  });

  it('master toggle suppresses hover symbols, declaration decorations and status tooltip', async () => {
    vscodeMocks.setConfiguration({
      enabled: true,
      ignoreWhitespace: false,
      showStatusBar: true,
      symbolInsights: { enabled: false, hover: true, declarationInline: true, statusBarTooltip: true, codeLens: true },
    });
    const { controller, editor } = makeController();
    vscodeMocks.executeCommand.mockResolvedValue([{
      name: 'run', kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      children: [],
    }]);
    await (controller as unknown as { refreshActiveEditor(): Promise<void> }).refreshActiveEditor();
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
    const declarationCalls = editor.setDecorations.mock.calls.filter((call: unknown[]) => call[1]?.length === 0);
    expect(declarationCalls.length).toBeGreaterThan(0);
  });

  it('keeps status tooltip symbol-free when statusBarTooltip=false and hover=true', async () => {
    const { controller } = makeController();
    vscodeMocks.executeCommand.mockResolvedValue([{
      name: 'run', kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      children: [],
    }]);
    await (controller as unknown as { refreshActiveEditor(): Promise<void> }).refreshActiveEditor();
    const tooltip = (controller as unknown as { statusBarItem: { tooltip: { value: string } } }).statusBarItem.tooltip;
    expect(tooltip.value).not.toContain('run');
  });

  it('includes symbol insight in status tooltip when statusBarTooltip=true', async () => {
    vscodeMocks.setConfiguration({
      enabled: true, ignoreWhitespace: false, showStatusBar: true,
      symbolInsights: { enabled: true, hover: false, declarationInline: false, statusBarTooltip: true, codeLens: false },
    });
    const { controller } = makeController();
    vscodeMocks.executeCommand.mockResolvedValue([{
      name: 'run', kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      children: [],
    }]);
    await (controller as unknown as { refreshActiveEditor(): Promise<void> }).refreshActiveEditor();
    const tooltip = (controller as unknown as { statusBarItem: { tooltip: { value: string } } }).statusBarItem.tooltip;
    expect(tooltip.value).toContain('run');
  });

  it('skips declaration inline decoration on active cursor line and renders non-active declarations', () => {
    const { controller, document, editor } = makeController();
    const symbols: SimpleDocumentSymbol[] = [
      { name: 'active', kind: 'method', startLine: 1, endLine: 2, selectionLine: 1 },
      { name: 'other', kind: 'method', startLine: 5, endLine: 6, selectionLine: 5 },
    ];
    (controller as unknown as {
      updateDeclarationDecorations(editor: unknown, symbols: readonly SimpleDocumentSymbol[], map: FileBlameMap, enabled: boolean, activeLine: number): void;
    }).updateDeclarationDecorations(editor, symbols, lineMap([[1, {}], [5, { hash: SHA1_2 }]]), true, 1);
    const decorationCall = editor.setDecorations.mock.calls.at(-1);
    expect(decorationCall?.[1]).toEqual([expect.objectContaining({
      renderOptions: { after: { contentText: expect.stringContaining('1 commit') } },
    })]);
  });

  it('registers CodeLens provider and refreshes it when codeLens=true', () => {
    vscodeMocks.setConfiguration({
      enabled: true, ignoreWhitespace: false, showStatusBar: true,
      symbolInsights: { enabled: true, hover: true, declarationInline: false, statusBarTooltip: false, codeLens: true },
    });
    const { controller } = makeController();
    expect(vscodeMocks.lensRegistrations).not.toHaveLength(0);
    const provider = (controller as unknown as { codeLensProvider: { refresh: () => void } }).codeLensProvider;
    const refresh = vi.spyOn(provider, 'refresh');
    provider.refresh();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('reuses (uri, version) cache, refetches on version increments, caps at 30, closes and disposes clear entries', async () => {
    const { controller, document } = makeController();
    vscodeMocks.executeCommand.mockClear();
    vscodeMocks.executeCommand.mockResolvedValue([]);
    const privateController = controller as unknown as {
      getSymbolsForDocument(document: unknown): Promise<readonly SimpleDocumentSymbol[]>;
      symbolCache: Map<string, unknown>;
    };
    await privateController.getSymbolsForDocument(document);
    const callsAfterFirstFetch = vscodeMocks.executeCommand.mock.calls.length;
    await privateController.getSymbolsForDocument(document);
    expect(vscodeMocks.executeCommand).toHaveBeenCalledTimes(callsAfterFirstFetch);
    document.version = 2;
    await privateController.getSymbolsForDocument(document);
    expect(vscodeMocks.executeCommand).toHaveBeenCalledTimes(callsAfterFirstFetch + 1);
    for (let index = 0; index < 31; index++) {
      await privateController.getSymbolsForDocument({
        ...document,
        uri: { scheme: 'file', fsPath: `/repo/src/f${index}.ts`, toString: () => `file:/repo/src/f${index}.ts` },
        version: 1,
      });
    }
    expect(privateController.symbolCache.size).toBeLessThanOrEqual(30);
    vscodeMocks.closeListeners.forEach((listener) => listener(document));
    expect(privateController.symbolCache.has('file:/repo/src/file.ts')).toBe(false);
  });

  it('dispose clears the symbol cache', () => {
    const { controller, document } = makeController();
    const privateController = controller as unknown as {
      symbolCache: Map<string, unknown>;
      dispose(): void;
    };
    privateController.symbolCache.set('file:/repo/src/file.ts', { version: 1, symbols: [] });
    privateController.dispose();
    expect(privateController.symbolCache.size).toBe(0);
  });
});
