const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root,'web/index.html'),'utf8');
const code = fs.readFileSync(path.join(root,'web/app.js'),'utf8');
const guide = fs.readFileSync(path.join(root,'web/reading-guide.js'),'utf8');
const styles = fs.readFileSync(path.join(root,'web/styles.css'),'utf8')+'\n'+fs.readFileSync(path.join(root,'web/reading-guide.css'),'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for(let i=0;i<8;i++) await tick(); }

const fixtureManifest = {
  indexed_documents:4,labeled_closed_problems:1,classifier_training_records:1,records:5,as_of:'2026-10-08T19:59:59+00:00',
  source_timezone_assumption:'Asia/Dubai',database:'TestDB',date_convention:'day-month-year',snapshot_sha256:'test-hash',
  source_profile:{snow_Incident_DnA:{retained:3,truncated:true,date_parse_failures:{created:0}},snow_Problem_DnA:{retained:1,truncated:false,date_parse_failures:{created:0}}},
  cause_distribution:{Network:1},metrics:{accuracy:.25,top3_accuracy:.6,majority_baseline_accuracy:.2,macro_f1:.1,training:20,holdout:5,limitation:'Retrospective validation only.'},limitations:['Bounded sample.']
};
const fixtures = [
  {id:'INC1',title:'Network timeout',company:'A',service:'Network',priority:'1',state:'New',created:'2026-10-07T10:00:00+00:00'},
  {id:'INC2',title:'Database connectivity',company:'B',service:'Database',priority:'2',state:'Closed',created:'2026-10-07T09:00:00+00:00'},
  {id:'INC3',title:'Application error',company:'A',service:'Portal',priority:'3',state:'Closed',created:'2026-10-07T08:00:00+00:00'}
];
const fixtureReport = {
  seed_incident_ids:['INC1'],query:'',company_scope:'A',snapshot_as_of:fixtureManifest.as_of,root_cause_confirmed:false,
  status:'hypotheses_require_validation',evidence_summary:'One related incident and one linked problem. Validation required.',
  hypotheses:[{hypothesis:'Recorded Network cause',cause_category:'Network',basis:'explicit_problem_link',confidence_score:.6,evidence_ids:['problem:PRB1'],validation:'Verify network logs.',recorded_mechanism_statements:[]}],
  cause_category_predictions:[{cause_category:'Network',uncalibrated_model_probability:.4}],
  evidence:[{evidence_id:'incident:INC1',ticket_id:'INC1',kind:'incident',title:'Network timeout',excerpt:'Network timeout occurred.',source_table:'snow_Incident_DnA',created:fixtures[0].created,service:'Network',ci:'Router',assignment_group:'Operations',relations:['investigation_seed'],details:{}},
    {evidence_id:'problem:PRB1',ticket_id:'PRB1',kind:'problem',title:'Recorded network issue',excerpt:'Recorded cause statement.',source_table:'snow_Problem_DnA',created:'2026-10-07T11:00:00+00:00',service:'Network',ci:'Router',assignment_group:'Operations',symptom_similarity:.5,relations:['explicit_first_reported_incident'],details:{recorded_cause_code:'Network'}}],
  impact_analysis:{incident_count:1,active_incident_count:1,high_priority_incidents:1,distinct_recorded_affected_users:0,incidents_with_observed_sla_breach:0,sla_rows_matched:0,services:{Network:1},assignment_groups:{Operations:1},configuration_items:{Router:1},reported_outage_hours_sum:0,outage_measure_note:'Ticket intervals only.',scope:'Bounded snapshot.',matching_rule:'Same service.',sla_coverage:'Absence is unknown.'},
  suggested_owners:[{name:'Operations',active:true,responsibility:'Review network logs.'}],recommended_actions:['Inspect source records.','Collect logs.'],evidence_gaps:['No logs available.'],
  orchestration_trace:[{stage:'retrieve_symptoms',result_count:2},{stage:'review_hypotheses',result_count:1}]
};

async function setup(t, options={}) {
  const dom=new JSDOM(html,{url:'http://localhost:8000/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window, requests=[], downloads=[];
  t.after(()=>w.close());
  const style=w.document.createElement('style');style.textContent=styles;w.document.head.appendChild(style);
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  w.URL.createObjectURL=blob=>{downloads.push(blob);return 'blob:test';};w.URL.revokeObjectURL=()=>{};
  w.HTMLAnchorElement.prototype.click=function(){};w.print=()=>{};
  const rows=options.rows||fixtures;
  const workspace={incident_count:rows.length,active_incidents:1,high_priority_incidents:2,record_counts:{problem:1},
    trend:Array.from({length:14},(_,i)=>({date:`2026-09-${17+i}`,count:i===13?3:0})),priority_distribution:{1:1,2:1,3:1},
    top_services:[{name:'Network',count:1}],linked_examples:[{incident_id:'INC1',problem_id:'PRB1',title:'Network timeout',company:'A'}],
    companies:['A','B'],states:['Closed','New'],priorities:['1','2','3']};
  w.fetch=async (url,request={})=>{
    requests.push({url,request});
    if(options.failWorkspace && url==='/api/workspace')return {ok:false,json:async()=>({detail:'Snapshot unavailable'})};
    if(url==='/api/status')return {ok:true,json:async()=>structuredClone(fixtureManifest)};
    if(url==='/api/workspace')return {ok:true,json:async()=>structuredClone(workspace)};
    if(url.startsWith('/api/incidents')){
      const p=new URL(url,'http://localhost').searchParams;
      const list=rows.filter(row=>`${row.id} ${row.title} ${row.company}`.toLowerCase().includes((p.get('search')||'').toLowerCase()) && ['company','state','priority'].every(key=>!p.get(key)||row[key]===p.get(key)));
      const offset=Number(p.get('offset')||0),limit=Number(p.get('limit')||40);
      return {ok:true,json:async()=>structuredClone(list.slice(offset,offset+limit))};
    }
    if(url==='/api/investigate'){
      if(options.deferInvestigation)return new Promise(resolve=>{options.resolve=resolve;});
      if(options.failInvestigation)return {ok:false,json:async()=>({detail:'Incident absent from snapshot'})};
      return {ok:true,json:async()=>structuredClone(options.report||fixtureReport)};
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  vm.runInContext(code,dom.getInternalVMContext());
  vm.runInContext(guide,dom.getInternalVMContext());await settle();
  const $=id=>w.document.getElementById(id);
  const change=(node,value)=>{node.value=value;node.dispatchEvent(new w.Event('change',{bubbles:true}));};
  const submit=async()=>{$('investigation-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();};
  return {w,$,requests,downloads,change,submit,options};
}

test('overview renders real API values and honest model coverage',async t=>{
  const {w,$}=await setup(t);
  assert.equal($('overview-metrics').querySelector('strong').textContent,'3');
  assert.match($('snapshot-label').textContent,/08 Oct 2026/);
  assert.equal($('connection-label').textContent,'Snow snapshot loaded');
  assert.ok($('trend-chart').querySelector('svg[role="img"]'));
  assert.match($('coverage-table').textContent,/Bounded sample/);
  assert.match($('validation-results').textContent,/25.0%/);
  w.document.querySelector('[data-view="health"]').click();
  assert.ok(!$('view-health').classList.contains('hidden'));
});

test('incident selection starts a scoped investigation and renders report tabs',async t=>{
  const {w,$,requests,submit}=await setup(t);
  $('recent-table').querySelector('[data-incident="INC1"]').click();
  assert.equal($('incident-input').value,'INC1');assert.equal($('company-input').value,'A');
  await submit();
  assert.ok(!$('report-workspace').classList.contains('hidden'));
  assert.equal($('report-title').textContent,'INC1');
  assert.match($('report-status').textContent,/Human validation/);
  assert.match($('hypothesis-cards').textContent,/Network/);
  assert.equal($('session-count').textContent,'1');
  const request=requests.find(r=>r.url==='/api/investigate');
  assert.deepEqual(JSON.parse(request.request.body),{query:'',incident_ids:['INC1'],company:'A'});
  $('tab-evidence').click();assert.ok(!$('report-evidence-panel').classList.contains('hidden'));
  $('tab-evidence').focus();$('tab-evidence').dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  assert.equal($('tab-impact').getAttribute('aria-selected'),'true');
});

test('evidence filters and source drawer reveal recorded details',async t=>{
  const {w,$,submit,change}=await setup(t);$('incident-input').value='INC1';await submit();
  change($('evidence-kind'),'problem');assert.equal($('evidence-table').querySelectorAll('tbody tr').length,1);
  $('evidence-table').querySelector('[data-evidence]').click();
  assert.ok($('evidence-dialog').hasAttribute('open'));assert.equal($('evidence-dialog-title').textContent,'PRB1');
  assert.match($('evidence-detail').textContent,/Recorded cause statement/);
  $('close-evidence').click();assert.ok(!$('evidence-dialog').hasAttribute('open'));
  $('evidence-search').value='no-match';$('evidence-search').dispatchEvent(new w.Event('input'));
  assert.match($('evidence-table').textContent,/No matching evidence/);
});

test('history preserves completed checks without confirming a root cause',async t=>{
  const {w,$,submit}=await setup(t);$('incident-input').value='INC1';await submit();
  const check=$('validation-checklist').querySelector('input');check.checked=true;check.dispatchEvent(new w.Event('change',{bubbles:true}));
  assert.equal($('checklist-count').textContent,'1 complete');
  w.document.querySelector('[data-action="new-investigation"]').click();
  assert.ok($('report-workspace').classList.contains('hidden'));
  $('session-history').querySelector('button').click();
  assert.ok($('validation-checklist').querySelector('input').checked);
  assert.match($('report-context').textContent,/Unconfirmed/);
});

test('cluster import fills validated scope and rejects malformed JSON structure',async t=>{
  const {w,$}=await setup(t);
  const file={name:'cluster.json',size:100,text:async()=>JSON.stringify({incident_ids:['inc1','INC1'],summary:'Recurring timeout',company:'A'})};
  Object.defineProperty($('cluster-file'),'files',{configurable:true,value:[file]});
  $('cluster-file').dispatchEvent(new w.Event('change'));await settle();
  assert.equal($('incident-input').value,'INC1');assert.equal($('symptom-input').value,'Recurring timeout');
  assert.match($('cluster-context').textContent,/cluster.json/);
  file.text=async()=>JSON.stringify({incident_ids:'INC1'});$('cluster-file').dispatchEvent(new w.Event('change'));await settle();
  assert.match($('form-error').textContent,/must be an array/);
});

test('empty form and unknown IDs show actionable errors',async t=>{
  const {w,$,requests,submit}=await setup(t,{failInvestigation:true});await submit();
  assert.match($('form-error').textContent,/Enter an incident/);assert.ok(!requests.some(r=>r.url==='/api/investigate'));
  $('incident-input').value='BAD-ID';await submit();assert.match($('form-error').textContent,/INC followed by digits/);
  $('incident-input').value='INC999';await submit();assert.match($('form-error').textContent,/absent from snapshot/);
  assert.ok(!$('run-investigation').disabled);assert.ok($('investigation-loading').classList.contains('hidden'));
});

test('mixed-company selection is blocked before submitting an investigation',async t=>{
  const {w,$,requests}=await setup(t);
  for(const id of ['INC1','INC2']){const input=$('incident-table').querySelector(`[data-select-incident="${id}"]`);input.checked=true;input.dispatchEvent(new w.Event('change',{bubbles:true}));}
  $('investigate-selected').click();assert.match($('toast').textContent,/one company/);
  assert.ok(!requests.some(r=>r.url==='/api/investigate'));
});

test('incident filters and pagination send bounded API requests',async t=>{
  const rows=Array.from({length:24},(_,i)=>({...fixtures[0],id:`INC${i+1}`}));
  const {w,$,change,requests}=await setup(t,{rows});
  assert.ok(!$('next-page').disabled);$('next-page').click();await settle();
  assert.match($('page-label').textContent,/Showing 21–24/);
  change($('company-filter'),'B');await settle();assert.match($('incident-table').textContent,/No matching incidents/);
  assert.ok(requests.some(r=>r.url.includes('company=B')&&r.url.includes('offset=0')));
});

test('insufficient evidence renders abstention rather than a fabricated hypothesis',async t=>{
  const report=structuredClone(fixtureReport);report.status='insufficient_causal_evidence';report.hypotheses=[];report.cause_category_predictions=[];
  const {$,submit}=await setup(t,{report});$('symptom-input').value='Unknown symptoms';await submit();
  assert.equal($('report-status').textContent,'Insufficient causal evidence');assert.match($('hypothesis-cards').textContent,/More evidence is needed/);
});

test('record text is escaped instead of becoming executable markup',async t=>{
  const report=structuredClone(fixtureReport);report.hypotheses[0].cause_category='<img src=x onerror=alert(1)>';
  report.evidence[0].excerpt='<script>window.hacked=true</script>';
  const {$,submit}=await setup(t,{report});$('incident-input').value='INC1';await submit();
  assert.equal($('hypothesis-cards').querySelectorAll('img').length,0);
  assert.match($('hypothesis-cards').textContent,/<img/);
  $('evidence-table').querySelector('[data-evidence="incident:INC1"]').click();
  assert.equal($('evidence-detail').querySelectorAll('script').length,0);
});

test('API outage is visible and mobile navigation supports closing with Escape',async t=>{
  const {w,$}=await setup(t,{failWorkspace:true});
  assert.match($('global-error').textContent,/Snapshot unavailable/);assert.equal($('connection-label').textContent,'Snapshot unavailable');
  $('menu-toggle').click();assert.equal($('menu-toggle').getAttribute('aria-expanded'),'true');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal($('menu-toggle').getAttribute('aria-expanded'),'false');
});

test('report exports contain the actual report and preserve unconfirmed status',async t=>{
  const {w,$,submit,downloads}=await setup(t);$('incident-input').value='INC1';await submit();$('export-report').click();
  assert.equal(downloads.length,1);assert.match($('toast').textContent,/JSON export/);
  const content=await new Promise((resolve,reject)=>{const reader=new w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(downloads[0]);});
  const exported=JSON.parse(content);assert.equal(exported.root_cause_confirmed,false);assert.equal(exported.evidence[1].ticket_id,'PRB1');
  assert.match($('record-timeline').textContent,/Dubai/);
});

test('pending investigations lock scope and prevent duplicate submissions',async t=>{
  const options={deferInvestigation:true};const {w,$,submit,requests}=await setup(t,options);
  $('incident-input').value='INC1';await submit();
  assert.ok($('incident-input').disabled);assert.equal($('investigation-form').getAttribute('aria-busy'),'true');
  await submit();assert.equal(requests.filter(r=>r.url==='/api/investigate').length,1);
  options.resolve({ok:true,json:async()=>structuredClone(fixtureReport)});await settle();
  assert.ok(!$('incident-input').disabled);assert.equal($('investigation-form').getAttribute('aria-busy'),'false');
});

test('styles parse and inactive views are actually hidden',async t=>{
  const {w,$}=await setup(t);
  assert.ok(w.document.styleSheets[0].cssRules.length>50);
  assert.equal(w.getComputedStyle($('view-health')).display,'none');
  w.document.querySelector('[data-view="health"]').click();
  assert.notEqual(w.getComputedStyle($('view-health')).display,'none');
});

test('reading guide is accessible, clearly labels examples, and supports keyboard steps',async t=>{
  const {w,$}=await setup(t);
  w.document.querySelector('[data-view="guide"]').click();
  assert.ok(!$('view-guide').classList.contains('hidden'));
  assert.equal($('guide-example-badge').textContent,'Illustrative example');
  assert.match($('guide-number-cards').textContent,/0.57/);
  $('guide-step-1').click();
  assert.match($('guide-lesson').textContent,/not a 57% chance/);
  $('guide-step-1').focus();$('guide-step-1').dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  assert.equal($('guide-step-2').getAttribute('aria-selected'),'true');
  assert.match($('guide-lesson').textContent,/source records/);
});

test('contextual explanations open and close without altering result status',async t=>{
  const {w,$,submit}=await setup(t);$('incident-input').value='INC1';await submit();
  w.document.querySelector('.score-block [data-help="confidence"]').click();
  assert.ok($('reading-help-dialog').hasAttribute('open'));
  assert.equal($('reading-help-title').textContent,'Evidence score');
  assert.match($('reading-help-body').textContent,/does not mean 57% causal certainty/);
  assert.equal($('report-status').textContent,'Human validation required');
  $('close-reading-help').click();assert.ok(!$('reading-help-dialog').hasAttribute('open'));
});

test('guide reflects the current result and links back to the correct report tab',async t=>{
  const {w,$,submit}=await setup(t);$('incident-input').value='INC1';await submit();
  w.document.querySelector('[data-view="guide"]').click();
  assert.equal($('guide-example-badge').textContent,'Current investigation');
  assert.match($('guide-number-cards').textContent,/0.60/);
  assert.match($('guide-number-cards').textContent,/0.500/);
  assert.match($('guide-number-cards').textContent,/40.0%/);
  $('guide-step-3').click();$('guide-lesson').querySelector('[data-guide-open]').click();
  assert.ok(!$('view-investigations').classList.contains('hidden'));
  assert.equal($('tab-impact').getAttribute('aria-selected'),'true');
});

test('guide does not invent a hypothesis or score for an insufficient result',async t=>{
  const report=structuredClone(fixtureReport);report.hypotheses=[];report.cause_category_predictions=[];report.status='insufficient_causal_evidence';
  const {w,$,submit}=await setup(t,{report});$('incident-input').value='INC1';await submit();
  w.document.querySelector('[data-view="guide"]').click();
  assert.match($('guide-number-cards').textContent,/No causal hypothesis/);
  assert.ok(!$('guide-number-cards').textContent.includes('0.57'));
  assert.match($('guide-number-cards').textContent,/No classifier lead/);
});
