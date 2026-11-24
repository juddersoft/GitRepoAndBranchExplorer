# Changelog

All notable changes to **Git Repo & Branch Explorer** are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.5.0] - 2026-11-24

### Added
- Subtle, zero-bloat inline active-line Git blame, an optional Status Bar summary, and the **Toggle Inline Git Blame** command with `blame.enabled`, `blame.ignoreWhitespace`, and `blame.showStatusBar` settings.
- Security-hardened Markdown blame hover cards with closed-loop **Reveal in Commit Timeline**, **Open File Diff**, **Copy Commit Hash**, and **Open on GitHub** actions.
- Visual Studio-style **Toggle File Blame Gutter (Annotate)** command and editor right-click action, including hunk compression and six-level commit-age heat indicators.

### Security
- Bounded per-file LRU and single-flight blame caching stays synchronized with the `.git` watcher and remains gated by VS Code Workspace Trust.

## [1.4.4] - 2026-11-24

### Changed
- Polished the `README.md` presentation with Marketplace/Open VSX-ready screenshots and a concise feature walkthrough.
- Excluded `media/screenshots/**` from the `.vsix` package through `.vscodeignore`, keeping extension packages lightweight.

## [1.4.3] - 2026-11-21

### Changed
- Branch commit counters now default to VS Code's incoming-first `↓ ↑` order, with a persisted repository-menu toggle for Visual Studio's `↑ ↓` order.

## [1.4.2] - 2026-11-21

### Changed
- The sidebar **CHECKED OUT** pill now scales proportionally down to 52% and uses an exact post-layout truncation guard that hides it rather than consuming any branch-name width.

## [1.4.1] - 2026-11-21

### Changed
- The sidebar **CHECKED OUT** badge is now compact (about 70% of its previous size), scales down proportionally as the sidebar narrows, hides itself when it would be too small to read, and never crowds out the branch name. Hide or show it from the repository row's right-click menu; the choice is remembered across sessions.
- The commit history table's column dividers are now draggable (double-click a divider to reset that column), and the column widths are remembered, like Visual Studio's Git Repository history.

## [1.4.0] - 2026-11-21

### Added
- Visual Studio-style Reset from branch, remote, tag and commit context menus, with safe `--mixed` Keep Changes and explicitly confirmed `--hard` Delete Changes modes.
- Merge-commit revert through `git revert -m 1`, with modal confirmation preserving first-parent history.

## [1.3.1] - 2026-11-21

### Security
- Disable extension operation in untrusted workspaces and restrict read-only Git diff content to an allowlist of loaded repository roots.
- Disable Git's `ext::` transport, enforce stdout/stderr size limits, cap revision file reads, and harden the webview Content Security Policy.
- Add an isolated Extension Development Host launch profile that disables other extensions.

## [1.3.0] - 2026-11-21

### Added
- **Repository context menu:** right-click the repository row (or press <kbd>Shift</kbd>+<kbd>F10</kbd> / the Menu key / <kbd>Enter</kbd> on it) for Fetch, Pull, Push/Publish, New Branch… and Refresh, with inapplicable items disabled and explained.
- **Fetch** from that menu fetches only the remotes tracked by local branches (`git fetch --prune -- <remote>`), skips branches with no upstream without failing, keeps going if one remote fails, and reports a summary.
- Explicit **↑n ↓n** commit counts on every local branch (`↑0 ↓0` when up to date; `↑– ↓–` with an explanatory tooltip and screen-reader label when there is no upstream).

### Changed
- The Activity Bar view is named **Git Repo & Branch Explorer** so it no longer truncates to "Rep…" in narrow sidebars.
- A **Repos:** heading now sits above the repository row, and the repository name is no longer repeated as a tree node; local branches are listed directly under **Branches**.
- Pull is refused (menu item disabled, and a warning if requested) when the checked-out branch's upstream no longer exists.

### Fixed
- A branch whose upstream was deleted (`[gone]`) is no longer reported as up to date with zero ahead/behind.

## [1.2.0] - 2026-11-21

### Changed
- **The Activity Bar view is now the branch tree.** The "Open Git Repository Explorer" launcher button is gone: `gitRepoAndBranchExplorer.launcher` renders the Branch / Remote / Tag tree directly in the Primary Side Bar, with single-click inspect, double-click/Enter checkout, the green **Checked Out** styling, the eye isolate toggle and right-click context menus.
- **The editor tab is now the timeline only:** Git toolbar (Fetch, Pull, Push, New Branch, Refresh, Pin Tab), ref toggles, filter, scope/status line, commit graph, history table and commit details. It no longer duplicates the branch tree, so the draggable splitter and collapse button were removed.
- Showing the Activity Bar view opens/reveals the timeline tab at the first tab position without closing the sidebar, so the Activity Bar icon stays highlighted.
- Unpinned tab auto-close now follows the visibility of the sidebar tree view (still debounced, and deferred while the window is unfocused). A pinned tab stays open when other sidebar views are selected.

### Added
- A single extension-host coordinator owns the repository snapshot, Git operations and `.git` watcher. It keeps the selected ref, isolated branches, current branch, branches, remotes, tags and busy status identical in the sidebar and the editor tab, replays them to a view that opens later, and re-validates every synced ref against the loaded snapshot. The sidebar keeps working when the tab is closed.
- `dist/sidebar.js` browser bundle (alongside `dist/webview.js`), loaded with `asWebviewUri`, a nonce and the strict CSP.
- Sidebar header button to reopen the timeline tab.

## [1.1.0] - 2026-11-21

### Added
- **Inspect vs. checked out:** single-click a branch, remote branch or tag to select it and focus the history on commits reachable from it. The checked-out branch keeps its own green accent bar, check icon and **Checked Out** badge. Tags now appear in the branch tree.
- **Context menus** (`--vscode-menu-*` themed, keyboard accessible) for branches, remote branches, tags and commit rows, with inapplicable actions disabled and explained.
- **New Git operations:** merge, rebase, cherry-pick, revert, delete branch (`-d`, with a force `-D` prompt when not fully merged), check out a remote branch as a tracking branch, and create a branch from any ref or commit. All run through the existing progress/busy/refresh pipeline; refs and hashes are validated and Git runs with argument arrays. `git merge` is run with `--no-edit` so it never waits for an editor.
- **Pin Tab** toolbar toggle (persisted). Unpinned, the panel closes when the Activity Bar container is no longer the visible one (for example when Explorer is selected).
- Ref-toggle feedback: filled active state, per-kind counts and a status line for hidden or empty ref kinds, plus a "Showing N of M commits" indicator and clearer empty-history messages.
- Toolbar **Pull** is disabled when the checked-out branch has no upstream, and Pull/Push when HEAD is detached.

### Changed
- Opening the panel moves its tab to the far left of the editor group and keeps the Activity Bar container selected. The launcher no longer collapses the sidebar (that removed the Activity Bar highlight).
- Revealing an existing panel keeps it in its current editor group instead of moving it to the active editor's column.

## [1.0.0] - 2026-11-20

First public release.

### Added
- **Auto-refresh:** a debounced (400 ms) file-system watcher on `.git/HEAD`, `FETCH_HEAD`, `ORIG_HEAD`, `packed-refs` and `refs/**` refreshes the panel when branches, tags or HEAD change outside the extension (terminal, other tools). Transient `*.lock` files are ignored, and events are skipped while a panel-initiated Git action is running.
- **SHA-256 repositories:** commit details, file diffs, "Open on GitHub" and branch creation now accept 64-character SHA-256 commit hashes as well as 40-character SHA-1 hashes. Hashes are validated identically in the webview message validators and `GitService`, and lowercased before reaching Git or GitHub URLs.
- Extension-host integration tests (`npm run test:integration`) that run against an isolated temporary Git repository.
- Marketplace metadata, extension icon, `LICENSE`, `README.md`, this changelog and `.vscodeignore` packaging rules.

### Changed
- Uppercase hex commit hashes from the webview are now accepted (and normalized) instead of being rejected by the message validator.

## [0.5.0]

### Added
- Live **Fetch**, **Pull**, **Push** (with confirmation before publishing a new branch to `origin`), **Create Branch** (with live ref-name validation) and **Checkout** actions, run with progress notifications and followed by an automatic refresh.
- Commit details pane: full commit message plus a clickable list of changed files with `A` / `M` / `D` / `R` status badges.
- Read-only side-by-side diffs (`<hash>^` vs `<hash>`) in VS Code's native diff editor via the `git-repo-explorer-show` content provider.
- **Open in Git Graph** (when `mhutchie.git-graph` or a compatible fork is installed) and **Open on GitHub** / GitHub sign-in via VS Code's built-in authentication.
- The Activity Bar launcher collapses the sidebar automatically for a full-width two-pane layout.

## [0.4.0]

### Added
- Multi-lane SVG commit graph with branch, merge and octopus-merge routing, lane recycling and an 8-colour palette.
- V8 code coverage (`npm run test:coverage`) and an adversarial security test suite.

## [0.3.0]

### Added
- Visual Studio-style UI: filterable branch tree (local branches, remotes, tags), history table with Branch / Tag, Graph, Message, Author, Date and ID columns, and commit selection.

## [0.2.0]

### Added
- Git domain model and parsers for `for-each-ref` and `log` output, a shell-free Git executor with timeouts, ref-name validation and typed webview messages.

## [0.1.0]

### Added
- Initial scaffold: editor-area webview panel, Activity Bar launcher, strict Content Security Policy, esbuild dual-target build and Vitest smoke tests.

[1.0.0]: https://github.com/juddersoft/GitRepoAndBranchExplorer/releases/tag/v1.0.0
