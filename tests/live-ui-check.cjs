// Optional integration check against an already-running local CoreMind server.
// Exercises the real API through the UI DOM; does not perform a browser visual review.
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'..');

async function waitFor(predicate, label) {
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  const base=process.env.RCA_BASE_URL||'http://127.0.0.1:8011';
  const response=await fetch(base);
  assert.equal(response.status,200);
  const html=await response.text();
  const runtimeErrors=[];
  const console=new VirtualConsole();console.on('jsdomError',e=>runtimeErrors.push(e.message));
  const dom=new JSDOM(html,{url:base,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
  const w=dom.window,$=id=>w.document.getElementById(id);
  try {
    w.AbortController=AbortController;
    w.fetch=(url,options)=>fetch(new URL(url,base),options);
    w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
    w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
    const style=w.document.createElement('style');
    const css=await fetch(`${base}/static/styles.css`);assert.equal(css.status,200);
    style.textContent=await css.text();w.document.head.appendChild(style);
    const guideCss=await fetch(`${base}/static/reading-guide.css`);assert.equal(guideCss.status,200);
    style.textContent+='\n'+await guideCss.text();
    const script=await fetch(`${base}/static/app.js`);assert.equal(script.status,200);
    vm.runInContext(await script.text(),dom.getInternalVMContext());
    const readingGuide=await fetch(`${base}/static/reading-guide.js`);assert.equal(readingGuide.status,200);
    vm.runInContext(await readingGuide.text(),dom.getInternalVMContext());
    const effectScript=await fetch(`${base}/static/effectiveness.js`);assert.equal(effectScript.status,200);
    vm.runInContext(await effectScript.text(),dom.getInternalVMContext());
    const effectCss=await fetch(`${base}/static/effectiveness.css`);assert.equal(effectCss.status,200);
    style.textContent+='\n'+await effectCss.text();
    await waitFor(()=>$('connection-label').textContent==='Snow snapshot loaded' && $('incident-table').querySelector('tbody'),'workspace loaded');
    const workspaceData=await (await fetch(`${base}/api/workspace`)).json();
    assert.equal($('overview-metrics').querySelector('strong').textContent,new Intl.NumberFormat('en-GB').format(workspaceData.incident_count));
    assert.equal(w.getComputedStyle($('view-health')).display,'none');
    const example=$('linked-examples').querySelector('[data-incident]');
    assert.ok(example,'Real linked incident available');
    const incident=example.dataset.incident;
    example.click();assert.equal($('incident-input').value,incident);
    $('investigation-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
    await waitFor(()=>$('report-title').textContent===incident && !$('run-investigation').disabled,'real RCA result');
    assert.match($('report-context').textContent,/Unconfirmed/);
    assert.ok($('hypothesis-cards').querySelector('.hypothesis-card'));
    $('tab-evidence').click();
    const source=$('evidence-table').querySelector('[data-evidence]');assert.ok(source);
    source.click();assert.ok($('evidence-dialog').hasAttribute('open'));
    assert.ok($('evidence-detail').textContent.includes('snow_'));
    $('close-evidence').click();$('tab-impact').click();
    assert.equal($('impact-metrics').querySelectorAll('.metric-card').length,6);
    $('tab-timeline').click();assert.ok($('record-timeline').querySelector('.timeline-item'));
    $('session-history').querySelector('button').click();assert.equal($('report-title').textContent,incident);
    w.document.querySelector('[data-view="guide"]').click();
    assert.equal($('guide-example-badge').textContent,'Current investigation');
    assert.match($('guide-result-context').textContent,new RegExp(incident));
    $('guide-step-3').click();$('guide-lesson').querySelector('[data-guide-open]').click();
    assert.equal($('tab-impact').getAttribute('aria-selected'),'true');
    w.document.querySelector('[data-view="effectiveness"]').click();
    await waitFor(()=>$('effect-detail').querySelector('.effect-score-ring'),'effectiveness loaded');
    assert.equal(w.getComputedStyle($('view-effectiveness')).display,'block');
    assert.ok($('effect-table').querySelector('tbody'));
    assert.ok($('effect-detail').querySelector('svg[role="img"]'));
    assert.equal($('effect-error').classList.contains('hidden'),true);
    const effectData=await (await fetch(`${base}/api/effectiveness?window_days=${$('effect-window').value}`)).json();
    assert.equal(effectData.summary.problems,effectData.problems.length);
    assert.equal(effectData.summary.scored,effectData.problems.filter(p=>p.score!=null).length);
    const selectedId=$('effect-detail').querySelector('.effect-score-panel h2').textContent;
    const selectedProblem=effectData.problems.find(p=>p.id===selectedId);
    assert.ok(selectedProblem);
    assert.equal($('effect-detail').querySelector('.effect-score-ring strong').textContent,selectedProblem.score==null?'\u2014':String(selectedProblem.score));
    assert.equal(runtimeErrors.length,0,runtimeErrors.join('; '));
    process.stdout.write(JSON.stringify({served_ui_verified:true,snapshot_incidents:workspaceData.incident_count,investigated_incident:incident,
      evidence_drawer_verified:true,impact_and_timeline_verified:true,session_history_verified:true,effectiveness_verified:true,scored_problems:effectData.summary.scored,runtime_errors:runtimeErrors.length})+'\n');
  } finally {dom.window.close();}
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
