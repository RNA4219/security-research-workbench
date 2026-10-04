# Quality Evidence Record

Gate: **go**

評価範囲: real_environment / Windows local workbench functional regression
未評価: 外部環境へのデプロイ承認, 他OS・他ブラウザ互換性, 未導入OSSの実運用

## 判定理由

- All gate conditions satisfied

## テスト配置

- qeg:obligation:RISK-FINAL-01: unit / reuse; tests: unit-suite
- qeg:obligation:RISK-FINAL-02: unit / reuse; tests: unit-suite
- qeg:obligation:RISK-FINAL-03: unit / reuse; tests: unit-suite
- qeg:obligation:RISK-FINAL-04: unit / reuse; tests: unit-suite
- qeg:obligation:code-0: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-1: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-10: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-11: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-12: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-13: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-14: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-15: unit / reuse; tests: unit-suite
- qeg:obligation:code-16: unit / reuse; tests: unit-suite
- qeg:obligation:code-17: unit / reuse; tests: unit-suite
- qeg:obligation:code-18: unit / reuse; tests: unit-suite
- qeg:obligation:code-19: unit / reuse; tests: unit-suite
- qeg:obligation:code-2: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-20: unit / reuse; tests: unit-suite
- qeg:obligation:code-21: unit / reuse; tests: unit-suite
- qeg:obligation:code-22: unit / reuse; tests: unit-suite
- qeg:obligation:code-23: unit / reuse; tests: unit-suite
- qeg:obligation:code-24: unit / reuse; tests: unit-suite
- qeg:obligation:code-25: unit / reuse; tests: unit-suite
- qeg:obligation:code-3: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-4: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-5: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-6: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-7: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-8: e2e / reuse; tests: e2e-suite
- qeg:obligation:code-9: e2e / reuse; tests: e2e-suite

## 残存リスク・人間の確認


## 証跡

- qeg-native/feature_spec: artifacts/requirements.md (sha256:8bac64f82eca7c1c1fcbc6b02a478107645351c0ba9f9d28c9a353c76a645fe9)
- qeg-native/audit: artifacts/qeg-package.mjs (sha256:6dced188df8713c9dda217f6559d779ba7a31ffe9cb87b74321b05a0e364630c)
- qeg-native/audit: artifacts/quality-inputs.mjs (sha256:2e5ba389f6ffbe4111c5a8c6ef7a2841af1452d9f1e3d3ccc5bede97eabcf1c7)
- qeg-native/audit: artifacts/qeg-execution.mjs (sha256:e27766161181427658b93874cd57657eafd15f12fe7ee6a07ede0baa21e4cd04)
- qeg-native/audit: artifacts/quality-chain.py (sha256:49aacda65614c8beaa38ce54df61bf33a9fbbadccfb514638fc087b1c0ded946)
- RanD/requirements_packet: artifacts/rand-document.json (sha256:90869f3d30f546eccb07ddc72d9377d6f31f3dd4f510c762267cf7a75830ce72)
- RanD/requirements_audit_packet: artifacts/rand-audit.json (sha256:d4645047cb1fb0bae8ec32527b4816b3595399dcc3f97623917dc9fd1d23e8ef)
- code-to-gate/findings: artifacts/ctg-findings.json (sha256:a93ffd36b7b37256e7d835dabff7ed753659bd1151bc21445269585ce8da42b3)
- code-to-gate/release_readiness: artifacts/ctg-readiness.json (sha256:8dbf2c0e40a800a739c11fc035f601393595e469f522b9e7b3b517d7b105bc6e)
- junit/junit: artifacts/hate-test-results.ndjson (sha256:7987d1e9b40ba7eee152cc9826b86953b8206b39ad8eb01229572d83251348f9)
- qeg-native/audit: artifacts/hate-precheck.json (sha256:08d0522757619296f4000a43932a6d77e4403d075dbc5ca0b3e0a71a9a9411b0)
- junit/junit: artifacts/junit.xml (sha256:db667165d417f61188718d35c1605868e4810eb4cb0d633ab077f62278ed96ea)
- coverage/coverage: artifacts/coverage-gate.json (sha256:194108b15863b376e91092667a5653e70db49bbe93357f0a03787633479b4a86)
- qeg-native/audit: artifacts/run-identity.json (sha256:c9db1a3c7679631a29c243d78a088da8ee651c22d031f178eb15378550a4a316)
- manual-bb-test-harness/manual_case_set: artifacts/manual-cases.json (sha256:c3d72e152b2a0f10ba598fedf2eb07ef33fdd74055090befb2f8fdfd1491e636)
- qeg-native/audit: artifacts/manual-gate-original.json (sha256:e61b9f089bf7e167e0553e95ac8364acdea428d5f5da55cf4a7f1f75cb11fd1f)
- manual-bb-test-harness/gate_decision: artifacts/manual-gate.json (sha256:cc59d67784b59674c8dd1dc0ccf5c63530caae2ec4664226b681a013d9dea62d)
- manual-bb-test-harness/risk_register: artifacts/manual-risks.json (sha256:1dcdcefe8c91173f435846eb7708e3a55754ba75108334adc8d23b2f54590e52)
- manual-bb-test-harness/feature_spec: artifacts/feature_spec.json (sha256:05b82de8168c738cc5c289dc35e3a67436fb37218d0011a96e7577893a68676a)
- manual-bb-test-harness/test_model: artifacts/test_model.json (sha256:64bf6f69eb93906b7721c2bac82dcd9f5be7bc8754b9c3f1c772477c96bd6d5a)
- manual-bb-test-harness/observation_set: artifacts/observation_set.json (sha256:0e9c558a13d5e3bfec7427bc4b04172a636383d0ab30d1a434b516b36292d422)
- manual-bb-test-harness/execution_evidence: artifacts/automation_evidence.json (sha256:53d3578f5a6428175e9f02a7b35c933cc423cbc0160ecd64ece25eaa33bb1c94)
- git-diff/git_diff: artifacts/code-0-api.ts (sha256:59791aeaccafe574a4e8972ddf4f52d410efbd1af888661b7ee24c4f546be3b5)
- git-diff/git_diff: artifacts/code-1-app.tsx (sha256:8cb97903ad01efa541aba97a49bf14f1db9f44f44dcfc1ffae7cf7edc9a6eff9)
- git-diff/git_diff: artifacts/code-2-claim-editor.tsx (sha256:aa8e727969f5dd110bba6abec7118801da50fed351ac119806497493ab52d801)
- git-diff/git_diff: artifacts/code-3-compare-page.tsx (sha256:691b6b794c69ddabcf57eb315c7fb765199fe65d77bc9c7f7033321b3c6a674c)
- git-diff/git_diff: artifacts/code-4-constants.ts (sha256:91e5cf7cad380d57c60e2888a9743314e62d17289a15bf4ca639ab8e3352d422)
- git-diff/git_diff: artifacts/code-5-evidence-page.tsx (sha256:18c3f87d6d8a7f3bace0397668f6e18c75a8498d30d0a81410da45f15408f056)
- git-diff/git_diff: artifacts/code-6-export-page.tsx (sha256:1bfb479987c8bbe30854d1d5697946ab7c59cb67c4eb3f76a80050a2e9044571)
- git-diff/git_diff: artifacts/code-7-forms.tsx (sha256:759141b0a54f4516ccbf9b2f46a961fadf8748b7ade4eaa5d078297a5a9685ae)
- git-diff/git_diff: artifacts/code-8-history-page.tsx (sha256:a63c30cbf03e1d430605c307ebc32c5e3a0d6598d71aa697d4113c3ea63e337a)
- git-diff/git_diff: artifacts/code-9-main.tsx (sha256:e47118ef855f6b8e92cbbb198b914ef4eef1cc830b02162b3c98f388839c756f)
- git-diff/git_diff: artifacts/code-10-provenance.tsx (sha256:6a608d3f1d0d18268c07aa336428ad34684874cae0a4b132f0beba28c3435277)
- git-diff/git_diff: artifacts/code-11-requirements-page.tsx (sha256:acbe53eb3403306e69b1531fc3301782f19978796584fae3f91046ac83454223)
- git-diff/git_diff: artifacts/code-12-settings-page.tsx (sha256:a97b51fd7f13c59ee552910f32c35508a55f30e5377507762d11ad6a8b68d63b)
- git-diff/git_diff: artifacts/code-13-sources-page.tsx (sha256:f62017bbe55248ee96d793c3f1d2900db6a277e27100695e55825811a64557ab)
- git-diff/git_diff: artifacts/code-14-style.css (sha256:31a889770f9380385119e791444db3aeb2ed4e1ede4e02180e5fcb049c343cfb)
- git-diff/git_diff: artifacts/code-15-agent-protocols.ts (sha256:a1a4251e8decffb8286dd1fd7645d9c53c89762f178314b2a40bcd269d3a7c75)
- git-diff/git_diff: artifacts/code-16-app.ts (sha256:4388c8be3f9d56b5f88c89f657ca08661f4773c5bf6ebe897c6ea4f03be4bf41)
- git-diff/git_diff: artifacts/code-17-domain.ts (sha256:9bac7c1e7f333302759e26ab5478549e3d21e10cbddfb78734604e448262dc80)
- git-diff/git_diff: artifacts/code-18-exports.ts (sha256:83f7dcc06520684c12a6898b422b2f63e7ef83b205ae4a7b9b707a12bac6f701)
- git-diff/git_diff: artifacts/code-19-index.ts (sha256:1b6003dfee04b0e453df883c5107528ed34f3509e3dbe1750eab154021e63f0a)
- git-diff/git_diff: artifacts/code-20-memx.ts (sha256:eb00061c014ece1d0b7bf2403fdc328b50c0bb6cabd8edb21cdf004462422851)
- git-diff/git_diff: artifacts/code-21-provenance.ts (sha256:bd0f2f1c7273c56168928f388e2a3de602e150c8475cfd981b19f674a895470c)
- git-diff/git_diff: artifacts/code-22-store.ts (sha256:b17c10f93b213c2a4f9a514a66cab31c70dc6edc763b520da71ddd05b76fa27e)
- git-diff/git_diff: artifacts/code-23-validation.ts (sha256:3dd3dd37783599670a02fb463258ba6d667e24a313ad338be2d2957c4577072d)
- git-diff/git_diff: artifacts/code-24-example.ts (sha256:2e107bda1604f358151343d5ea308ad8a84aaf090a9bbfa4aa3486bccbded1d0)
- git-diff/git_diff: artifacts/code-25-model.ts (sha256:5fa19f299985a8a0fb2905984990b10ec5fdc643bf9c979eae865070aba5ff1e)
- qeg-native/execution_evidence: artifacts/build-binding.json (sha256:2bb6c2ac949cc3c1699beff7aef97538c6cd34ce8850148c350cf62d8988221d)
- qeg-native/audit: artifacts/unit-suite-normalization.json (sha256:6211410bbf8dcbbd3a38553c3f44fdc7f54b96f1f094fca42a86c10a1b16fa54)
- qeg-native/execution_evidence: artifacts/unit-suite-execution.json (sha256:58598191f44bc3d26bbedbc8c8c8bff0733b4ba5590df2ff7460ae8fdca37a0e)
- qeg-native/audit: artifacts/e2e-suite-normalization.json (sha256:cb177724e6437f28c49b9e1f3bbb757c0bb8ab9ffc4a8525f1dc5cc7dca79c10)
- qeg-native/execution_evidence: artifacts/e2e-suite-execution.json (sha256:331136188afcfd38da4f9a151c58ea269f05a5436960987722f327de73e34181)
- qeg-native/execution_evidence: artifacts/build.json (sha256:e7337251239139263458336c701cdf5415f7f3da160ccd7700584eadfd9b6b59)
- qeg-native/audit: artifacts/build.log (sha256:c75fc5dc7b16020d5927d59133e52446190353776742e8717c795eaa5417f461)
- qeg-native/audit: artifacts/build-normalization.json (sha256:c252d1be8eb8fe194709a3265ced11e64c5651d80da56a05785c316851431171)
- qeg-native/execution_evidence: artifacts/build-execution.json (sha256:da20a69cb70c931942b0dc3ef7c5ef04727afb4dbe176d49b8f85766816068ad)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-01.json (sha256:a1791cd7cae202d54c7cadd5b3914b39436f00bbf0c0465f73e2b345e0568791)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-01-attachment-0.txt (sha256:2dea1dbc3ee284d88045082ffc75bb512cfb6a07fbfa60ebf7f588e9ffe5f01b)
- qeg-native/audit: artifacts/TC-FINAL-01-normalization.json (sha256:b3a78893da1bc5a3aa8285203ba9e8548b3f4256b404f02cc3dc8703e3669ab6)
- qeg-native/execution_evidence: artifacts/TC-FINAL-01-execution.json (sha256:6afd5d01896405407c799de927d9694f868805d99ee7dcb60288a30a81c38181)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-02.json (sha256:1de183088f59ea3e3e3d50a667e53d3ef454d5ac42dee3b097d9ec9e88ac9c68)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-02-attachment-0.txt (sha256:9de9cf45099816a4096a8437fcda0509cf1142d30e14c3a8858513c461760350)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-02-attachment-1.txt (sha256:e5c4939e55a39ac414b2ed2b05385283f88cff50b1ecd6d0eca35ed3243b5944)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-02-attachment-2.txt (sha256:0617705c92bb6342e592180741c403113c05c0fc1ed72bd69828373664de671b)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-02-attachment-3.txt (sha256:924e50ee313a1034c7907a36326cbf496cd9ecc3b15bff6678ec1a35e50a1210)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-02-attachment-4.txt (sha256:a38e219809a9388247b47a0c83ecd08429d8847dfebb31ad5a44868fbdee6bac)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-02-attachment-5.txt (sha256:f97a295f1f0f00e7336ff556fd621ee7656b178238748e680e1635c59b460b36)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-02-attachment-6.txt (sha256:5e0cbbbc8995044e9d7ceb9da1e3e13d6886ac60f3236e261fdb7ad14b4649b3)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-02-attachment-7.txt (sha256:b8821fa8f2c917ce12cbb646f8b8c9ba4f294dfd7837aa590685729bfc1080fd)
- qeg-native/audit: artifacts/TC-FINAL-02-normalization.json (sha256:e338951f31f66cf972252df2385735c48dc7a759386457a8ff1d346f1d317df1)
- qeg-native/execution_evidence: artifacts/TC-FINAL-02-execution.json (sha256:4b4767c8178854db21a47a59618181ac7002b5f7c7588c54f3cf059030cfede8)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-03.json (sha256:7a2a7ffcca5f0c57336978e977a7a5e9243266ab8bfe4ecbf5100fc8ec3feac6)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-03-attachment-0.txt (sha256:9ae27c07be3954405257c8276f652dfe4d13956e6899fd04436248c05d61f447)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-03-attachment-1.txt (sha256:0757d1ae6e94ccf8443eeffc3d07626c9eb84ba717598f27b287a8699fdbe6b2)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-03-attachment-2.txt (sha256:9c9e71dc3411cdac0f0e750c25151f8184ddd945cd29943b90e852b52d67e5ca)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-03-attachment-3.txt (sha256:0757d1ae6e94ccf8443eeffc3d07626c9eb84ba717598f27b287a8699fdbe6b2)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-03-attachment-4.txt (sha256:940081a143fee034c9bc7b2fe39ec7957b5b0c7caf9572030665e9d0404eb6c3)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-03-attachment-5.txt (sha256:40c5d492189d834fe6d3f2707cbaa6ad6dc514f85c59a40b745081acbfec4d80)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-03-attachment-6.txt (sha256:55cfa81027c729a00f839770339115914884861a6a4b43a5aca83cc605aa3b65)
- qeg-native/audit: artifacts/TC-FINAL-03-normalization.json (sha256:29fb9f6fdf033ac2389bbdbd290b47caa498cfd52bbc2d285b443d33164f5b09)
- qeg-native/execution_evidence: artifacts/TC-FINAL-03-execution.json (sha256:30c04ab3ddb1eb0e0daef3cb670902de7cd3c95405165996cad3b31dbd19df4b)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-04.json (sha256:3c549902b521af39d135a0903fff0e34b8af4e1f97b6c9e3e167a59f9f0e94a6)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-04-attachment-0.txt (sha256:3d2db9ca0036fefd559236b7c458b7b085be5cebea75d430b64e9b774e4c32d6)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-04-attachment-1.txt (sha256:bd16157bc00fe632d02125d59f48da0dfbb7630a8f8e7bc1bfc2662523426b69)
- manual-bb-test-harness/execution_evidence: artifacts/TC-FINAL-04-attachment-2.txt (sha256:f105e9d36236c94557d71aeccb99029ab2e414e172dea9b0f771a2c5aa927cfc)
- qeg-native/audit: artifacts/TC-FINAL-04-normalization.json (sha256:3fc5c5aa4684c94230922665ce39f8863fced1a5f08825de6cf9dfddb07c2044)
- qeg-native/execution_evidence: artifacts/TC-FINAL-04-execution.json (sha256:c667818342e3c7aa7dac6390d9e5b371a2cff66a6f2d42645f6d4886e6ad9948)
- qeg-native/audit: artifacts/quality-policy.md (sha256:81192d0061465dc4e90a765ec3e767884213c1da0b2dd886930e3f2c95a5d733)

実行証跡の採用
- 評価時計: 2026-10-04T01:59:30.728Z
- 対象: RNA4219/security-research-workbench / c3d96d55126f8982b78818989f8456d7d6c280b0 / windows-node24-local / c3d96d55126f8982b78818989f8456d7d6c280b0
- build: run=final-c3d96d55126f; evidence=exec-build; status=pass; reason=latest_qualified_execution; consecutivePasses=1
- e2e-suite: run=final-c3d96d55126f; evidence=exec-e2e-suite; status=pass; reason=latest_qualified_execution; consecutivePasses=1
- TC-FINAL-01: run=final-c3d96d55126f; evidence=exec-TC-FINAL-01; status=pass; reason=latest_qualified_execution; consecutivePasses=1
- TC-FINAL-02: run=final-c3d96d55126f; evidence=exec-TC-FINAL-02; status=pass; reason=latest_qualified_execution; consecutivePasses=1
- TC-FINAL-03: run=final-c3d96d55126f; evidence=exec-TC-FINAL-03; status=pass; reason=latest_qualified_execution; consecutivePasses=1
- TC-FINAL-04: run=final-c3d96d55126f; evidence=exec-TC-FINAL-04; status=pass; reason=latest_qualified_execution; consecutivePasses=1
- unit-suite: run=final-c3d96d55126f; evidence=exec-unit-suite; status=pass; reason=latest_qualified_execution; consecutivePasses=1
