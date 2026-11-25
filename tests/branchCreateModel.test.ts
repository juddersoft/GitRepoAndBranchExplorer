import { describe, expect, it } from 'vitest';
import {
  createInitialBranchFormState,
  extractShortRemoteBranchName,
  setBranchFormCheckout,
  setBranchFormTrack,
  updateBranchFormName,
  validateCreateBranchForm,
} from '../src/webview/ui/branchCreateModel';
import type { CreateBranchDialogRequest } from '../src/webview/ui/branchCreateModel';

const request = (overrides: Partial<CreateBranchDialogRequest> = {}): CreateBranchDialogRequest => ({
  sourceKind: 'remote',
  startPoint: 'refs/remotes/origin/feature/pdj/foo',
  startLabel: 'origin/feature/pdj/foo',
  initialName: 'feature/pdj/foo',
  remoteTrackingRef: 'origin/feature/pdj/foo',
  existingLocalBranches: [],
  ...overrides,
});

describe('create branch form model', () => {
  it('extracts the short name from full and short remote refs', () => {
    expect(extractShortRemoteBranchName('refs/remotes/origin/feature/pdj/foo')).toBe('feature/pdj/foo');
    expect(extractShortRemoteBranchName('origin/main', 'origin')).toBe('main');
    expect(extractShortRemoteBranchName('upstream/release/1')).toBe('release/1');
  });

  it('defaults remote creation to checkout and track, and local creation to no tracking', () => {
    expect(createInitialBranchFormState(request())).toMatchObject({
      branchName: 'feature/pdj/foo',
      checkout: true,
      track: true,
      canTrack: true,
    });
    expect(createInitialBranchFormState(request({
      sourceKind: 'local',
      startPoint: 'refs/heads/main',
      initialName: 'main',
      remoteTrackingRef: undefined,
    }))).toMatchObject({ track: false, canTrack: false });
  });

  it('auto-unchecks tracking after editing, while allowing it to be manually restored', () => {
    const initial = createInitialBranchFormState(request());
    const edited = updateBranchFormName(initial, 'feature/renamed');
    expect(edited.track).toBe(false);
    expect(setBranchFormTrack(edited, true).track).toBe(true);
    expect(setBranchFormTrack({ ...edited, canTrack: false }, true).track).toBe(false);
  });

  it('updates checkout independently from tracking', () => {
    expect(setBranchFormCheckout(createInitialBranchFormState(request()), false).checkout).toBe(false);
  });

  it.each(['', '   ', 'bad name', 'bad\u00a0name', 'a..b', 'a@{b', 'a~1', 'a^1', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a.lock', '.bad', 'bad.', '/bad', 'bad/', 'a//b', '@'])(
    'rejects invalid name %j',
    (branchName) => {
      const state = createInitialBranchFormState(request({ initialName: branchName }));
      expect(validateCreateBranchForm(state, [])).not.toBeNull();
    },
  );

  it('reports duplicates after trimming and accepts a valid unique ref', () => {
    const duplicate = { ...createInitialBranchFormState(request({ initialName: ' feature/x ' })) };
    expect(validateCreateBranchForm(duplicate, ['feature/x'])).toBe('Branch "feature/x" already exists.');
    const valid = createInitialBranchFormState(request({ initialName: 'feature/new' }));
    expect(validateCreateBranchForm(valid, ['feature/other'])).toBeNull();
  });
});
