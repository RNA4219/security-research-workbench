# 依存OSSと公開ソース由来の配布物

このアプリはMITです。依存OSSのライセンスはそれぞれの配布物に従います。

- React / React DOM: MIT
- @babel/parser: MIT。製品コードを実行せず、JavaScript / TypeScriptを構文解析する実行依存。
- Vite / Fastify / @fastify/static / react-markdown / Zod: MIT
- TypeScript: Apache-2.0（開発依存）
- Vitest: MIT（開発依存）
- Playwright: Apache-2.0（開発依存）
- agent-protocols: MIT。下記パッケージ内に上流LICENSEを同梱。
- memx-resolver: MIT。任意の外部プロセスであり、本アプリにはバイナリを同梱しない。

## agent-protocols

npm registryに公開パッケージがなかったため、上流公開ソースから作ったtgzを利用しています。既存Schema・検証・ID生成・policyは再実装していません。

- Source: https://github.com/RNA4219/agent-protocols
- Commit: `c3d64bc3b8b7e6549bd30d9d176c954ae785039a`
- Version: `2.0.0-beta.1`
- File: `vendor/rna4219-agent-protocols-2.0.0-beta.1.tgz`
- SHA256: `93ec293928a726cee31dc08b3bf840153f0e3372a3f20f55fe05590715afa55d`

再ビルドは空の作業ディレクトリで公開repoをcloneし、上記commitをcheckoutして行います。

```sh
git clone https://github.com/RNA4219/agent-protocols.git
cd agent-protocols
git checkout --detach c3d64bc3b8b7e6549bd30d9d176c954ae785039a
npm ci --ignore-scripts
npm run build
npm pack
```

生成物は上流のfiles設定に従うdist・Schema・docs・README・LICENSEです。上流ソースを変更していません。
OSの改行設定などにより再packのバイト列は変わることがあります。通常利用は同梱tgzとlockfileのintegrityで固定します。
上流の開発依存に対するaudit結果と本アプリのruntime依存のaudit結果は別物です。

GPT Researcher、STORM、Open Deep Research、Trivy、OSV-Scanner、DefectDojoは調査対象であり、コードの同梱・実行依存ではありません。
