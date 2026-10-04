import { useEffect, useState } from "react";
import { request as apiRequest } from "./api.js";
import {
  diagnosticApiPaths,
  type DiagnosticRepository,
  type DiagnosticRun,
  type Product,
  type ProductRunSummary,
} from "../shared/product-diagnostics.js";
import "./product-diagnostics-page.css";

type ProductDetail = { product: Product; runs: ProductRunSummary[] };

function diagnosticRequest<T>(path: string, body?: unknown) {
  return apiRequest<T>(path.startsWith("/api/") ? path.slice(4) : path, body);
}

const statusLabel: Record<DiagnosticRun["status"], string> = {
  queued: "開始待ち",
  running: "診断中",
  completed: "診断完了",
  partial: "一部未診断",
  failed: "失敗",
  stopped: "停止",
  interrupted: "中断",
};

const progressLabel: Record<DiagnosticRun["progress"]["phase"], string> = {
  queued: "実行待ち",
  snapshot: "対象版を固定",
  static: "コードを確認",
  dependency: "依存関係を照合",
  linking: "前回の結果と比較",
  saving: "結果を保存",
  finished: "診断結果を確認",
};

const deltaLabel: Record<DiagnosticRun["findings"][number]["delta"], string> = {
  new: "新しい指摘候補",
  continuing: "継続中の指摘",
  needs_review: "条件変更・再確認",
  not_observed: "今回未検出・要確認",
};

const severityLabel = { high: "高", medium: "中", low: "低" } as const;
const activeStatuses = new Set<DiagnosticRun["status"]>(["queued", "running"]);
const resumableStatuses = new Set<DiagnosticRun["status"]>([
  "partial",
  "stopped",
  "interrupted",
]);

function dateLabel(value: string | null | undefined) {
  if (!value) return "未記録";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "日時不明"
    : date.toLocaleString("ja-JP");
}

function nextScheduleLabel(product: Product, interval: string) {
  const minutes = Number(interval);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 43_200)
    return "有効な実行間隔を入力してください";
  const anchor = product.latestRun?.startedAt ?? product.updatedAt;
  const timestamp = Date.parse(anchor);
  if (!Number.isFinite(timestamp)) return "次回の目安を計算できません";
  return dateLabel(new Date(timestamp + minutes * 60_000).toISOString());
}

function shortCommit(value: string | null) {
  return value ? value.slice(0, 12) : "対象版の固定前";
}

function SummaryCounts({ run }: { run: ProductRunSummary }) {
  return (
    <dl className="diagnostic-counts" aria-label="前回との差分件数">
      <div>
        <dt>新規</dt>
        <dd>{run.findingCounts.new}</dd>
      </div>
      <div>
        <dt>継続</dt>
        <dd>{run.findingCounts.continuing}</dd>
      </div>
      <div>
        <dt>再確認</dt>
        <dd>{run.findingCounts.needsReview}</dd>
      </div>
      <div>
        <dt>今回未検出</dt>
        <dd>{run.findingCounts.notObserved}</dd>
      </div>
    </dl>
  );
}

export function ProductDiagnosticsPage({
  onOpenWorkflow,
}: {
  onOpenWorkflow: (projectId: string, question?: string) => void;
}) {
  const [repositories, setRepositories] = useState<DiagnosticRepository[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [detail, setDetail] = useState<ProductDetail>();
  const [selectedRunId, setSelectedRunId] = useState("");
  const [run, setRun] = useState<DiagnosticRun>();
  const [loading, setLoading] = useState(true);
  const [initialLoadFailed, setInitialLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [ref, setRef] = useState("");
  const [specification, setSpecification] = useState("");
  const [allowDependencyNetwork, setAllowDependencyNetwork] = useState(false);
  const [createSchedule, setCreateSchedule] = useState(false);
  const [createInterval, setCreateInterval] = useState("1440");
  const [settingsRef, setSettingsRef] = useState("");
  const [settingsSpecification, setSettingsSpecification] = useState("");
  const [settingsAllowNetwork, setSettingsAllowNetwork] = useState(false);
  const [settingsSchedule, setSettingsSchedule] = useState(false);
  const [settingsInterval, setSettingsInterval] = useState("1440");
  const [runRef, setRunRef] = useState("");

  const loadProducts = async (preferId = productId) => {
    const next = await diagnosticRequest<Product[]>(
      diagnosticApiPaths.products,
    );
    setProducts(next);
    const selected = next.some((item) => item.id === preferId)
      ? preferId
      : (next[0]?.id ?? "");
    setProductId(selected);
    if (!selected) setDetail(undefined);
  };

  useEffect(() => {
    let current = true;
    setLoading(true);
    Promise.all([
      diagnosticRequest<DiagnosticRepository[]>(
        diagnosticApiPaths.repositories,
      ),
      diagnosticRequest<Product[]>(diagnosticApiPaths.products),
    ])
      .then(([repoList, productList]) => {
        if (!current) return;
        setRepositories(repoList);
        setProducts(productList);
        setRepositoryId(repoList[0]?.id ?? "");
        setRef(repoList[0]?.defaultRef ?? "");
        setProductId(productList[0]?.id ?? "");
        setShowCreate(productList.length === 0 && repoList.length > 0);
      })
      .catch((cause: unknown) => {
        if (current) {
          setInitialLoadFailed(true);
          setError(
            cause instanceof Error
              ? cause.message
              : "製品の診断情報を読み込めませんでした。",
          );
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!productId) return;
    let current = true;
    diagnosticRequest<ProductDetail>(diagnosticApiPaths.product(productId))
      .then((next) => {
        if (!current) return;
        setDetail(next);
        setProducts((items) =>
          items.map((item) =>
            item.id === next.product.id ? next.product : item,
          ),
        );
        setSettingsRef(next.product.ref);
        setSettingsSpecification(next.product.specification);
        setSettingsAllowNetwork(next.product.allowDependencyNetwork);
        setSettingsSchedule(next.product.schedule.enabled);
        setSettingsInterval(
          String(next.product.schedule.intervalMinutes ?? 1440),
        );
        setRunRef(next.product.ref);
        setSelectedRunId((existing) =>
          next.runs.some((item) => item.id === existing)
            ? existing
            : (next.runs[0]?.id ?? ""),
        );
      })
      .catch((cause: unknown) => {
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : "製品の最新状態を読み込めませんでした。",
          );
      });
    return () => {
      current = false;
    };
  }, [productId]);

  useEffect(() => {
    if (!productId || !detail?.product.latestRun) return;
    if (!activeStatuses.has(detail.product.latestRun.status)) return;
    const timer = window.setInterval(() => {
      void diagnosticRequest<ProductDetail>(
        diagnosticApiPaths.product(productId),
      )
        .then((next) => {
          setDetail(next);
          setProducts((items) =>
            items.map((item) =>
              item.id === next.product.id ? next.product : item,
            ),
          );
        })
        .catch((cause: unknown) =>
          setError(
            cause instanceof Error
              ? `診断の進行状況を更新できません。再読込してください。${cause.message}`
              : "診断の進行状況を更新できません。再読込してください。",
          ),
        );
    }, 1800);
    return () => window.clearInterval(timer);
  }, [
    productId,
    detail?.product.latestRun?.id,
    detail?.product.latestRun?.status,
  ]);

  useEffect(() => {
    if (!productId || !selectedRunId) {
      setRun(undefined);
      return;
    }
    let current = true;
    const readRun = () =>
      diagnosticRequest<DiagnosticRun>(
        diagnosticApiPaths.run(productId, selectedRunId),
      )
        .then((next) => {
          if (current) setRun(next);
        })
        .catch((cause: unknown) => {
          if (current)
            setError(
              cause instanceof Error
                ? cause.message
                : "診断結果を読み込めません。",
            );
        });
    void readRun();
    const timer = window.setInterval(() => {
      if (run && activeStatuses.has(run.status)) void readRun();
    }, 1800);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [productId, selectedRunId, run?.status]);

  const operate = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "操作に失敗しました。";
      setError(
        /revision|版が古|再読込/u.test(message)
          ? `${message}\n製品設定の版が更新されている場合は「最新状態を再読込」してから、内容を確認して保存してください。`
          : message,
      );
    } finally {
      setBusy(false);
    }
  };

  const createProduct = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await operate(async () => {
      const created = await diagnosticRequest<Product>(
        diagnosticApiPaths.products,
        {
          title,
          repositoryId,
          ref,
          specification,
          allowDependencyNetwork,
          schedule: {
            enabled: createSchedule,
            intervalMinutes: createSchedule ? Number(createInterval) : null,
          },
        },
      );
      setProducts((current) => [created, ...current]);
      setProductId(created.id);
      setSelectedRunId("");
      setTitle("");
      setSpecification("");
      setShowCreate(false);
      setNotice("製品と知識管理用の案件を作成しました。");
    });
  };

  const saveSettings = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!detail) return;
    await operate(async () => {
      const updated = await diagnosticRequest<Product>(
        diagnosticApiPaths.settings(detail.product.id),
        {
          revision: detail.product.revision,
          ref: settingsRef,
          specification: settingsSpecification,
          allowDependencyNetwork: settingsAllowNetwork,
          schedule: {
            enabled: settingsSchedule,
            intervalMinutes: settingsSchedule ? Number(settingsInterval) : null,
          },
        },
      );
      setDetail((current) =>
        current ? { ...current, product: updated } : current,
      );
      setProducts((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setNotice("製品設定を保存しました。");
    });
  };

  const startRun = async () => {
    if (!detail) return;
    await operate(async () => {
      const created = await diagnosticRequest<DiagnosticRun>(
        diagnosticApiPaths.runs(detail.product.id),
        {
          trigger: "manual",
          ...(runRef.trim() ? { ref: runRef.trim() } : {}),
        },
      );
      setSelectedRunId(created.id);
      setRun(created);
      await loadProducts(detail.product.id);
      const fresh = await diagnosticRequest<ProductDetail>(
        diagnosticApiPaths.product(detail.product.id),
      );
      setDetail(fresh);
      setNotice("診断を開始しました。対象版と各工程の状態を表示しています。");
    });
  };

  const runAction = async (action: "stop" | "resume") => {
    if (!detail || !run) return;
    await operate(async () => {
      const path =
        action === "stop"
          ? diagnosticApiPaths.stop(detail.product.id, run.id)
          : diagnosticApiPaths.resume(detail.product.id, run.id);
      const updated = await diagnosticRequest<DiagnosticRun>(path, {});
      setRun(updated);
      setNotice(
        action === "stop" ? "診断を停止しました。" : "診断を再開しました。",
      );
      const fresh = await diagnosticRequest<ProductDetail>(
        diagnosticApiPaths.product(detail.product.id),
      );
      setDetail(fresh);
    });
  };

  const reloadSelectedProduct = async () => {
    if (!productId) return;
    await operate(async () => {
      const [nextProducts, nextDetail] = await Promise.all([
        diagnosticRequest<Product[]>(diagnosticApiPaths.products),
        diagnosticRequest<ProductDetail>(diagnosticApiPaths.product(productId)),
      ]);
      setProducts(nextProducts);
      setDetail(nextDetail);
      setSettingsRef(nextDetail.product.ref);
      setSettingsSpecification(nextDetail.product.specification);
      setSettingsAllowNetwork(nextDetail.product.allowDependencyNetwork);
      setSettingsSchedule(nextDetail.product.schedule.enabled);
      setSettingsInterval(
        String(nextDetail.product.schedule.intervalMinutes ?? 1440),
      );
      setRunRef(nextDetail.product.ref);
      setSelectedRunId(nextDetail.runs[0]?.id ?? "");
      setNotice("最新の製品設定と診断履歴を読み込みました。");
    });
  };

  const selectedRepository = repositories.find(
    (item) => item.id === repositoryId,
  );
  const createDisabled = busy || repositories.length === 0 || !ref.trim();

  return (
    <section
      className="product-diagnostics"
      aria-labelledby="product-diagnostics-title"
    >
      <header className="diagnostics-hero">
        <p className="eyebrow">継続診断 · このPCで管理する製品</p>
        <div className="diagnostics-hero-copy">
          <div>
            <h1 id="product-diagnostics-title">製品の診断状況</h1>
            <p>
              管理下のコードを版ごとに診断し、前回との差分、人の確認、修正後の再評価をつなぎます。
              診断で指摘が見つからないことは、安全性の保証ではありません。
            </p>
          </div>
          <button
            className="primary"
            disabled={busy || repositories.length === 0}
            onClick={() => setShowCreate((value) => !value)}
          >
            {showCreate ? "登録フォームを閉じる" : "製品を登録する"}
          </button>
        </div>
      </header>

      {error && (
        <div className="alert" role="alert">
          <strong>更新できませんでした</strong>
          <p>{error}</p>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {loading && (
        <p role="status">登録済みの製品と診断状況を読み込んでいます…</p>
      )}

      {!loading && initialLoadFailed && (
        <div className="diagnostics-empty" role="status">
          <h2>診断情報を読み込めませんでした</h2>
          <p>
            ネットワーク状態を確認してから再読み込みしてください。製品を登録できるか判断できていません。
          </p>
          <button onClick={() => window.location.reload()}>
            もう一度読み込む
          </button>
        </div>
      )}
      {!loading && !initialLoadFailed && repositories.length === 0 && (
        <div className="diagnostics-empty" role="status">
          <h2>診断対象のリポジトリが設定されていません</h2>
          <p>
            このPCで診断を許可したリポジトリが登録されると、製品を作成できます。画面から任意のパスを指定することはできません。
          </p>
        </div>
      )}

      {showCreate && repositories.length > 0 && !initialLoadFailed && (
        <form
          className="panel diagnostics-create"
          onSubmit={(event) => void createProduct(event)}
        >
          <div className="section-head">
            <div>
              <span className="eyebrow">初回登録</span>
              <h2>診断する製品を登録</h2>
            </div>
            <p className="muted">OSS採用調査を経由せずに開始できます。</p>
          </div>
          <label className="field">
            <span>製品名</span>
            <input
              required
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="grid2">
            <label className="field">
              <span>管理下のリポジトリ</span>
              <select
                aria-label="管理下のリポジトリ"
                required
                value={repositoryId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setRepositoryId(nextId);
                  setRef(
                    repositories.find((item) => item.id === nextId)
                      ?.defaultRef ?? "",
                  );
                }}
              >
                {repositories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>対象の版・Git ref</span>
              <input
                aria-label="初回診断の対象版"
                required
                maxLength={250}
                value={ref}
                onChange={(event) => setRef(event.target.value)}
              />
            </label>
          </div>
          {selectedRepository?.defaultRef && (
            <p className="muted">初期値: {selectedRepository.defaultRef}</p>
          )}
          <label className="field">
            <span>製品の用途・仕様</span>
            <textarea
              required
              maxLength={20_000}
              value={specification}
              onChange={(event) => setSpecification(event.target.value)}
              placeholder="何を提供する製品か、診断時に考慮する仕様や境界を記載"
            />
          </label>
          <label className="diagnostics-check">
            <input
              type="checkbox"
              checked={allowDependencyNetwork}
              onChange={(event) =>
                setAllowDependencyNetwork(event.target.checked)
              }
            />
            <span>
              <b>依存関係の公開情報照合を許可する</b>
              <small>
                許可した場合もOSVへ送るのは公開npm依存名と版だけです。未許可の間は依存関係を外部照合せず、その範囲を未確認として表示します。
              </small>
            </span>
          </label>
          <ScheduleEditor
            enabled={createSchedule}
            interval={createInterval}
            onEnabled={setCreateSchedule}
            onInterval={setCreateInterval}
          />
          <div className="actions">
            <button className="primary" type="submit" disabled={createDisabled}>
              製品と知識案件を作成
            </button>
            {repositories.length === 0 && (
              <span className="muted">利用できるリポジトリがありません。</span>
            )}
          </div>
        </form>
      )}

      {!loading && !initialLoadFailed && products.length > 0 && (
        <div className="diagnostics-layout">
          <nav className="product-list" aria-label="登録済み製品">
            <h2>登録済み製品</h2>
            {products.map((item) => (
              <button
                key={item.id}
                className={item.id === productId ? "selected" : ""}
                onClick={() => {
                  setProductId(item.id);
                  setSelectedRunId("");
                  setRun(undefined);
                  setError("");
                }}
              >
                <b>{item.title}</b>
                <small>
                  {item.latestRun
                    ? `${statusLabel[item.latestRun.status]} · ${shortCommit(item.latestRun.commit)}`
                    : "未診断"}
                </small>
              </button>
            ))}
          </nav>
          <div className="diagnostics-detail">
            {detail && (
              <>
                <header className="diagnostics-product-head">
                  <div>
                    <p className="eyebrow">製品診断</p>
                    <h2>{detail.product.title}</h2>
                    <p className="muted">
                      {repositories.find(
                        (item) => item.id === detail.product.repositoryId,
                      )?.name ?? detail.product.repositoryId}{" "}
                      · 製品設定 revision {detail.product.revision} · 診断条件
                      revision {detail.product.diagnosticRevision}
                    </p>
                  </div>
                  <div className="actions">
                    <button
                      disabled={busy}
                      onClick={() => void reloadSelectedProduct()}
                    >
                      最新状態を再読込
                    </button>
                    <button
                      onClick={() =>
                        onOpenWorkflow(detail.product.linkedProjectId)
                      }
                    >
                      知識・判断・修正へ
                    </button>
                  </div>
                </header>

                <section
                  className="panel diagnostics-run-start"
                  aria-labelledby="diagnostics-run-title"
                >
                  <div className="section-head">
                    <div>
                      <h3 id="diagnostics-run-title">次の診断</h3>
                      <p className="muted">
                        実行前に対象版を固定します。ソース全文は返さず、指摘箇所の抜粋とファイル情報を表示します。
                      </p>
                    </div>
                  </div>
                  <div className="diagnostics-run-form">
                    <label className="field">
                      <span>対象の版・Git ref</span>
                      <input
                        aria-label="次の診断の対象版"
                        required
                        value={runRef}
                        onChange={(event) => setRunRef(event.target.value)}
                      />
                    </label>
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        !runRef.trim() ||
                        (detail.product.latestRun !== null &&
                          activeStatuses.has(detail.product.latestRun.status))
                      }
                      onClick={() => void startRun()}
                    >
                      {detail.product.latestRun &&
                      activeStatuses.has(detail.product.latestRun.status)
                        ? "診断実行中"
                        : "この版を診断する"}
                    </button>
                  </div>
                  {detail.product.latestRun && (
                    <SummaryCounts run={detail.product.latestRun} />
                  )}
                </section>

                {detail.product.latestRun === null && (
                  <div className="diagnostics-empty" role="status">
                    <h3>まだ診断していません</h3>
                    <p>
                      対象版を指定して診断を開始してください。結果がない状態は問題なしを意味しません。
                    </p>
                  </div>
                )}

                {run && selectedRunId && (
                  <RunView
                    run={run}
                    busy={busy}
                    onStop={() => void runAction("stop")}
                    onResume={() => void runAction("resume")}
                    onOpenWorkflow={onOpenWorkflow}
                    projectId={detail.product.linkedProjectId}
                  />
                )}

                <details className="diagnostics-history" open>
                  <summary>診断履歴（{detail.runs.length}件）</summary>
                  {detail.runs.length === 0 ? (
                    <p className="muted">診断履歴はありません。</p>
                  ) : (
                    <ol>
                      {detail.runs.map((item) => (
                        <li key={item.id}>
                          <button
                            className={
                              item.id === selectedRunId ? "active" : ""
                            }
                            onClick={() => setSelectedRunId(item.id)}
                          >
                            <span>
                              {dateLabel(item.startedAt)} ·{" "}
                              {statusLabel[item.status]}
                            </span>
                            <small>
                              {item.trigger === "manual"
                                ? "手動"
                                : item.trigger === "ci"
                                  ? "CI"
                                  : "定期実行"}{" "}
                              · {shortCommit(item.commit)}
                            </small>
                            <small>{item.progress.message}</small>
                            {item.incompleteCoverage && (
                              <small>未診断範囲あり</small>
                            )}
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </details>

                <details className="diagnostics-settings">
                  <summary>製品の対象・診断設定</summary>
                  <form onSubmit={(event) => void saveSettings(event)}>
                    <label className="field">
                      <span>次回の対象版・Git ref</span>
                      <input
                        aria-label="次回診断の対象版設定"
                        required
                        value={settingsRef}
                        onChange={(event) => setSettingsRef(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>用途・仕様</span>
                      <textarea
                        required
                        value={settingsSpecification}
                        onChange={(event) =>
                          setSettingsSpecification(event.target.value)
                        }
                      />
                    </label>
                    <label className="diagnostics-check">
                      <input
                        type="checkbox"
                        checked={settingsAllowNetwork}
                        onChange={(event) =>
                          setSettingsAllowNetwork(event.target.checked)
                        }
                      />
                      <span>
                        <b>依存関係の公開情報照合を許可</b>
                        <small>
                          OSVへ送る情報は公開npm依存名と版に限ります。
                        </small>
                      </span>
                    </label>
                    <ScheduleEditor
                      enabled={settingsSchedule}
                      interval={settingsInterval}
                      onEnabled={setSettingsSchedule}
                      onInterval={setSettingsInterval}
                    />
                    {settingsSchedule && (
                      <p className="muted" role="note">
                        次回の目安:{" "}
                        {nextScheduleLabel(detail.product, settingsInterval)}
                        <br />
                        サーバー起動中に約1分ごとに確認します。前回診断時刻（未診断なら製品更新時刻）を起点にした目安です。
                      </p>
                    )}
                    <button type="submit" disabled={busy}>
                      設定を保存する
                    </button>
                    <small className="muted">
                      同時編集で版が古くなった場合は保存を拒否します。最新状態を再読み込みしてから再度保存してください。
                    </small>
                  </form>
                </details>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function ScheduleEditor({
  enabled,
  interval,
  onEnabled,
  onInterval,
}: {
  enabled: boolean;
  interval: string;
  onEnabled: (value: boolean) => void;
  onInterval: (value: string) => void;
}) {
  return (
    <fieldset className="diagnostics-schedule">
      <legend>定期診断（任意）</legend>
      <label className="diagnostics-check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabled(event.target.checked)}
        />
        <span>
          <b>定期実行を有効にする</b>
          <small>有効にすると設定した間隔で診断を開始します。</small>
        </span>
      </label>
      {enabled && (
        <label className="field">
          <span>実行間隔（5〜43200分）</span>
          <input
            type="number"
            min={5}
            max={43_200}
            required
            value={interval}
            onChange={(event) => onInterval(event.target.value)}
          />
        </label>
      )}
    </fieldset>
  );
}

function RunView({
  run,
  busy,
  onStop,
  onResume,
  onOpenWorkflow,
  projectId,
}: {
  run: DiagnosticRun;
  busy: boolean;
  onStop: () => void;
  onResume: () => void;
  onOpenWorkflow: (projectId: string, question?: string) => void;
  projectId: string;
}) {
  const active = activeStatuses.has(run.status);
  return (
    <section className="panel diagnostic-run" aria-label="診断結果">
      <header className="section-head">
        <div>
          <span className={`diagnostic-status diagnostic-status-${run.status}`}>
            {statusLabel[run.status]}
          </span>
          <h3>{run.progress.message || progressLabel[run.progress.phase]}</h3>
        </div>
        {active && (
          <button disabled={busy} onClick={onStop}>
            診断を停止
          </button>
        )}
        {resumableStatuses.has(run.status) && (
          <button disabled={busy} onClick={onResume}>
            診断を再開
          </button>
        )}
      </header>
      <dl className="diagnostic-metadata">
        <div>
          <dt>対象コミット</dt>
          <dd>{shortCommit(run.commit)}</dd>
        </div>
        <div>
          <dt>開始時刻</dt>
          <dd>{dateLabel(run.startedAt)}</dd>
        </div>
        <div>
          <dt>前回実行</dt>
          <dd>{run.previousRunId ? run.previousRunId.slice(0, 8) : "初回"}</dd>
        </div>
        <div>
          <dt>解析ルール</dt>
          <dd>{run.engineVersion}</dd>
        </div>
        <div>
          <dt>仕様 revision</dt>
          <dd>{run.specificationRevision}</dd>
        </div>
        <div>
          <dt>判定基準 revision</dt>
          <dd>{run.workflowRevision}</dd>
        </div>
        <div>
          <dt>入力manifest</dt>
          <dd>{run.manifestHash ? run.manifestHash.slice(0, 16) : "未固定"}</dd>
        </div>
        <div>
          <dt>工程</dt>
          <dd>{progressLabel[run.progress.phase]}</dd>
        </div>
        <div>
          <dt>依存関係の外部照合</dt>
          <dd>
            {run.allowDependencyNetwork
              ? "公開npm依存名・版のみOSV送信を許可"
              : "OSV送信未許可・依存関係は未照合"}
          </dd>
        </div>
      </dl>
      {run.failure && (
        <p className="alert" role="alert">
          診断に失敗しました: {run.failure}
        </p>
      )}
      {active && (
        <p className="diagnostic-progress" role="status">
          {run.progress.message ||
            `${progressLabel[run.progress.phase]}しています…`}
        </p>
      )}

      <div className="diagnostic-coverage">
        <h4>解析できた範囲と未診断</h4>
        {run.coverage.map((coverage) => (
          <article key={coverage.engine}>
            <h5>
              {coverage.engine === "static" ? "製品コード" : "npm依存関係"} ·{" "}
              {coverage.status === "complete"
                ? "指定範囲を解析"
                : coverage.status === "partial"
                  ? "一部のみ解析"
                  : coverage.status === "unavailable"
                    ? "照合できず"
                    : "未対応"}
            </h5>
            <p>
              解析対象 {coverage.assessed}件 / 対象外・未処理{" "}
              {coverage.omitted.length}件
            </p>
            {coverage.engine === "dependency" &&
              coverage.status !== "complete" && (
                <p>
                  依存関係の外部照合が許可されていない場合、この範囲は未確認です。
                </p>
              )}
            {coverage.limitations.map((limitation) => (
              <p key={limitation}>{limitation}</p>
            ))}
            {coverage.omitted.length > 0 && (
              <ul>
                {coverage.omitted.map((item) => (
                  <li key={`${item.path}:${item.reason}`}>
                    <code>{item.path}</code> — {item.reason}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>

      <section
        className="diagnostic-findings"
        aria-label="診断で見つかった項目"
      >
        <h4>診断で確認する項目（{run.findings.length}件）</h4>
        {run.findings.length === 0 ? (
          <p className="muted">
            この実行では指摘候補を取得していません。解析範囲と未診断項目を確認してください。結果は安全性の保証ではありません。
          </p>
        ) : (
          run.findings.map((finding) => (
            <article
              className="diagnostic-finding"
              key={`${finding.fingerprint}:${finding.delta}`}
            >
              <header>
                <span className={`delta delta-${finding.delta}`}>
                  {deltaLabel[finding.delta]}
                </span>
                <span className={`severity severity-${finding.severity}`}>
                  重要度 {severityLabel[finding.severity]}
                </span>
                <small>{finding.ruleId}</small>
              </header>
              <h5>{finding.title}</h5>
              <p className="diagnostic-location">
                <code>
                  {finding.path}:{finding.line}
                </code>{" "}
                · {finding.engine === "static" ? "コード解析" : "依存関係"}
              </p>
              <p>{finding.evidence}</p>
              <p>
                <b>確認・修正案:</b> {finding.remediation}
              </p>
              {finding.advisoryUrl && (
                <p>
                  <a
                    href={finding.advisoryUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    公開アドバイザリを確認 ↗
                  </a>
                </p>
              )}
              {finding.delta === "not_observed" && (
                <p className="diagnostic-caution">
                  {!finding.presentInAnalysis &&
                    "前回の指摘記録を比較用に保持しています。 "}
                  今回見つからなかった状態です。修正版であることや解決済みであることを自動確定しません。対象版の確認と人の判定が必要です。
                </p>
              )}
              <div className="actions">
                <button onClick={() => onOpenWorkflow(projectId)}>
                  {finding.workflowFindingId
                    ? "案件の判定・修正記録を開く"
                    : "製品の知識・判定を開く"}
                </button>
                <button
                  onClick={() =>
                    onOpenWorkflow(projectId, finding.workflowQuestion)
                  }
                >
                  根拠付きの質問を手動で確認する
                </button>
              </div>
            </article>
          ))
        )}
      </section>

      <details className="diagnostic-technical-details">
        <summary>診断の固定情報と知識版</summary>
        <dl className="diagnostic-metadata">
          <div>
            <dt>実行ID</dt>
            <dd>
              <code>{run.id}</code>
            </dd>
          </div>
          <div>
            <dt>対象版</dt>
            <dd>{run.ref}</dd>
          </div>
          <div>
            <dt>成果manifest SHA256</dt>
            <dd>
              <code>{run.manifestHash ?? "未固定"}</code>
            </dd>
          </div>
          <div>
            <dt>開始契機</dt>
            <dd>
              {run.trigger === "manual"
                ? "手動"
                : run.trigger === "ci"
                  ? "CI"
                  : "定期実行"}
            </dd>
          </div>
          <div>
            <dt>request ID</dt>
            <dd>{run.requestId ?? "手動実行"}</dd>
          </div>
        </dl>
        <h4>使用した承認済み知識</h4>
        {run.knowledge.length === 0 ? (
          <p className="muted">この実行で参照した知識はありません。</p>
        ) : (
          <ul>
            {run.knowledge.map((item) => (
              <li key={`${item.id}:${item.revision}`}>
                {item.id} · revision {item.revision} ·{" "}
                {item.contentHash.slice(0, 16)}
              </li>
            ))}
          </ul>
        )}
        <h4>使用した判定基準</h4>
        {run.rules.length === 0 ? (
          <p className="muted">この実行で参照した判定基準はありません。</p>
        ) : (
          <ul>
            {run.rules.map((item) => (
              <li key={`${item.id}:${item.revision}`}>
                {item.id} · revision {item.revision} ·{" "}
                {item.contentHash.slice(0, 16)}
              </li>
            ))}
          </ul>
        )}
        <h4>固定したソースの版とハッシュ</h4>
        {run.snapshotFiles.length === 0 ? (
          <p className="muted">ソース一覧はまだ固定されていません。</p>
        ) : (
          <ul>
            {run.snapshotFiles.map((item) => (
              <li key={item.path}>
                <code>{item.path}</code> · SHA256 <code>{item.hash}</code>
              </li>
            ))}
          </ul>
        )}
        {run.snapshotOmitted.length > 0 && (
          <>
            <h4>固定時に読み取らなかった範囲</h4>
            <ul>
              {run.snapshotOmitted.map((item) => (
                <li key={`${item.path}:${item.reason}`}>
                  <code>{item.path}</code> — {item.reason}
                </li>
              ))}
            </ul>
          </>
        )}
        <h4>実行状態の履歴</h4>
        <ol>
          {run.statusHistory.map((item) => (
            <li key={`${item.status}:${item.at}`}>
              {statusLabel[item.status]} · {dateLabel(item.at)}
              {item.reason ? ` — ${item.reason}` : ""}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
