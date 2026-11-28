import * as vscode from 'vscode';
import type { FileBlameMap } from '../git/blameParser';
import { BLAME_HOVER_COMMANDS } from './blameHover';
import {
  computeSymbolInsight,
  flattenInsightSymbols,
  formatSymbolInsightCompact,
  formatSymbolInsightSummary,
  type InsightSymbolKind,
  type SimpleDocumentSymbol,
} from './symbolInsights';

const SYMBOL_KIND_MAP = new Map<vscode.SymbolKind, InsightSymbolKind>([
  [vscode.SymbolKind.Class, 'class'],
  [vscode.SymbolKind.Interface, 'interface'],
  [vscode.SymbolKind.Function, 'function'],
  [vscode.SymbolKind.Method, 'method'],
  [vscode.SymbolKind.Constructor, 'constructor'],
  [vscode.SymbolKind.Struct, 'struct'],
  [vscode.SymbolKind.Enum, 'enum'],
  [vscode.SymbolKind.Module, 'module'],
  [vscode.SymbolKind.Namespace, 'namespace'],
]);

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
): symbol is vscode.DocumentSymbol {
  return 'range' in symbol && 'selectionRange' in symbol && 'children' in symbol;
}

export function mapVscodeSymbols(
  raw: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined,
): SimpleDocumentSymbol[] {
  if (raw === undefined) {
    return [];
  }

  const mapSymbol = (
    symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
  ): SimpleDocumentSymbol[] => {
    const kind = SYMBOL_KIND_MAP.get(symbol.kind);
    if (kind === undefined) {
      return isDocumentSymbol(symbol) ? mapVscodeSymbols(symbol.children) : [];
    }
    if (isDocumentSymbol(symbol)) {
      const children = mapVscodeSymbols(symbol.children);
      return [{
        name: symbol.name,
        kind,
        startLine: symbol.range.start.line + 1,
        endLine: symbol.range.end.line + 1,
        selectionLine: symbol.selectionRange.start.line + 1,
        ...(children.length > 0 ? { children } : {}),
      }];
    }
    return [{
      name: symbol.name,
      kind,
      startLine: symbol.location.range.start.line + 1,
      endLine: symbol.location.range.end.line + 1,
      selectionLine: symbol.location.range.start.line + 1,
    }];
  };

  return raw.flatMap(mapSymbol);
}

export async function fetchDocumentInsightSymbols(
  uri: vscode.Uri,
): Promise<SimpleDocumentSymbol[]> {
  try {
    const symbols = await vscode.commands.executeCommand<
      (vscode.DocumentSymbol | vscode.SymbolInformation)[]
    >('vscode.executeDocumentSymbolProvider', uri);
    return mapVscodeSymbols(symbols);
  } catch {
    return [];
  }
}

interface SymbolInsightsCodeLensProviderOptions {
  isEnabled: () => boolean;
  getBlameForDocument: (
    doc: vscode.TextDocument,
  ) => Promise<{ repoRoot: string; blameMap: FileBlameMap } | null>;
  getSymbolsForDocument: (
    doc: vscode.TextDocument,
  ) => Promise<readonly SimpleDocumentSymbol[]>;
}

export class SymbolInsightsCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly options: SymbolInsightsCodeLensProviderOptions;

  public readonly onDidChangeCodeLenses: vscode.Event<void> = this.changeEmitter.event;

  public constructor(options: SymbolInsightsCodeLensProviderOptions) {
    this.options = options;
  }

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  public async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (
      !vscode.workspace.isTrusted ||
      document.uri.scheme !== 'file' ||
      !this.options.isEnabled() ||
      token.isCancellationRequested
    ) {
      return [];
    }

    const [blame, symbols] = await Promise.all([
      this.options.getBlameForDocument(document),
      this.options.getSymbolsForDocument(document),
    ]);
    if (
      blame === null ||
      token.isCancellationRequested ||
      !vscode.workspace.isTrusted ||
      !this.options.isEnabled()
    ) {
      return [];
    }

    const symbolsByLine = new Map<number, SimpleDocumentSymbol>();
    for (const symbol of flattenInsightSymbols(symbols)) {
      const existing = symbolsByLine.get(symbol.selectionLine);
      if (
        existing === undefined ||
        symbol.endLine - symbol.startLine > existing.endLine - existing.startLine
      ) {
        symbolsByLine.set(symbol.selectionLine, symbol);
      }
    }
    const lenses: vscode.CodeLens[] = [];
    for (const symbol of symbolsByLine.values()) {
      const insight = computeSymbolInsight(symbol, blame.blameMap);
      if (insight === null) {
        continue;
      }
      const line = insight.selectionLine - 1;
      if (line < 0 || line >= document.lineCount) {
        continue;
      }
      const command = insight.lastModifiedHash.length > 0
        ? {
            title: formatSymbolInsightCompact(insight),
            tooltip: `${insight.name}: ${formatSymbolInsightSummary(insight)}`,
            command: BLAME_HOVER_COMMANDS.revealCommitInTimeline,
            arguments: [{ hash: insight.lastModifiedHash, repoRoot: blame.repoRoot }],
          }
        : {
            title: formatSymbolInsightCompact(insight),
            tooltip: `${insight.name}: ${formatSymbolInsightSummary(insight)}`,
            command: '',
          };
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), command));
    }
    return lenses;
  }
}
