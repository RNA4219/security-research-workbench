import { useState } from "react";
import Markdown from "react-markdown";
import type {
  CandidateInput,
  Project,
  ProjectInput,
  Requirement,
  RequirementInput,
  Source,
  SourceInput,
} from "../shared/model.js";

import { ClaimChoice } from "./provenance.js";

import { blankSource, labels } from "./constants.js";
export function Field({
  label,
  value,
  onChange,
  area = false,
  type = "text",
  required = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  area?: boolean;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {area ? (
        <textarea
          aria-label={label}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
        />
      ) : (
        <input
          aria-label={label}
          type={type}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
export function SourcesChoice({
  sources,
  selected,
  onChange,
}: {
  sources: Source[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <fieldset className="choices">
      <legend>出典資料</legend>
      {sources.length === 0 && (
        <p className="muted">資料を登録すると選択できます。</p>
      )}
      {sources.map((s) => (
        <label key={s.id}>
          <input
            type="checkbox"
            checked={selected.includes(s.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, s.id]
                  : selected.filter((id) => id !== s.id),
              )
            }
          />
          <span>
            {s.title} <small>v{s.version}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
export function ProjectForm({
  value,
  onSubmit,
  button = "作成する",
}: {
  value: ProjectInput;
  onSubmit: (v: ProjectInput) => void;
  button?: string;
}) {
  const [v, set] = useState(value);
  const change = (key: keyof ProjectInput) => (value: string) =>
    set({ ...v, [key]: value });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
    >
      <Field
        label="プロジェクト名"
        value={v.title}
        onChange={change("title")}
      />
      <Field
        label="目的"
        area
        value={v.objective}
        onChange={change("objective")}
      />
      <Field
        label="対象利用者"
        value={v.audience}
        onChange={change("audience")}
      />
      <Field
        label="対象範囲"
        area
        required={false}
        value={v.scope ?? ""}
        onChange={change("scope")}
      />
      <Field
        label="対象外"
        area
        required={false}
        value={v.outOfScope ?? ""}
        onChange={change("outOfScope")}
      />
      <Field
        label="制約・対象外"
        area
        required={false}
        value={v.constraints}
        onChange={change("constraints")}
      />
      <button className="primary">{button}</button>
    </form>
  );
}
export function SourceEditor({
  source,
  onSubmit,
  onClose,
  onBundle,
}: {
  source?: Source;
  onSubmit: (v: SourceInput) => void;
  onClose: () => void;
  onBundle: (raw: string) => void;
}) {
  const [v, set] = useState<SourceInput>(
    source
      ? {
          title: source.title,
          url: source.url,
          version: source.version,
          retrievedAt: source.retrievedAt,
          body: source.body,
        }
      : blankSource(),
  );
  const [error, setError] = useState("");
  const change = (key: keyof SourceInput) => (value: string) =>
    set({ ...v, [key]: value });
  return (
    <section className="panel">
      <div className="section-head">
        <h2>{source ? "資料を更新" : "資料を取り込む"}</h2>
        <button onClick={onClose}>閉じる</button>
      </div>
      <label className="upload">
        Markdown・テキスト・資料JSONを選択
        <input
          type="file"
          accept=".md,.txt,.json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 1_500_000) {
              setError("ファイルは1.5MB以下にしてください");
              return;
            }
            const raw = await f.text();
            if (f.name.endsWith(".json")) onBundle(raw);
            else set({ ...v, title: v.title || f.name, body: raw });
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(v);
        }}
      >
        <div className="grid2">
          <Field label="資料名" value={v.title} onChange={change("title")} />
          <Field
            label="出典URL"
            type="url"
            value={v.url}
            onChange={change("url")}
          />
          <Field
            label="資料の版"
            value={v.version}
            onChange={change("version")}
          />
          <Field
            label="取得日時（UTC）"
            value={v.retrievedAt}
            onChange={change("retrievedAt")}
          />
        </div>
        <Field label="資料本文" area value={v.body} onChange={change("body")} />
        <button className="primary">資料を保存</button>
      </form>
    </section>
  );
}
export function CandidateEditor({
  value,
  sources,
  onSubmit,
  onClose,
}: {
  value: CandidateInput;
  sources: Source[];
  onSubmit: (v: CandidateInput) => void;
  onClose: () => void;
}) {
  const [v, set] = useState(value);
  const change = (key: keyof CandidateInput) => (value: string) =>
    set({ ...v, [key]: value });
  return (
    <section className="panel">
      <div className="section-head">
        <h2>OSS候補を編集</h2>
        <button onClick={onClose}>閉じる</button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(v);
        }}
      >
        <div className="grid2">
          <Field label="OSS名" value={v.name} onChange={change("name")} />
          <Field
            label="リポジトリURL"
            type="url"
            value={v.url}
            onChange={change("url")}
          />
          <Field
            label="機能"
            area
            value={v.features}
            onChange={change("features")}
          />
          <Field
            label="ライセンス"
            value={v.license}
            onChange={change("license")}
          />
          <Field
            label="保守状況・確認日"
            area
            value={v.maintenance}
            onChange={change("maintenance")}
          />
          <Field
            label="採否理由"
            area
            value={v.rationale}
            onChange={change("rationale")}
          />
        </div>
        <label className="field">
          <span>採否</span>
          <select
            aria-label="採否"
            value={v.decision}
            onChange={(e) =>
              set({
                ...v,
                decision: e.target.value as CandidateInput["decision"],
              })
            }
          >
            {(["consider", "adopt", "reject"] as const).map((s) => (
              <option key={s} value={s}>
                {labels[s]}
              </option>
            ))}
          </select>
        </label>
        <SourcesChoice
          sources={sources}
          selected={v.sourceIds}
          onChange={(sourceIds) => set({ ...v, sourceIds })}
        />
        <button className="primary">候補を保存</button>
      </form>
    </section>
  );
}
export function RequirementEditor({
  requirement,
  sources,
  project,
  onSave,
  onClose,
}: {
  requirement: Requirement;
  sources: Source[];
  project: Project;
  onSave: (r: RequirementInput) => void;
  onClose: () => void;
}) {
  const { status: _, sourceVersions: __, ...input } = requirement;
  const [v, set] = useState(input);
  return (
    <section className="panel">
      <div className="section-head">
        <h2>{v.id} を編集</h2>
        <button onClick={onClose}>閉じる</button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(v);
        }}
      >
        <Field
          label="要件名"
          value={v.title}
          onChange={(title) => set({ ...v, title })}
        />
        <Field
          label="要件の説明"
          area
          value={v.description}
          onChange={(description) => set({ ...v, description })}
        />
        <label className="field">
          <span>優先度</span>
          <select
            aria-label="優先度"
            value={v.priority}
            onChange={(e) =>
              set({
                ...v,
                priority: e.target.value as RequirementInput["priority"],
              })
            }
          >
            {["low", "medium", "high", "critical"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <ClaimChoice
          p={project}
          selected={v.claimIds}
          onChange={(claimIds) => set({ ...v, claimIds, sourceIds: [] })}
        />
        <Field
          label="利用者判断・補足理由"
          area
          required={false}
          value={v.rationale}
          onChange={(rationale) => set({ ...v, rationale })}
        />
        <Field
          label="受入条件（1行に1件）"
          area
          value={v.acceptance.join("\n")}
          onChange={(acceptance) =>
            set({ ...v, acceptance: acceptance.split("\n") })
          }
        />
        <Field
          label="実装タスク（1行に1件）"
          area
          value={v.tasks.join("\n")}
          onChange={(tasks) => set({ ...v, tasks: tasks.split("\n") })}
        />
        <button className="primary">要件を保存</button>
        <p className="muted">編集すると未レビューに戻ります。</p>
      </form>
    </section>
  );
}
export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown
        skipHtml
        components={{
          img: () => null,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
