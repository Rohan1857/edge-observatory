import type { QueryResult } from "@qwa/shared";

export function CoverageNotice({ current, comparison }: { current?: QueryResult["meta"]; comparison?: QueryResult["meta"] }) {
  return <>{([["Selected period", current], ["Comparison period", comparison]] as const).map(([label, meta]) =>
    meta?.engine === "sqlite" && meta.partial ? <p role="status" className="empty" key={label}>
      <strong>{label} has incomplete detail.</strong> Complete days start on {meta.retentionFrom} ({meta.timezone}).
      {" "}Missing history is not zero traffic. Archives are not included in this report.
    </p> : null,
  )}</>;
}
