import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QueryResult } from "@qwa/shared";
import { CoverageNotice } from "../src/components/CoverageNotice";

const meta: QueryResult["meta"] = { from: "2026-08-01", to: "2026-10-28", timezone: "Asia/Kolkata", ms: 1, files: 0,
  engine: "sqlite", partial: true, retentionFrom: "2026-09-29" };

describe("report coverage notices", () => {
  it("warns when the current range includes missing event detail", () => {
    const html = renderToStaticMarkup(createElement(CoverageNotice, { current: meta }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Selected period");
    expect(html).toContain("2026-09-29");
    expect(html).toContain("Asia/Kolkata");
    expect(html).toContain("Missing history is not zero traffic");
    expect(html).toContain("Archives are not included");
  });

  it("warns about an incomplete comparison even when the current range is complete", () => {
    const html = renderToStaticMarkup(createElement(CoverageNotice, { current: { ...meta, partial: false }, comparison: meta }));
    expect(html).toContain("Comparison period");
    expect(html).not.toContain("Selected period");
  });

  it("does not warn for complete SQLite reports or archive reports", () => {
    expect(renderToStaticMarkup(createElement(CoverageNotice, { current: { ...meta, partial: false } }))).toBe("");
    expect(renderToStaticMarkup(createElement(CoverageNotice, { current: { ...meta, engine: undefined } }))).toBe("");
  });
});
