import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { SourceRefs } from "../src/client/workflow-fields.js";

test("根拠が空、または資料が見つからない場合を説明する", () => {
  const empty = renderToStaticMarkup(
    createElement(SourceRefs, { refs: [], documents: [] }),
  );
  expect(empty).toContain("根拠資料はまだありません。");

  const orphaned = renderToStaticMarkup(
    createElement(SourceRefs, {
      refs: [{ docId: "deleted-document", revision: 2, excerpt: "引用" }],
      documents: [],
    }),
  );
  expect(orphaned).toContain("資料が見つかりません");
  expect(orphaned).toContain("v2");
});
