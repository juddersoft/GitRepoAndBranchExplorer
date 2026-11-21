import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'PeterJudd.git-repo-and-branch-explorer';
const OPEN_REPOSITORY_COMMAND = 'gitRepoAndBranchExplorer.openRepository';
const REFRESH_COMMAND = 'gitRepoAndBranchExplorer.refresh';
const PANEL_VIEW_TYPE = 'gitRepoAndBranchExplorer.panel';
const FIXTURE_PREFIX = 'grbe-integration-';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Integration Test', '-c', 'user.email=integration@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
}

/** Refuses to touch anything except the throwaway temp folder that `.vscode-test.mjs` opened. */
function getFixtureRepoPath(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(folder, 'The integration tests must be launched with a workspace folder.');
  const realFolder = fs.realpathSync.native(folder);
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  assert.ok(
    path.basename(realFolder).startsWith(FIXTURE_PREFIX) && path.relative(tempRoot, path.dirname(realFolder)) === '',
    `Refusing to use ${folder} as a fixture repository; expected a ${FIXTURE_PREFIX}* folder directly inside ${tempRoot}.`,
  );
  assert.ok(!fs.existsSync(path.join(realFolder, '.git')), `${folder} is already a Git repository.`);
  return realFolder;
}

async function waitForPanelTab(timeoutMs: number): Promise<vscode.Tab | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(PANEL_VIEW_TYPE));
    if (tab || Date.now() >= deadline) {
      return tab;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

suite('Git Repo & Branch Explorer extension host', () => {
  let repoPath: string | undefined;

  suiteSetup(() => {
    repoPath = getFixtureRepoPath();
    git(repoPath, 'init', '-b', 'main');
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Integration fixture\n', 'utf8');
    git(repoPath, 'add', 'README.md');
    git(repoPath, 'commit', '-m', 'Initial commit');
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (!repoPath) {
      return;
    }
    // Windows keeps the open workspace folder (and briefly, watched .git folders) locked, so delete
    // asynchronously with retries; .vscode-test.mjs removes anything still locked once VS Code exits.
    try {
      await fs.promises.rm(repoPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY') {
        throw err;
      }
      console.log(`Fixture ${repoPath} is still locked (${code}); it is removed when the test runner exits.`);
    }
  });

  test('fixture repository has an initial commit on main', () => {
    assert.ok(repoPath);
    assert.strictEqual(git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    assert.match(git(repoPath, 'rev-parse', 'HEAD').trim(), /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
  });

  test('extension activates cleanly', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not available in the test host.`);
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  test('contributed commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes(OPEN_REPOSITORY_COMMAND), `${OPEN_REPOSITORY_COMMAND} is not registered.`);
    assert.ok(commands.includes(REFRESH_COMMAND), `${REFRESH_COMMAND} is not registered.`);
  });

  test('openRepository opens the Git Repository panel without throwing', async () => {
    await vscode.commands.executeCommand(OPEN_REPOSITORY_COMMAND);
    await vscode.commands.executeCommand(REFRESH_COMMAND);

    const panelTab = await waitForPanelTab(10_000);
    assert.ok(panelTab, 'The Git Repository webview panel did not open.');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('openRepository moves the panel tab to the far left of its group', async () => {
    assert.ok(repoPath);
    const document = await vscode.workspace.openTextDocument(path.join(repoPath, 'README.md'));
    await vscode.window.showTextDocument(document, { preview: false });

    await vscode.commands.executeCommand(OPEN_REPOSITORY_COMMAND);
    const panelTab = await waitForPanelTab(10_000);
    assert.ok(panelTab, 'The Git Repository webview panel did not open.');

    const group = panelTab.group;
    assert.ok(group.tabs.length >= 2, 'Expected the README tab next to the panel tab.');
    assert.strictEqual(group.tabs[0], panelTab, 'The panel tab should be first in its editor group.');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('an unpinned panel closes when another sidebar view container is selected', async () => {
    await vscode.commands.executeCommand(OPEN_REPOSITORY_COMMAND);
    assert.ok(await waitForPanelTab(10_000), 'The Git Repository webview panel did not open.');

    await vscode.commands.executeCommand('workbench.view.explorer');
    const deadline = Date.now() + 10_000;
    while ((await waitForPanelTab(0)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.strictEqual(await waitForPanelTab(0), undefined, 'The unpinned panel should close after switching sidebar views.');
  });
});
