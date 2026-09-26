import { describe, expect, it } from "vitest";
import {
    CollapseSibling,
    computeCollapse,
    computeCollapsedFraction,
    computeExpand,
    DEFAULT_COLLAPSED_FRACTION,
    normalizePrevFraction,
    ResizeOp,
} from "./collapsemath";

function apply(siblings: CollapseSibling[], ops: ResizeOp[], collapsedIds: string[] = []): CollapseSibling[] {
    return siblings.map((s) => ({
        id: s.id,
        size: ops.find((op) => op.nodeId === s.id)?.size ?? s.size,
        collapsed: collapsedIds.includes(s.id),
    }));
}

function shares(siblings: CollapseSibling[]): number[] {
    const total = siblings.reduce((acc, s) => acc + s.size, 0);
    return siblings.map((s) => s.size / total);
}

function total(siblings: CollapseSibling[]): number {
    return siblings.reduce((acc, s) => acc + s.size, 0);
}

describe("computeCollapsedFraction", () => {
    it("converts header pixels to a fraction of the parent", () => {
        expect(computeCollapsedFraction(50, 1000)).toBeCloseTo(0.05);
        expect(computeCollapsedFraction(30, 600)).toBeCloseTo(0.05);
    });
    it("falls back when the parent size is unknown", () => {
        expect(computeCollapsedFraction(50, 0)).toBe(DEFAULT_COLLAPSED_FRACTION);
        expect(computeCollapsedFraction(50, undefined)).toBe(DEFAULT_COLLAPSED_FRACTION);
    });
});

describe("collapse/expand", () => {
    const frac = 0.05;

    it("3 equal panes: collapse keeps others equal and expand restores equal shares", () => {
        const start: CollapseSibling[] = [
            { id: "a", size: 10 },
            { id: "b", size: 10 },
            { id: "c", size: 10 },
        ];
        const res = computeCollapse(start, "a", frac);
        expect(res).not.toBeNull();
        expect(res.prevFraction).toBeCloseTo(1 / 3);
        const collapsed = apply(start, res.ops, ["a"]);
        expect(total(collapsed)).toBeCloseTo(30);
        const s = shares(collapsed);
        expect(s[0]).toBeCloseTo(frac);
        expect(s[1]).toBeCloseTo(s[2]);
        expect(s[1]).toBeCloseTo((1 - frac) / 2);

        const ops = computeExpand(collapsed, "a", res.prevFraction, frac);
        const expanded = apply(collapsed, ops);
        for (const share of shares(expanded)) expect(share).toBeCloseTo(1 / 3);
    });

    it("2 panes", () => {
        const start: CollapseSibling[] = [
            { id: "a", size: 10 },
            { id: "b", size: 10 },
        ];
        const res = computeCollapse(start, "b", frac);
        const collapsed = apply(start, res.ops, ["b"]);
        expect(shares(collapsed)[1]).toBeCloseTo(frac);
        expect(shares(collapsed)[0]).toBeCloseTo(1 - frac);
        const expanded = apply(collapsed, computeExpand(collapsed, "b", res.prevFraction, frac));
        expect(shares(expanded)[0]).toBeCloseTo(0.5);
        expect(shares(expanded)[1]).toBeCloseTo(0.5);
    });

    it("unequal sizes: freed space is split proportionally and restored exactly", () => {
        const start: CollapseSibling[] = [
            { id: "a", size: 20 },
            { id: "b", size: 10 },
            { id: "c", size: 30 },
        ];
        const res = computeCollapse(start, "b", frac);
        expect(res.prevFraction).toBeCloseTo(10 / 60);
        const collapsed = apply(start, res.ops, ["b"]);
        const s = shares(collapsed);
        expect(s[1]).toBeCloseTo(frac);
        expect(s[2] / s[0]).toBeCloseTo(30 / 20);
        const expanded = apply(collapsed, computeExpand(collapsed, "b", res.prevFraction, frac));
        const e = shares(expanded);
        expect(e[0]).toBeCloseTo(20 / 60);
        expect(e[1]).toBeCloseTo(10 / 60);
        expect(e[2]).toBeCloseTo(30 / 60);
    });

    it("collapsing the last pane gives space to earlier panes", () => {
        const start: CollapseSibling[] = [
            { id: "a", size: 10 },
            { id: "b", size: 10 },
            { id: "c", size: 10 },
        ];
        const res = computeCollapse(start, "c", frac);
        const collapsed = apply(start, res.ops, ["c"]);
        const s = shares(collapsed);
        expect(s[2]).toBeCloseTo(frac);
        expect(s[0]).toBeCloseTo(s[1]);
        const expanded = apply(collapsed, computeExpand(collapsed, "c", res.prevFraction, frac));
        for (const share of shares(expanded)) expect(share).toBeCloseTo(1 / 3);
    });

    it("already-collapsed siblings stay frozen", () => {
        const start: CollapseSibling[] = [
            { id: "a", size: 1.5, collapsed: true },
            { id: "b", size: 14.25 },
            { id: "c", size: 14.25 },
        ];
        const res = computeCollapse(start, "b", frac);
        expect(res.ops.find((op) => op.nodeId === "a").size).toBe(1.5);
        const collapsed = apply(start, res.ops, ["a", "b"]);
        expect(shares(collapsed)[1]).toBeCloseTo(frac);
    });

    it("refuses to collapse when every other sibling is collapsed", () => {
        const start: CollapseSibling[] = [
            { id: "a", size: 1, collapsed: true },
            { id: "b", size: 19 },
        ];
        expect(computeCollapse(start, "b", frac)).toBeNull();
    });

    it("falls back to a fair share when nothing was saved", () => {
        const start: CollapseSibling[] = [
            { id: "a", size: 1.5, collapsed: true },
            { id: "b", size: 14.25 },
            { id: "c", size: 14.25 },
        ];
        const expanded = apply(start, computeExpand(start, "a", undefined, frac));
        for (const share of shares(expanded)) expect(share).toBeCloseTo(1 / 3);
    });
});

describe("normalizePrevFraction", () => {
    it("accepts fractions and legacy percentages", () => {
        expect(normalizePrevFraction(0.25)).toBe(0.25);
        expect(normalizePrevFraction(50)).toBe(0.5);
        expect(normalizePrevFraction(0)).toBeNull();
        expect(normalizePrevFraction(150)).toBeNull();
        expect(normalizePrevFraction(undefined)).toBeNull();
    });
});
