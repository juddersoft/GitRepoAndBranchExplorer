import * as vscode from 'vscode';

/** Known publishers of the "Git Graph" extension, in order of preference. */
export const GIT_GRAPH_EXTENSION_IDS = ['mhutchie.git-graph', 'erancihan.vscode-git-graph'] as const;
const GIT_GRAPH_VIEW_COMMAND = 'git-graph.view';

export function findGitGraphExtensionId(): string | null {
  return GIT_GRAPH_EXTENSION_IDS.find((id) => vscode.extensions.getExtension(id) !== undefined) ?? null;
}

export function isGitGraphAvailable(): boolean {
  return findGitGraphExtensionId() !== null;
}

/** Opens Git Graph for the repository; shows a friendly message when it is not installed or fails. */
export async function openInGitGraph(repoRoot: string): Promise<boolean> {
  if (!isGitGraphAvailable()) {
    void vscode.window.showInformationMessage(
      'The "Git Graph" extension is not installed. Install mhutchie.git-graph to open this repository in Git Graph.',
    );
    return false;
  }
  try {
    await vscode.commands.executeCommand(GIT_GRAPH_VIEW_COMMAND, { path: repoRoot });
    return true;
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not open Git Graph: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
