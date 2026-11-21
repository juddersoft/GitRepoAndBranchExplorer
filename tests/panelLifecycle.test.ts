import { describe, expect, it } from 'vitest';
import { shouldAutoClosePanel } from '../src/webview/panelLifecycle';

const base = { tabPinned: false, panelOpening: false, windowFocused: true, launcherVisible: false };

describe('shouldAutoClosePanel', () => {
  it('closes an unpinned panel once the launcher (our view container) is no longer visible', () => {
    expect(shouldAutoClosePanel(base)).toBe(true);
  });

  it('keeps a pinned panel open', () => {
    expect(shouldAutoClosePanel({ ...base, tabPinned: true })).toBe(false);
  });

  it('keeps the panel while our own container is visible', () => {
    expect(shouldAutoClosePanel({ ...base, launcherVisible: true })).toBe(false);
  });

  it('ignores visibility changes caused by the extension opening the panel', () => {
    expect(shouldAutoClosePanel({ ...base, panelOpening: true })).toBe(false);
  });

  it('ignores visibility changes while the window is unfocused', () => {
    expect(shouldAutoClosePanel({ ...base, windowFocused: false })).toBe(false);
  });
});
