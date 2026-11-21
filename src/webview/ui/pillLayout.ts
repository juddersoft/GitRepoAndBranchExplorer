/** Smallest scale at which the "Checked Out" pill is still legible; below it the pill is hidden. */
export const MIN_READABLE_PILL_SCALE = 0.78;

export interface CheckedOutPillLayoutInput {
  /** Width of the branch row's content box. */
  rowAvailableWidth: number;
  /** Indent, icon and the gaps before the branch label. */
  prefixWidth: number;
  /** Width the branch label needs to show its full text. */
  branchLabelNaturalWidth: number;
  /** Width of the `↑n ↓n` counters plus their gap (0 when absent). */
  trackingWidth: number;
  /** Natural width of the pill at scale 1. */
  pillBaseWidth: number;
  minReadableScale?: number;
}

export interface CheckedOutPillLayout {
  visible: boolean;
  /** 0 when hidden, otherwise within `[minReadableScale, 1]`. */
  scale: number;
}

/**
 * Space is reserved for the branch name first; the pill only gets what is left over. It shrinks
 * proportionally down to the readability threshold and is hidden below that, so it never crowds the name.
 */
export function computeCheckedOutPillLayout(input: CheckedOutPillLayoutInput): CheckedOutPillLayout {
  const { rowAvailableWidth, prefixWidth, branchLabelNaturalWidth, trackingWidth, pillBaseWidth } = input;
  const minReadableScale = Number.isFinite(input.minReadableScale)
    ? Math.min(1, Math.max(0, input.minReadableScale as number))
    : MIN_READABLE_PILL_SCALE;
  if (!Number.isFinite(rowAvailableWidth) || !(rowAvailableWidth > 0)
    || !Number.isFinite(pillBaseWidth) || !(pillBaseWidth > 0)) {
    return { visible: false, scale: 0 };
  }
  const safePrefixWidth = Number.isFinite(prefixWidth) ? Math.max(0, prefixWidth) : 0;
  const safeBranchLabelNaturalWidth = Number.isFinite(branchLabelNaturalWidth) ? Math.max(0, branchLabelNaturalWidth) : 0;
  const safeTrackingWidth = Number.isFinite(trackingWidth) ? Math.max(0, trackingWidth) : 0;
  const remainingForPill = rowAvailableWidth - safePrefixWidth - safeBranchLabelNaturalWidth - safeTrackingWidth;
  if (remainingForPill >= pillBaseWidth) {
    return { visible: true, scale: 1 };
  }
  const scale = remainingForPill / pillBaseWidth;
  if (!(scale >= minReadableScale)) {
    return { visible: false, scale: 0 };
  }
  return { visible: true, scale: Math.min(1, scale) };
}
