import { useState } from "react";

const scenes = [
  {
    label: "初回診断",
    version: "v1.0",
    open: 1,
    added: 1,
    knowledge: 0,
    status: "新規の指摘 · 人の確認待ち",
    comparison: "比較する前回の診断はありません。",
    finding:
      "外部サービスとの通信で、証明書の検証を無効にする設定が見つかった想定です。",
    action:
      "この設定が製品のどの通信で使われるか、担当者が仕様と照らして確認します。",
    evidence: "サンプルのコード位置: src/integrations/catalog-client.ts:24",
    learning: "承認済みの知識はまだありません。",
  },
  {
    label: "更新後の比較",
    version: "v1.1",
    open: 1,
    added: 0,
    knowledge: 0,
    status: "継続中 · 対応が必要",
    comparison: "v1.0と比較。同じ指摘が残り、新しい指摘はない想定です。",
    finding: "行番号が変わっても、同じ指摘として前回の判断と結び付けます。",
    action:
      "「商品カタログとの通信で使うため修正が必要」という担当者の判断を引き継ぎます。",
    evidence: "サンプルのコード位置: src/integrations/catalog-client.ts:27",
    learning: "調査メモは下書きです。まだ次回の診断には使いません。",
  },
  {
    label: "修正後の再評価",
    version: "v1.2",
    open: 1,
    added: 0,
    knowledge: 0,
    status: "今回未検出 · 修正確認待ち",
    comparison:
      "v1.1と比較。対象ファイルを解析し、以前の指摘が観測されなくなった想定です。",
    finding:
      "証明書を検証する設定へ修正した想定です。指摘が消えても、自動で修正完了にはしません。",
    action:
      "担当者が修正差分と通常の通信テストを確認します。確認が終わるまで未解決として扱います。",
    evidence: "サンプルの証跡: 修正差分・再評価結果・通常の通信テスト記録",
    learning: "修正時に分かった製品の注意点を、承認待ちの知識として残します。",
  },
  {
    label: "人の確認・知識承認",
    version: "v1.2",
    open: 0,
    added: 0,
    knowledge: 1,
    status: "担当者が修正完了を確認",
    comparison:
      "担当者が修正差分・再評価・通常の通信テストを確認した想定です。",
    finding:
      "この指摘への対応を完了として記録します。製品全体の安全性を保証する判定ではありません。",
    action:
      "承認した製品知識を次回の診断で参照し、同じ仕様の調べ直しを減らします。",
    evidence: "サンプルの承認記録: 製品担当者が修正証跡を確認",
    learning:
      "承認済み: 商品カタログとの外部通信では証明書の検証を必須とする。",
  },
] as const;

export function DiagnosticSample() {
  const [selected, setSelected] = useState(0);
  const scene = scenes[selected]!;
  return (
    <section className="diagnostic-sample" aria-label="継続診断のモック">
      <div className="sample-notice" role="note">
        <strong>モック / サンプル</strong>
        <p>
          操作イメージを体験するための架空データです。この画面では実際の診断・保存・定期実行を行いません。
        </p>
      </div>
      <div className="sample-intro">
        <p className="eyebrow">特定製品の継続的な脆弱性診断</p>
        <h1>
          更新するたびに確認し、
          <br />
          修正の確認まで追いかける。
        </h1>
        <p>
          前回の指摘と人の判断を引き継ぎ、修正版でどう変わったかを確かめます。
          下の4つの場面を切り替えて、使い方を見られます。
        </p>
      </div>
      <div className="sample-product">
        <div>
          <span className="sample-caption">サンプル製品</span>
          <h2>サンプル受注API</h2>
          <p>商品カタログと通信する、架空のNode.js / TypeScript製品</p>
        </div>
        <div className="sample-product-meta">
          <span>対象リポジトリ: 架空の登録済みリポジトリ</span>
          <span>仕様: 外部通信で証明書を検証する</span>
        </div>
      </div>
      <div
        className="sample-steps"
        role="group"
        aria-label="サンプルの場面を切り替える"
      >
        {scenes.map((item, index) => (
          <button
            key={item.label}
            type="button"
            aria-pressed={selected === index}
            aria-controls="sample-result"
            onClick={() => setSelected(index)}
          >
            <span className="sample-step-number">0{index + 1}</span>
            {item.label}
          </button>
        ))}
      </div>
      <div id="sample-result" aria-live="polite" aria-atomic="true">
        <div className="sample-result-heading">
          <h2>{scene.label}</h2>
          <span className="sample-caption">
            サンプルの対象版 {scene.version}
          </span>
        </div>
        <div className="sample-metrics">
          <div>
            <span>未解決の指摘</span>
            <strong>
              {scene.open}
              <small>件</small>
            </strong>
          </div>
          <div>
            <span>今回の新規</span>
            <strong>
              {scene.added}
              <small>件</small>
            </strong>
          </div>
          <div>
            <span>承認済みの製品知識</span>
            <strong>
              {scene.knowledge}
              <small>件</small>
            </strong>
          </div>
        </div>
        <div className="sample-result-grid">
          <article className="sample-finding">
            <p className="sample-status">{scene.status}</p>
            <h3>外部通信の証明書検証を確認</h3>
            <p>{scene.finding}</p>
            <p className="sample-evidence">{scene.evidence}</p>
            <h4>前回からどう変わったか</h4>
            <p>{scene.comparison}</p>
            <h4>担当者の確認・対応</h4>
            <p>{scene.action}</p>
          </article>
          <aside className="sample-knowledge">
            <h3>次回に引き継ぐ知識</h3>
            <p>{scene.learning}</p>
            <hr />
            <h3>確認できた範囲も残す</h3>
            <p>
              このサンプルは、コード内のTLS設定1件を追跡する例です。依存関係と実行環境は未診断の想定です。
            </p>
            <p>未診断の範囲や取得できなかった情報は、問題なしと扱いません。</p>
          </aside>
        </div>
      </div>
      <p className="sample-next">
        管理下のリポジトリで実際に使う場合は、
        <a
          href="https://github.com/RNA4219/security-research-workbench/blob/main/docs/product-diagnostics.md"
          target="_blank"
          rel="noreferrer"
        >
          ローカル版の操作・設定
        </a>
        を参照してください。初期の検査範囲はJS/TSのTLS・暗号関連設定とnpm依存の既知情報照合です。
      </p>
    </section>
  );
}
