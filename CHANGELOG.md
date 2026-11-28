# Changelog

All notable changes to **Git Repo & Branch Explorer** are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.9.0] - 2026-11-28

### Added
- **Find & Clone Repository:** Added **Git Repo & Branch Explorer: Clone Repository…** (`gitRepoAndBranchExplorer.cloneRepository`) for cloning from a URL or browsing GitHub, GitHub Enterprise (`*.ghe.com` / Server), and Azure DevOps. Clone selection includes organization/repository discovery, destination-folder validation, cancellable progress, and automatic opening of the cloned repository.
- **File-Level Stashing:** Added **Git Repo & Branch Explorer: Stash File…** (`gitRepoAndBranchExplorer.stashFile`) in the Explorer and editor context menus. It supports tracked files, untracked files with `-u`, renamed files, optional commit selection, and staged/unstaged file choices.
- **Tag Management:** Added Create, Push, and Delete actions for tags. Commit context menus create lightweight or annotated tags; pushing uses `refs/tags/<tag>` so remote tag refs are explicit, and deleting a local tag uses a silent QuickPick confirmation that does not affect remote tags.
- **Structured Commit Search:** Filter History now supports `author:` and `hash:` tokens plus debounced `file:` tokens with quoted-phrase support, so commit history can be narrowed by author, commit identifier, or changed file path.
- **Cherry-Pick into Worktree:** Added **Cherry-Pick into Worktree…** for eligible non-merge commits, including commits that are already ancestors of the current branch for backporting. The destination guard refuses dirty worktrees and offers **Open Worktree in New Window** after success or failure.
- **File History & Line History:** Added **Git Repo & Branch Explorer: View File History** and **Git Repo & Branch Explorer: View Line History**. File history uses `git log --follow --name-status`; line history uses `git log -L` for selected lines.
- **Revision Stepping & Multi-Revision Compare:** Added **Compare File with Previous Revision** (`gitRepoAndBranchExplorer.compareWithPreviousRevision`) and **Open Previous File Revision** (`gitRepoAndBranchExplorer.openPreviousRevision`) to editor title and context menus. File history supports Ctrl/Cmd+Click multi-select with unmistakable **OLDER** / **NEWER** badges, descriptive diff tab titles, and pane headers.
- **Compare References:** Added reference comparison with **Compare with Another Reference…**, **Swap**, an ahead/behind summary, Changed Files and Commits tabs, and `BASE <-> TARGET` diff headers for branch/commit comparisons.
- **Commit & File Convenience Actions:** Commit Details now shows inline `+N` / `-N` diff stats, binary diff counts, and totals. Added **Amend Last Commit** with a pushed-HEAD warning, **Create Patch…**, and **Apply Patch…** with `git apply --check` pre-validation.
- **Copy Remote File/Line URL:** Added **Git Repo & Branch Explorer: Copy Remote File/Line URL** (`gitRepoAndBranchExplorer.copyRemoteFileUrl`) to the editor and Explorer context menus for GitHub, GitHub Enterprise Cloud (`*.ghe.com`), Azure DevOps, GitLab, and Bitbucket.
- **Symbol Insights:** Added non-intrusive blame.symbolInsights modes for active-file authorship, with a master enabled toggle and four independently configurable displays: hover, declaration inline ghost text, status bar tooltip, and cache-only CodeLens.

### Improved
- Commit Details and file-diff views are clearer with inline per-file and per-commit diff totals, revision-aware file history, and multi-select comparison affordances.
- Remote file URLs and hosted-browser actions preserve repository/provider context across SSH and HTTPS remotes.
- Cherry-pick and worktree workflows provide direct, post-operation new-window actions without forcing worktree changes.

### Security & Reliability
- Boundary IPC validation now covers the additional clone, stash, tag, history, comparison, patch, amend, worktree, and remote-URL message paths.
- Git ref and option handling reject option-like refs and unsafe revision/file arguments; amend messages reject carriage-return and control-character input.
- Remote file URL generation is HTTPS-only, with defense-in-depth provider and remote normalization for GitHub, GitHub Enterprise Cloud, Azure DevOps, GitLab, and Bitbucket.
- Patch application uses a preflight `git apply --check` before writing or applying changes.
- Symbol Insights use the existing blame cache and produce zero extra `git blame` processes.
- Verified **1,163 passing unit/security tests across 23 suites**, plus the extension-host integration suite.

## [1.8.0] - 2026-11-26

### Added
- **Multi-Repository Workspaces:** Added workspace repository discovery with a **REPOS:** switcher and repository-aware branch, blame, stash, worktree, and remote resolution.
- **Git Worktree Management:** Added a **Worktrees** sidebar section, **WORKTREE** branch badges, a live-destination **Create Worktree** modal, and Open, Remove, and Copy Path actions.
- **Stash Management:** Added a **Stashes** sidebar section, repository and checked-out branch **Stash Changes...** actions, tracked and untracked (`-u`) stashing, selective multi-file stashing, **Inspect Stash** in Commit Details, and Apply, Pop, and quiet Drop actions.
- **GitHub Enterprise Cloud:** Added `.ghe.com` remote detection and browser-link generation for GitHub Enterprise Cloud repositories.

### Changed
- **Pull Request Safety:** **Create Pull Request in Browser** and **Push and Open PR in Browser** now guard against creating pull requests from the repository's default branch.

## [1.7.0] - 2026-11-25

### Added
- **In-Webview Create Branch Modal:** Create branches in a dedicated webview modal with **Checkout** and **Track Remote Branch** checkboxes, smart defaults, and automatic unchecking when branching locally or renaming.
- **Remote Branch and Pull Request Workflows:** Added browser actions for repositories, branches, and commits across GitHub, Azure DevOps, GitLab, and Bitbucket, **Push and Open PR in Browser**, a post-push **Create PR** toast, and persistent **Create Pull Request in Browser** menu entries.
- **Remote Publishing Tools:** Added a guided, four-step GitHub repository publish flow with Personal or Organization ownership, private-first visibility, and URL confirmation, plus **Create Local Bare Remote on Disk** with a folder picker.
- **Branch Management Actions:** Added local branch rename via `git branch -m` and **Untrack Remote Branch** via `git branch --unset-upstream`.

### Changed
- **Dirty-Worktree Branch Checkout:** When checking out a new branch from the same parent, choose **Bring Changes**, **Stash & Switch**, or **Discard & Switch**.
- **Safer Push Recovery:** Renamed branches now offer **Create New Remote Branch**, **Push to Existing Old Remote Branch**, or **Cancel**; untracked local branches automatically create their remote branch when pushed.
- **Clearer Remote Destinations:** Cloud and local-drive remotes now use distinct multi-color local-drive icons, `(local)` badges, and path tooltips, while push QuickPicks show the exact destination.
- **Safer, Less Noisy UI:** Viewport-clamped context menus remain scrollable, silent QuickPick dialogs replace loud Windows modal chimes, and deleting a branch now warns that the action is irreversible.

## [1.6.0] - 2026-11-24

### Added
- **Unlimited History with 500-Commit Chunked Pagination & Virtualized Scrolling:** Switched `git log` from `--topo-order` to `--date-order` so recent commits across parallel branches interleave chronologically, replaced the hard 500-commit limit with append-only 500-commit background pagination, and added `26px` virtualized table rendering that keeps SVG graph lanes seamless at 60fps.
- **Deep "Reveal in Commit Timeline" from Git Blame:** Commits outside the initial 500-commit window are revealed by paging older commits, up to 10 pages, before scrolling to and highlighting the row; even older commits fall back directly to the Commit Details drawer.
- **Visual Studio-Style Hierarchical Branch Folders:** Local and remote branches are grouped into collapsible `/`-delimited folder trees with folder-first alphabetical sorting, indent guides, persisted expansion state, checked-out ancestor auto-expansion, filter-aware expansion, and a persisted **Show/Hide Folder Branch Counts** repository-menu toggle.
- **Multi-Color TreeView Icons:** Replaced monochrome treeview line icons with layered, multi-color SVG illustrations for classic tan folders and peeking page tabs, a layered sky-blue remote cloud, and two-tone branch, checked-out, tag, and repository icons.
- **Direct "Open File" in Commit Details:** Added an inline **Open File** button beside each changed file name to open the working-tree file without a side-by-side diff, with a read-only commit-revision fallback for deleted or missing files.

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
