import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

// ローカルの登録済み製品だけを診断するCI/端末用入口。
// 対象コードや任意コマンドを、このCLIから実行しない。
const { values } = parseArgs({
  options: {
    product: { type: "string" },
    ref: { type: "string" },
    "request-id": { type: "string" },
    "base-url": { type: "string", default: "http://127.0.0.1:4317" },
    help: { type: "boolean", default: false },
  },
});

async function main() {
  if (values.help) {
    console.log(
      "node scripts/diagnose-product.mjs --product <製品ID> --request-id <CI実行の一意ID> [--ref <コミット/ブランチ>] [--base-url http://127.0.0.1:4317]",
    );
    return;
  }
  if (!/^[a-f0-9-]{36}$/i.test(values.product ?? ""))
    throw new Error("--productには登録済み製品のIDを指定してください");
  if (!values["request-id"]?.trim())
    throw new Error("--request-idにはCI実行ごとの一意なIDが必要です");
  const base = new URL(values["base-url"]);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw new Error("接続先はローカルWorkbenchのHTTPルートURLに限ります");
  const request = async (path, body) => {
    const response = await fetch(new URL(path, base), {
      method: body ? "POST" : "GET",
      headers: {
        "X-Workbench": "1",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  };
  const path = `/api/products/${encodeURIComponent(values.product)}/runs`;
  let run = await request(path, {
    trigger: "ci",
    requestId: values["request-id"],
    ...(values.ref ? { ref: values.ref } : {}),
  });
  const deadline = Date.now() + 120_000;
  while (["queued", "running"].includes(run.status)) {
    if (Date.now() >= deadline)
      throw new Error(
        `診断の待機上限です。実行ID ${run.id} を画面で確認してください`,
      );
    await delay(250);
    run = await request(`${path}/${encodeURIComponent(run.id)}`);
  }
  console.log(
    JSON.stringify(
      {
        productId: run.productId,
        runId: run.id,
        status: run.status,
        commit: run.commit,
        engineVersion: run.engineVersion,
        currentFindings: run.findings.filter(
          (finding) => finding.presentInAnalysis,
        ).length,
        retainedFindings: run.findings.filter(
          (finding) => !finding.presentInAnalysis,
        ).length,
        changes: Object.fromEntries(
          ["new", "continuing", "needs_review", "not_observed"].map((delta) => [
            delta,
            run.findings.filter((finding) => finding.delta === delta).length,
          ]),
        ),
        coverage: run.coverage.map(({ engine, status, assessed }) => ({
          engine,
          status,
          assessed,
        })),
        failure: run.failure,
      },
      null,
      2,
    ),
  );
  // 0は定義した範囲の処理完了であり、安全や修正完了を意味しない。
  process.exitCode =
    run.status === "completed" ? 0 : run.status === "partial" ? 2 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
