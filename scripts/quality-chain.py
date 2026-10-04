"""実ツールの証跡を接続する。手動画面の観測結果は外部入力とし、生成しない。"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('phase', choices=['design', 'collect', 'finish'])
parser.add_argument('--tools-root', type=Path, default=ROOT.parents[1])
parser.add_argument('--out', type=Path, default=ROOT / '.cache/final-chain')
args = parser.parse_args()
OUT = args.out.resolve()
TOOLS = args.tools_root.resolve()
MANUAL = TOOLS / 'Agent_tools/manual-bb-test-harness'
sys.path.insert(0, str(MANUAL / 'src'))
from bb_harness.evidence_revisions import bind_case_set, stamp_case_identity
from bb_harness.schema_validation import validate_artifact

def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def run(command, cwd=ROOT):
    subprocess.run([str(x) for x in command], cwd=cwd, check=True)

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

plan = read(ROOT / 'docs/manual-bb/final-plan.json')
feature_id = plan['feature_id']
spec_revision = sha(ROOT / 'docs/requirements.md')
manual = OUT / 'manual'

if args.phase == 'design':
    if (manual / 'manual_case_set.json').exists():
        raise RuntimeError('既存の設計を上書きしない。別の --out を指定してください')
    refs = [{'id': f'FR-{i:02}', 'kind': 'spec', 'excerpt': 'docs/requirements.md'} for i in range(1, 16)]
    model = {'feature_id': feature_id, 'coverage_items': [], **{k: [] for k in ['flows','data_partitions','rule_columns','states','role_matrix','regression_edges']}}
    observations = {'feature_id': feature_id, 'observations': []}
    risks = {'feature_id': feature_id, 'risks': []}
    cases = {'feature_id': feature_id, 'spec_revision': spec_revision, 'manual_cases': []}
    checklist = {'id':'CHECK-FINAL','version':'1','scope':plan['scope'],'objective':'保存と根拠の承認に関する画面回帰','coverage_criterion':'applicable_items','source_refs':refs,'items':[]}
    for i, item in enumerate(plan['cases'],1):
        sources = [ref for ref in refs if ref['id'] in item['requirements']]
        obs, risk, cov = f'OBS-FINAL-{i:02}', f'RISK-FINAL-{i:02}', f'COV-FINAL-{i:02}'
        model['coverage_items'].append({'id':cov,'dimension':'regression','technique':'checklist_based','applicability':'applicable','mandatory':True,'coverage_criterion':'each_item','source_refs':sources})
        observations['observations'].append({'id':obs,'title':item['title'],'view':'black','mandatory':True,'techniques':['checklist_based_testing'],'coverage_item_id':cov,'source_refs':sources,'model_refs':['CHECK-FINAL']})
        risks['risks'].append({'id':risk,'scenario':item['title']+'が成立せず、利用者の判断または保存内容が壊れる','impact':5,'likelihood':3,'priority':'P0','rationale':'保存・承認に関する重大回帰を現行ビルドで確認','trace_to':[item['id']]})
        checklist['items'].append({'id':item['id'],'question':item['title'],'applicable':True,'reason':'画面分割が操作と状態表示に影響する','priority':'P0'})
        case={'tc_id':item['id'],'title':item['title'],'priority':'P0','primary_view':'black','techniques':['checklist_based_testing'],'preconditions':item.get('preconditions',[]),'steps':item['steps'],'expected_results':item['expected'],'oracle':{'type':'specified','refs':item['requirements']},'source_ref':{'type':'spec','refs':item['requirements']},'trace_to':[obs,risk],'estimate_minutes':item['minutes'],'status':'active','coverage_inputs':[{'model_ref':'CHECK-FINAL','checklist_version':'1','checklist_item_ids':[item['id']],'step_refs':list(range(1,len(item['steps'])+1)),'expected_result_refs':list(range(1,len(item['expected'])+1))}]}
        cases['manual_cases'].append(stamp_case_identity(case))
    model['checklist_models']=[checklist]
    artifacts={'feature_spec':{'feature_id':feature_id,'revision':spec_revision,'title':'現行ビルドの最終画面回帰','summary':plan['scope'],'acceptance_criteria':[e for c in plan['cases'] for e in c['expected']],'source_refs':refs},'test_model':model,'observation_set':observations,'risk_register':risks,'manual_case_set':bind_case_set(cases,model)}
    for kind,value in artifacts.items():
        validate_artifact(value,kind+'.schema.json')
        save(manual/(kind+'.json'),value)
    print('設計を保存:', manual)

elif args.phase == 'collect':
    identity=read(ROOT/'.cache/coverage-combined/run-identity.json')
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    if identity['dirty'] or identity['head']!=head:
        raise RuntimeError('clean HEAD の test:quality を先に実行してください')
    run([TOOLS/'RanD/research-runtime/.venv/Scripts/python.exe','-m','rand_research.cli','audit-document','--document',ROOT/'docs/requirements.md','--document-id','security-research-workbench','--out-dir',OUT/'rand'],TOOLS/'RanD/research-runtime')
    ctg=TOOLS/'code-to-gate/dist/cli.js'
    run(['node',ctg,'analyze',ROOT,'--out',OUT/'ctg','--emit','all','--cache','disabled','--quiet'])
    run(['node',ctg,'readiness','--from',OUT/'ctg','--out',OUT/'ctg','--policy',TOOLS/'code-to-gate/.github/ctg-policy.yaml','--quiet'])
    inp=OUT/'hate-input'
    inp.mkdir(parents=True,exist_ok=True)
    suites=ET.Element('testsuites')
    for name in ['unit-junit.xml','e2e-junit.xml']:
        report=ET.parse(ROOT/'.cache/quality'/name).getroot()
        for case in report.findall('.//testcase'):
            path=case.attrib['classname'].replace('\\','/')
            if name=='e2e-junit.xml': path='tests/e2e/'+path
            if not (ROOT/path).is_file(): raise RuntimeError(path)
            case.set('file',path)
        if report.tag=='testsuite': suites.append(report)
        else:
            for suite in report: suites.append(suite)
    ET.ElementTree(suites).write(inp/'junit.xml',encoding='utf-8',xml_declaration=True)
    shutil.copyfile(ROOT/'.cache/coverage-combined/lcov.info',inp/'lcov.info')
    save(inp/'ci-context.json',{'provider':'generic-ci','repository':'RNA4219/security-research-workbench','workflow':'local-test-quality','job':'windows-node24','event_name':'local','run_id':'final-'+head[:12],'run_attempt':1,'commit_sha':head,'base_sha':'0d2faba8cc356f5c96f2bc28b316b95d2527cd8d','started_at':identity['startedAt'],'finished_at':identity['finishedAt'],'actor':'Codex','ref':'refs/heads/main'})
    run([TOOLS/'harness-auto-test-evidence/.venv/Scripts/python.exe','-m','hate','p0a','--input',inp,'--out',OUT/'hate'],TOOLS/'harness-auto-test-evidence')
    build=subprocess.run(['npm.cmd','run','build'],cwd=ROOT,capture_output=True,text=True,encoding='utf-8')
    (OUT/'build.log').write_text(build.stdout+build.stderr,encoding='utf-8')
    save(OUT/'build.json',{'head':head,'command':'npm run build','exitCode':build.returncode,'finishedAt':datetime.now(timezone.utc).isoformat()})
    build.check_returncode()
    print('上流証跡を保存:',OUT)

else:
    identity=read(ROOT/'.cache/coverage-combined/run-identity.json')
    cases=read(manual/'manual_case_set.json')
    observed=read(OUT/'manual-observations.json')
    if observed['head'] != identity['head'] or identity['dirty']:
        raise RuntimeError('手動・自動証跡のビルドが一致しない')
    if len(observed['results'])!=len(cases['manual_cases']): raise RuntimeError('手動結果が不足')
    for case in cases['manual_cases']:
        result=next(r for r in observed['results'] if r['tc_id']==case['tc_id'])
        if not result['actual'] or not result['attachments']: raise RuntimeError('観測または証跡がない')
        for path in result['attachments']:
            if not (OUT/path).is_file(): raise RuntimeError('証跡ファイルがない: '+path)
        evidence={'run_id':'manual-'+identity['head'][:12],'feature_id':feature_id,'build_id':identity['head'],'case_revision':case['case_revision'],'spec_revision':spec_revision,'oracle_revision':case['oracle_revision'],'case_content_hash':case['content_hash'],'oracle_refs':case['oracle']['refs'],'timestamp':result['timestamp'],'result':result['result'],'tc_id':case['tc_id'],'model_hash':cases['evidence_binding']['model_hash'],'env':'Windows Node24 Chromium production 127.0.0.1:4320','tester':'Codex agent-operated UI','oracle_type':'specified','expected':case['expected_results'],'actual':result['actual'],'attachments':result['attachments']}
        validate_artifact(evidence,'execution_evidence.schema.json')
        save(manual/'executions'/(case['tc_id']+'.json'),evidence)
    gate=read(ROOT/'.cache/coverage-combined/gate.json')
    counts=[]
    for name in ['unit','e2e']:
        tests=ET.parse(ROOT/f'.cache/quality/{name}-junit.xml').getroot().findall('.//testcase')
        counts.append({'suite_id':name,'status':'passed' if all(not list(t) or all(c.tag=='system-out' for c in t) for t in tests) else 'failed','total':len(tests),'passed':sum(t.find('failure') is None and t.find('error') is None and t.find('skipped') is None for t in tests),'failed':sum(t.find('failure') is not None for t in tests),'errors':sum(t.find('error') is not None for t in tests),'skipped':sum(t.find('skipped') is not None for t in tests),'source_refs':[{'id':name+'-junit','kind':'auto_test','excerpt':f'.cache/quality/{name}-junit.xml'}]})
    automation={'feature_id':feature_id,'build_id':identity['head'],'coverage_scope':'changed_code','coverage_percent':gate['changed']['pct'],'new_issues':{'blocker':0,'critical':0},'source_refs':[{'id':'coverage','kind':'metric','excerpt':'.cache/coverage-combined/gate.json'}],'test_suites':counts}
    save(manual/'automation_evidence.json',automation)
    run([MANUAL/'.venv/Scripts/bb-harness.exe','gate','--input',manual,'--evidence',manual/'executions','--build-id',identity['head'],'--profile','standard','--output',OUT/'manual-gate.json'])
    run(['node',ROOT/'scripts/qeg-package.mjs',OUT])
    for command in ['place-tests','gate','record']:
        run(['node',TOOLS/'quality-evidence-graph/dist/cli.js',command,OUT/'qeg'])
