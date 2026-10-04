import type { ReactNode } from "react";
import type {
  WorkflowDocument,
  WorkflowSourceRef,
} from "../shared/workflow.js";

export function WorkflowField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="wf-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function SourceReference({
  documents,
  value,
  onChange,
}: {
  documents: WorkflowDocument[];
  value: { docId: string; excerpt: string };
  onChange: (value: { docId: string; excerpt: string }) => void;
}) {
  const { docId, excerpt } = value;
  const selected = documents.find((doc) => doc.id === docId);
  return (
    <div className="wf-reference">
      <WorkflowField label="根拠資料">
        <select
          aria-label="根拠資料"
          value={docId}
          onChange={(event) => {
            const next = documents.find((doc) => doc.id === event.target.value);
            onChange({
              docId: event.target.value,
              excerpt: next?.body.slice(0, 240) ?? "",
            });
          }}
        >
          <option value="">資料を選択</option>
          {documents.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.title} · v{doc.revision} · {doc.classification}
            </option>
          ))}
        </select>
      </WorkflowField>
      <WorkflowField label="原文からの引用">
        <textarea
          aria-label="原文からの引用"
          value={excerpt}
          onChange={(event) =>
            onChange({ ...value, excerpt: event.target.value })
          }
          rows={2}
        />
      </WorkflowField>
      {selected && (
        <small>
          引用は資料の版 v{selected.revision}{" "}
          と照合されます。原文にある文字列をそのまま使ってください。
        </small>
      )}
    </div>
  );
}

export function SourceRefs({
  refs,
  documents,
}: {
  refs: WorkflowSourceRef[];
  documents: WorkflowDocument[];
}) {
  return refs.length ? (
    <ul className="wf-citations">
      {refs.map((ref, index) => {
        const doc = documents.find((item) => item.id === ref.docId);
        return (
          <li key={`${ref.docId}-${ref.revision}-${index}`}>
            <strong>{doc?.title ?? "資料が見つかりません"}</strong> · v
            {ref.revision}: “{ref.excerpt}”
          </li>
        );
      })}
    </ul>
  ) : (
    <p className="wf-muted">根拠資料はまだありません。</p>
  );
}

export function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return <span className={`wf-status ${tone}`}>{children}</span>;
}
