import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// An empty folder is opened as the workspace; the suite turns it into an isolated Git repository
// in suiteSetup and deletes it in suiteTeardown, so the developer's own repository is never touched.
const workspaceFolder = mkdtempSync(join(tmpdir(), 'grbe-integration-'));
// The test host has exited by now, so the (Windows-locked) workspace folder itself can be removed.
process.on('exit', () => {
  try {
    rmSync(workspaceFolder, { recursive: true, force: true });
  } catch {
    // Best effort: an OS temp-folder leftover must not turn a passing run into a failure.
  }
});

export default defineConfig({
  label: 'integration',
  files: 'out-test/**/*.integration.test.js',
  workspaceFolder,
  mocha: {
    ui: 'tdd',
    timeout: 60_000,
  },
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
});
