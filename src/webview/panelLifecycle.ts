/** Delay that absorbs transient view-visibility flicker while the workbench moves focus around. */
export const AUTO_CLOSE_DELAY_MS = 250;

export interface AutoCloseContext {
  /** The user pinned the tab (the toolbar pin toggle); pinned tabs are never closed automatically. */
  tabPinned: boolean;
  /** The extension is in the middle of opening/revealing the panel itself. */
  panelOpening: boolean;
  /** Visibility changes while the window is unfocused are not a user switching views. */
  windowFocused: boolean;
  /** The Activity Bar branch-tree view is currently showing, i.e. this extension's container is selected. */
  sidebarVisible: boolean;
}

/**
 * VS Code offers no "active view container" event, but our sidebar view is hidden exactly when another
 * container (Explorer, Search, Source Control, ...) is selected or the sidebar is closed. An unpinned
 * editor tab is tied to that.
 */
export function shouldAutoClosePanel(context: AutoCloseContext): boolean {
  return !context.tabPinned && !context.panelOpening && context.windowFocused && !context.sidebarVisible;
}

export type AutoCloseDecision = 'close' | 'defer' | 'keep';

/**
 * What the debounce timer should do when it fires: a hidden sidebar seen while the window is unfocused is
 * deferred (re-evaluated when focus returns) instead of dropped, so the close is not lost.
 */
export function decideAutoClose(context: AutoCloseContext): AutoCloseDecision {
  if (context.tabPinned || context.panelOpening || context.sidebarVisible) {
    return 'keep';
  }
  return context.windowFocused ? 'close' : 'defer';
}
