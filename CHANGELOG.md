# Changelog

All notable changes to **Git Repo & Branch Explorer** are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

[1.0.0]: https://github.com/PeterJudd/GitRepoAndBranchExplorer/releases/tag/v1.0.0
