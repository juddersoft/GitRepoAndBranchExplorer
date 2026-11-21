# Git Repo & Branch Explorer

A Visual Studio-style **Git Repository** window for VS Code: a branch and remote tree on the left, a multi-lane commit graph and history table on the right, and commit details with one-click file diffs.

![Git Repo & Branch Explorer icon](media/icon.png)

## Features

### Split-pane branch and remote explorer
- Local branches, `remotes/<name>` groups and tags in one filterable tree.
- The current branch is highlighted, with ahead/behind counts against its upstream.
- Double-click a local branch to check it out.

### Multi-lane SVG commit graph
- The history table has **Branch / Tag**, **Graph**, **Message**, **Author**, **Date** and **ID** columns.
- Branches, merges and octopus merges are drawn as coloured lanes that stay readable on light and dark themes.
- Lanes are recycled after merges, and lanes that lead to commits outside the visible list end cleanly.
- Filter the history by message, author, hash or ref name.

### Live Git actions
- **Fetch** (all remotes, with prune), **Pull** and **Push** from the toolbar.
- Pushing a branch without an upstream asks before publishing it to `origin`.
- **Create Branch** validates the name as you type.
- Every action shows a progress notification and refreshes the view when it finishes.

### Commit details and file diffs
- Select a commit to see its full message and the list of changed files with **A** (added), **M** (modified), **D** (deleted) and **R** (renamed) badges.
- Click a file to open VS Code's native read-only diff of the parent revision against the commit.

### Git Graph and GitHub integration
- **Open in Git Graph** appears when the [Git Graph](https://marketplace.visualstudio.com/items?itemName=mhutchie.git-graph) extension is installed.
- **Open on GitHub** appears for repositories with a GitHub remote (SSH or HTTPS).
- GitHub sign-in uses VS Code's built-in authentication; the extension never stores credentials.

### Auto-refresh
- A debounced `.git` watcher refreshes the view when HEAD, branches, tags or remote refs change, including changes made in a terminal or another tool.
- Git's temporary `*.lock` files are ignored so the view never reads a half-written ref.

### SHA-1 and SHA-256 repositories
- Both 40-character SHA-1 and 64-character SHA-256 commit hashes are supported.

## Getting started

1. Open a folder that is (or is inside) a Git repository.
2. Click the **Git Repo & Branch Explorer** icon in the Activity Bar, or run **Git Repo & Branch Explorer: Open Repository Window** from the Command Palette.
3. The **Git Repository** tab opens in the editor area and the sidebar collapses to give it the full width.

## Commands

| Command | ID | Description |
|---|---|---|
| Git Repo & Branch Explorer: Open Repository Window | `gitRepoAndBranchExplorer.openRepository` | Opens (or focuses) the Git Repository tab. |
| Git Repo & Branch Explorer: Refresh | `gitRepoAndBranchExplorer.refresh` | Reloads branches, tags and history. |

## Requirements

- VS Code **1.95** or later.
- The **Git CLI** installed and on your `PATH`. The extension runs your own `git` executable, so your credential helpers, SSH keys and Git configuration apply to fetch, pull and push.
- A network connection only for Fetch, Pull, Push and GitHub features.

## Security architecture

- **No shell:** Git runs with an argument array (`shell: false`), never a command string, so commit messages, branch names and file paths cannot be interpreted as shell syntax.
- **Input validation:** branch and ref names are checked against Git's ref-name rules and reject option injection (`--upload-pack=…`, `-c`), `..` traversal, control characters and globs. Commit hashes must be full 40- or 64-character hex strings. File paths in revision specs must be repository-relative with no `..` segments or absolute paths.
- **Non-interactive Git:** `GIT_TERMINAL_PROMPT=0` stops Git from hanging on a hidden password prompt, and `GIT_OPTIONAL_LOCKS=0` keeps read-only refreshes from taking the index lock. Every command has a timeout.
- **Strict webview Content Security Policy:** `default-src 'none'`, scripts only with a per-render cryptographic nonce, no `'unsafe-inline'` or `'unsafe-eval'`, and local resources limited to the extension's own `dist` and webview UI folders.
- **Validated messages:** every message from the webview is checked at runtime (type, payload shape, length limits, prototype-pollution keys) before the extension acts on it. Repository data is rendered with DOM text APIs, never as HTML.
- **Safe external links:** GitHub URLs are rebuilt from a normalized `https://github.com/<owner>/<repo>` remote and a validated hash before being opened.
- **No stored credentials:** GitHub authentication goes through `vscode.authentication`; nothing is written to disk.

## Development

```bash
npm install
npm run compile            # esbuild bundles for the extension host and the webview
npm run typecheck          # tsc --noEmit (strict)
npm test                   # Vitest unit and security tests
npm run test:coverage      # Vitest with V8 coverage (report in coverage/)
npm run test:integration   # VS Code extension-host tests (downloads VS Code on first run)
npm run package            # builds git-repo-and-branch-explorer-<version>.vsix
```

Press <kbd>F5</kbd> with the **Run Extension** launch configuration to debug in an Extension Development Host.

## Known limitations

- The history shows the most recent 500 commits.
- Linked worktrees and submodules, where `.git` is a file rather than a folder, are not auto-refreshed by the watcher; use **Refresh**.

## License

[MIT](LICENSE) © 2026 Peter Judd
