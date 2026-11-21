/** Delay that absorbs transient view-visibility flicker while the workbench moves focus around. */
export const AUTO_CLOSE_DELAY_MS = 250;

export interface AutoCloseContext {
  /** The user pinned the tab (the toolbar pin toggle); pinned tabs are never closed automatically. */
  tabPinned: boolean;
  /** The extension is in the middle of opening/revealing the panel itself. */
  panelOpening: boolean;
  /** Visibility changes while the window is unfocused are not a user switching views. */
  windowFocused: boolean;
  /** The Activity Bar launcher view is currently showing, i.e. this extension's container is selected. */
  launcherVisible: boolean;
}

/**
 * VS Code offers no "active view container" event, but our launcher view is hidden exactly when another
 * container (Explorer, Search, ...) is selected or the sidebar is closed. An unpinned panel is tied to that.
 */
export function shouldAutoClosePanel(context: AutoCloseContext): boolean {
  return !context.tabPinned && !context.panelOpening && context.windowFocused && !context.launcherVisible;
}
