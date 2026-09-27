// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure math for collapsing/expanding a pane within its parent in the layout tree.
//
// Layout node sizes are relative weights, not percentages: a child's rendered share is
// size / sum(sibling sizes). All math here conserves the total weight of the siblings so
// the collapsed pane ends up at an exact fraction of the parent, and stores the pane's
// previous share as a fraction (0..1) of the total so expand restores the same share.

export type CollapseSibling = {
    id: string;
    size: number;
    // true if this sibling is itself collapsed (its size is frozen)
    collapsed?: boolean;
};

export type ResizeOp = { nodeId: string; size: number };

// Fraction of the parent used for a collapsed pane when the pixel size is unknown.
export const DEFAULT_COLLAPSED_FRACTION = 0.05;
// Never let a collapsed pane go below this fraction of the parent, or above the max.
export const MIN_COLLAPSED_FRACTION = 0.01;
export const MAX_COLLAPSED_FRACTION = 0.5;

/**
 * Fraction of the parent that a collapsed pane should occupy so it is exactly `pixelsWanted` tall.
 * `parentPixels` is the parent's size along the split axis. Falls back to DEFAULT_COLLAPSED_FRACTION.
 */
export function computeCollapsedFraction(pixelsWanted: number, parentPixels: number): number {
    if (!(pixelsWanted > 0) || !(parentPixels > 0)) {
        return DEFAULT_COLLAPSED_FRACTION;
    }
    const frac = pixelsWanted / parentPixels;
    return Math.min(MAX_COLLAPSED_FRACTION, Math.max(MIN_COLLAPSED_FRACTION, frac));
}

function sumSizes(nodes: CollapseSibling[]): number {
    return nodes.reduce((acc, n) => acc + (n.size > 0 ? n.size : 0), 0);
}

/**
 * Give `delta` weight (positive = grow, negative = shrink) to the expandable siblings,
 * proportionally to their current sizes (equally if they are all zero).
 */
function distribute(expandable: CollapseSibling[], delta: number): ResizeOp[] {
    const expandableTotal = sumSizes(expandable);
    return expandable.map((sib) => {
        const ratio = expandableTotal > 0 ? sib.size / expandableTotal : 1 / expandable.length;
        return { nodeId: sib.id, size: sib.size + ratio * delta };
    });
}

/**
 * Collapse `targetId` down to `collapsedFraction` of the siblings' total weight.
 * Freed weight goes to the non-collapsed siblings in proportion to their sizes.
 * Returns null if nothing can absorb the freed space (every other sibling is collapsed).
 */
export function computeCollapse(
    siblings: CollapseSibling[],
    targetId: string,
    collapsedFraction: number
): { ops: ResizeOp[]; prevFraction: number } | null {
    const target = siblings.find((s) => s.id === targetId);
    if (!target) return null;
    const others = siblings.filter((s) => s.id !== targetId);
    const expandable = others.filter((s) => !s.collapsed);
    if (expandable.length === 0) return null;
    const total = sumSizes(siblings);
    if (!(total > 0)) return null;

    const prevFraction = target.size / total;
    const collapsedSize = Math.min(target.size, collapsedFraction * total);
    const freed = target.size - collapsedSize;
    const ops: ResizeOp[] = [{ nodeId: target.id, size: collapsedSize }];
    for (const sib of others) {
        if (sib.collapsed) ops.push({ nodeId: sib.id, size: sib.size });
    }
    ops.push(...distribute(expandable, freed));
    return { ops, prevFraction };
}

/**
 * Normalize a stored frame:prevsize into a fraction of the parent.
 * New values are fractions in (0, 1); legacy values were stored as percentages (1..100).
 */
export function normalizePrevFraction(saved: number): number | null {
    if (typeof saved !== "number" || !(saved > 0)) return null;
    const frac = saved < 1 ? saved : saved / 100;
    if (!(frac > 0) || frac >= 1) return null;
    return frac;
}

/**
 * Expand `targetId` back to `savedPrevSize` (a fraction of the total; see normalizePrevFraction),
 * or to a fair share (1/n) if nothing valid was saved. The needed weight is taken from the
 * non-collapsed siblings in proportion to their sizes; collapsed siblings stay frozen.
 */
export function computeExpand(
    siblings: CollapseSibling[],
    targetId: string,
    savedPrevSize: number,
    collapsedFraction: number
): ResizeOp[] | null {
    const target = siblings.find((s) => s.id === targetId);
    if (!target) return null;
    const others = siblings.filter((s) => s.id !== targetId);
    const frozen = others.filter((s) => s.collapsed);
    const expandable = others.filter((s) => !s.collapsed);
    const total = sumSizes(siblings);
    if (!(total > 0)) return null;

    const ops: ResizeOp[] = [];
    for (const sib of frozen) ops.push({ nodeId: sib.id, size: sib.size });

    if (expandable.length === 0) {
        // Every other sibling is collapsed: fill everything they don't occupy.
        const frozenTotal = sumSizes(frozen);
        const fillFraction = Math.max(collapsedFraction, 1 - frozen.length * collapsedFraction);
        const size = frozenTotal > 0 ? (frozenTotal * fillFraction) / (1 - fillFraction) : total;
        ops.unshift({ nodeId: target.id, size });
        return ops;
    }

    let fraction = normalizePrevFraction(savedPrevSize);
    if (fraction == null || fraction * total <= target.size) {
        fraction = 1 / siblings.length;
    }
    let restoreSize = Math.max(target.size, fraction * total);
    // Leave every expandable sibling at least a collapsed pane's worth of room.
    const expandableTotal = sumSizes(expandable);
    const maxTake = Math.max(0, expandableTotal - expandable.length * collapsedFraction * total);
    restoreSize = Math.min(restoreSize, target.size + maxTake);
    ops.unshift({ nodeId: target.id, size: restoreSize });
    ops.push(...distribute(expandable, -(restoreSize - target.size)));
    return ops;
}
