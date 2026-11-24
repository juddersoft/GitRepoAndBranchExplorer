# Git Repo & Branch Explorer

A Visual Studio-unified **Git Repository** window, natively for VS Code, Cursor, Windsurf, and VSCodium.

![Git Repo & Branch Explorer overview](https://raw.githubusercontent.com/juddersoft/GitRepoAndBranchExplorer/main/media/screenshots/hero-overview.png)

## Key Highlights

- Native Activity Bar sidebar plus a far-left, synchronized editor timeline.
- Multi-lane SVG commit graph with draggable, persisted column widths.
- Responsive **CHECKED OUT** pill that never obscures branch names.
- Customizable VS Code `↓ ↑` / Visual Studio `↑ ↓` tracking counters.
- Safe Reset `--mixed` / `--hard` modes and Merge-Commit Revert `-m 1`.
- Read-only commit inspection and trust-gated side-by-side `vscode.diff` views.
- Git Graph and GitHub integration.

## Feature Walkthrough

### Context menus

![Contextual Git actions](https://raw.githubusercontent.com/juddersoft/GitRepoAndBranchExplorer/main/media/screenshots/context-menus.png)

Contextual Git actions include Merge-Commit Revert `-m 1` and guarded Reset `--mixed` / `--hard`.

### Commit details and diffs

![Commit details and changed files](https://raw.githubusercontent.com/juddersoft/GitRepoAndBranchExplorer/main/media/screenshots/commit-details-diff.png)

Commit Details and the Changed Files drawer support trust-gated side-by-side `vscode.diff` inspection.

### Repository menu options

![Repository menu customization](https://raw.githubusercontent.com/juddersoft/GitRepoAndBranchExplorer/main/media/screenshots/repo-menu-options.png)

Customize the **CHECKED OUT** pill and switch counters between VS Code `↓ ↑` or Visual Studio `↑ ↓`.

## Quick Install

- **VS Code Marketplace:** [Install Git Repo & Branch Explorer](https://marketplace.visualstudio.com/items?itemName=juddersoft.git-repo-and-branch-explorer)
- **Open VSX:** [Install Git Repo & Branch Explorer](https://open-vsx.org/extension/juddersoft/git-repo-and-branch-explorer)

## Security & Workspace Trust

Extension Git actions run only in trusted workspaces, with `protocol.ext.allow=never`. Git uses argument arrays with zero shell interpolation, and the extension collects zero telemetry.

## Features

### Branch, remote and tag tree in the Activity Bar
- Local branches, `remotes/<name>` groups and tags in one filterable tree, shown directly in the Primary Side Bar. A **Repos:** heading sits above the repository row (`<repo> (<branch>)`), and local branches are listed directly under **Branches**.
- Selecting a ref, isolating branches (eye button) and the busy status of Git operations are mirrored between the sidebar tree and the editor timeline.
- The **checked-out** branch is unmistakable: green accent bar, check icon, bold name and a compact **Checked Out** badge. The badge shrinks as the sidebar narrows, disappears when it would be unreadable, and can be turned off from the repository row's right-click menu (**Hide "Checked Out" Badge**).
- Every local branch shows explicit **↓ (commits to pull) / ↑ (commits to push)** counts in VS Code's default order, `↓0 ↑0` when up to date. The repository row's right-click menu can persistently switch to Visual Studio's `↑ ↓` order. A branch with no upstream shows dashes, and a deleted upstream retains the warning tooltip instead of claiming it is up to date.
- **Single-click** any branch, remote branch or tag to *inspect* it: it is highlighted with the list-selection colours and the history table, breadcrumb and "Showing N of M commits" indicator focus on the commits reachable from it. **Clear filter** returns to the full history.
- **Double-click** (or press <kbd>Enter</kbd> on) a non-current local branch to check it out. The eye button still isolates several branches at once.
- **Right-click** a branch, remote branch, tag or commit for a context menu (<kbd>Shift</kbd>+<kbd>F10</kbd> / the Menu key work too). Inapplicable actions are disabled and say why.

### Context menus and Git operations
- Repository (right-click the repository row, or focus it and press <kbd>Shift</kbd>+<kbd>F10</kbd> / <kbd>Enter</kbd>): **Fetch**, Pull, Push/Publish, New Branch…, Refresh. Fetch only contacts remotes that at least one local branch tracks (with prune); local branches without an upstream are skipped without failing, and a summary reports what was fetched and skipped.
- Local branch: Check Out, Merge into current, Rebase current onto this, Pull, Push/Publish, Fetch, Create Branch from Here, Show Only This Branch, Delete Branch (with a force-delete prompt when Git says it is not fully merged).
- Remote branch: Check Out as Local Tracking Branch, Merge, Rebase, Create Branch from Here.
- Tag: Create Branch from Here, Merge, Rebase.
- Commit: Copy Commit Hash, Create Branch from Here, Cherry-Pick, Revert, Open in Git Graph, Open on GitHub.
- Merge, Rebase and Delete are disabled for the checked-out branch or a detached HEAD; Pull is disabled without an upstream or for a branch that is not checked out; Cherry-Pick is disabled for commits already in the current history; merge commits cannot be cherry-picked or reverted from the view.
- Rebase and Delete ask for confirmation. If a merge, rebase, cherry-pick or revert stops on conflicts, the error message tells you to resolve them in the Source Control view or abort in a terminal.

### Multi-lane SVG commit graph
- The history table has **Branch / Tag**, **Graph**, **Message**, **Author**, **Date** and **ID** columns. Drag any column divider to resize it (double-click a divider to reset that column); widths are remembered.
- Branches, merges and octopus merges are drawn as coloured lanes that stay readable on light and dark themes.
- Lanes are recycled after merges, and lanes that lead to commits outside the visible list end cleanly.
- Filter the history by message, author, hash or ref name.
- The **Local Branches**, **Remote Branches** and **Tags** toggles control which ref labels appear in the Branch / Tag column. Active toggles are filled with the button colour and show how many refs of that kind exist; a status line explains what is hidden or missing ("Hiding tags (3)", "No tags in this repository"). Toggles hide labels only, never commits.

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
3. The branch, remote and tag tree appears in the sidebar and the **Git Repository** timeline tab opens in the editor area, moved to the far left of its group. The Git Repo & Branch Explorer icon stays highlighted in the Activity Bar.
4. By default the tab closes when you switch to another sidebar view (Explorer, Search, Source Control, ...) or hide the sidebar. Click **Pin Tab** in the toolbar to keep it open; the choice is remembered. If you close the tab yourself, the **Open history timeline** button in the sidebar header brings it back.

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

[MIT](LICENSE) © 2026 JudderSoft
