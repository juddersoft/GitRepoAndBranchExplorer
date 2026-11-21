import { describe, expect, it } from 'vitest';
import { decideAutoClose, shouldAutoClosePanel } from '../src/webview/panelLifecycle';

const base = { tabPinned: false, panelOpening: false, windowFocused: true, sidebarVisible: false };

describe('shouldAutoClosePanel', () => {
  it('closes an unpinned panel once the sidebar view (our view container) is no longer visible', () => {
    expect(shouldAutoClosePanel(base)).toBe(true);
  });

  it('keeps a pinned panel open when another sidebar view is selected', () => {
    expect(shouldAutoClosePanel({ ...base, tabPinned: true })).toBe(false);
  });

  it('keeps the panel while our own container is visible', () => {
    expect(shouldAutoClosePanel({ ...base, sidebarVisible: true })).toBe(false);
  });

  it('ignores visibility changes caused by the extension opening the panel', () => {
    expect(shouldAutoClosePanel({ ...base, panelOpening: true })).toBe(false);
  });

  it('ignores visibility changes while the window is unfocused', () => {
    expect(shouldAutoClosePanel({ ...base, windowFocused: false })).toBe(false);
  });
});

describe('decideAutoClose', () => {
  it('closes an unpinned panel whose sidebar is hidden while the window is focused', () => {
    expect(decideAutoClose(base)).toBe('close');
  });

  it('defers instead of dropping the close while the window is unfocused', () => {
    expect(decideAutoClose({ ...base, windowFocused: false })).toBe('defer');
  });

  it.each([
    ['pinned', { tabPinned: true }],
    ['sidebar visible', { sidebarVisible: true }],
    ['panel opening', { panelOpening: true }],
  ])('keeps the panel when %s, focused or not', (_name, override) => {
    expect(decideAutoClose({ ...base, ...override })).toBe('keep');
    expect(decideAutoClose({ ...base, ...override, windowFocused: false })).toBe('keep');
  });

  it('agrees with shouldAutoClosePanel whenever the window is focused', () => {
    for (const tabPinned of [false, true]) {
      for (const panelOpening of [false, true]) {
        for (const sidebarVisible of [false, true]) {
          const context = { tabPinned, panelOpening, windowFocused: true, sidebarVisible };
          expect(decideAutoClose(context) === 'close').toBe(shouldAutoClosePanel(context));
        }
      }
    }
  });
});
