'use strict';

// Product guidance stays separate from the model and its evidence calculations.
(() => {
  const steps = [
    {
      title:'Start with the brief', short:'Read the brief', icon:'file', tab:'summary',
      question:'What was investigated, and what did the system find?',
      text:'Read the incident ID, company scope, snapshot date, and investigation summary together. The summary describes the records found and the leading hypothesis. It does not establish a confirmed failure mechanism.',
      check:['Confirm that the incident or cluster matches the issue you are investigating.',
        'Check the company scope. An unscoped symptom search can retrieve records from different companies.',
        'Read the status. “Human validation required” means there are hypotheses to test. “Insufficient causal evidence” means more evidence is needed.'],
      action:'Read the current brief', takeaway:'A useful starting question: “Does this report describe the incident I actually want to understand?”'
    },
    {
      title:'Compare the hypotheses', short:'Compare hypotheses', icon:'search', tab:'summary',
      question:'Which possible explanation has the strongest recorded support?',
      text:'A hypothesis is a possible explanation. The evidence score ranks support from related problem records or preceding changes. Compare the basis, cited sources, and validation step before deciding what to investigate first.',
      check:['An explicit problem link is a recorded relationship to the incident; it still needs validation for the current failure.',
        'Historical analogy means similar symptoms appeared in another problem. The mechanism may differ.',
        'Change correlation means a matching change preceded an incident. Check actual execution and telemetry; planned timing alone is weak evidence.'],
      action:'Compare current hypotheses', takeaway:'An evidence score of 0.57 is a support score on a 0–1 scale. It is not a 57% chance that the cause is correct.'
    },
    {
      title:'Open the source records', short:'Inspect evidence', icon:'link', tab:'evidence',
      question:'Can I trace the explanation to a source record?',
      text:'Select a cited ticket or use the Evidence tab to open its source drawer. Read the excerpt, source table, relationship, CI, service, and recorded cause details. Similarity measures symptom-text overlap; it does not measure causal certainty.',
      check:['Compare the source symptoms and affected resource with the current incident.',
        'Distinguish a recorded cause code from a specific technical mechanism. “Network” is a broad category.',
        'Use the Timeline tab to understand record chronology. Its dates are record creation times, not outage starts or change execution times.'],
      action:'Inspect current evidence', takeaway:'An explanation is more useful when you can point to its source and describe what additional evidence would confirm or reject it.'
    },
    {
      title:'Read the observed impact', short:'Assess impact', icon:'activity', tab:'impact',
      question:'What impact is visible in the available records?',
      text:'The Impact tab counts related incidents, recorded active states, high priorities, affected-user identifiers, and matched SLA records. Use the service, CI, and assignment-group breakdowns to understand the observed scope and who should review it.',
      check:['Treat all counts as observations in the loaded sample. Missing incidents or dependencies can change the wider impact.',
        'Zero observed SLA breaches does not establish SLA compliance. SLA extraction is bounded separately.',
        'Recorded affected users can be incomplete. Outage hours sum ticket intervals and may overlap.'],
      action:'Read current impact', takeaway:'Use the impact view to prioritize investigation. Confirm the full business impact with service owners and monitoring data.'
    },
    {
      title:'Validate before concluding', short:'Validate the cause', icon:'check', tab:'summary',
      question:'What would prove or disprove the leading explanation?',
      text:'Review the recommended actions and evidence gaps. Collect incident-time logs, resource telemetry, and change implementation records, then ask the responsible service team to test the proposed mechanism.',
      check:['Write down the evidence needed to confirm each hypothesis and any facts that would contradict it.',
        'Check Data & model health for coverage and retrospective validation limits. Classifier predictions are exploratory leads.',
        'Use the checklist to track your review. Checking items does not confirm a root cause or write back to Snow.'],
      action:'Review validation steps', takeaway:'A complete RCA identifies a tested mechanism, supporting evidence, impact, and prevention actions. This prototype prepares the investigation; an analyst confirms the conclusion.'
    }
  ];
  const help = {
    confidence:{title:'Evidence score', meaning:'A heuristic support score from 0 to 1, used to rank hypotheses in this investigation.', read:'Read it with the hypothesis basis and cited records. A score of 0.57 does not mean 57% causal certainty. The score is not calibrated as a probability.', next:'Inspect the cited source records and test the proposed mechanism.'},
    similarity:{title:'Symptom similarity', meaning:'A text-similarity score between your investigation symptoms and a retrieved source record.', read:'A higher value means more symptom-text overlap. Similar wording can occur for different underlying failures, so similarity alone does not establish a common cause.', next:'Compare services, CIs, timing, and the recorded failure details.'},
    prediction:{title:'Cause-category model lead', meaning:'The classifier ranks broad cause categories learned from labeled closed problem records.', read:'The displayed probabilities are uncalibrated and separate from causal evidence. Retrospective top-1/top-3 accuracy measures held-out labels, not whether a particular RCA is correct.', next:'Treat the category as an investigative lead and verify it with source evidence.'},
    snapshot:{title:'Loaded snapshot', meaning:'The records extracted and indexed for the current model, with an explicit creation-date cutoff.', read:'Most large tables are bounded samples; historical incidents linked to problems are added separately. The cutoff is not a historical database snapshot, and mutable fields may include later information.', next:'Check source coverage and the snapshot date in Data & model health.'},
    sla:{title:'Observed SLA breaches', meaning:'Distinct related incidents with a breached flag in the matched SLA rows available in the snapshot.', read:'One incident can have several SLA rows, but the breach incident count is deduplicated. A zero count means no breach was observed in matched rows; coverage may be incomplete.', next:'Review full SLA records before declaring compliance.'},
    timeline:{title:'Record timeline', meaning:'A chronological view of evidence-record creation dates, displayed in Dubai time.', read:'Creation times show when records were entered. They do not prove when an outage began or a change was implemented.', next:'Use outage fields, actual work-start records, and telemetry for event timing.'},
    validation:{title:'Human validation required', meaning:'The report offers explanations to investigate, while keeping the root cause unconfirmed.', read:'The review checklist records your activity in this page session. Completing it does not update the model’s root-cause status or write to Snow.', next:'Have the responsible team validate the failure mechanism and document the supporting evidence.'}
  };
  let currentStep=0;
  $('view-guide').innerHTML=`
    <div class="page-heading"><div><div class="eyebrow">THE RCA READING GUIDE</div><h1 id="guide-title">Understand the result.<br>Know what to do next.</h1><p>A practical path from a suggested explanation to an evidence-backed conclusion.</p></div><button class="button primary" data-action="example">Start with a linked incident${icon('arrow')}</button></div>
    <div class="guide-intro panel"><span class="guide-intro-icon">${icon('book')}</span><div><h2>Read an investigation in five steps.</h2><p>Start with scope, compare the explanations, inspect their sources, review impact, and validate the mechanism.</p></div><span class="status-badge neutral">Analyst guide</span></div>
    <div class="reading-layout"><nav class="reading-stepper panel" aria-label="Reading guide steps" role="tablist" aria-orientation="vertical">${steps.map((step,i)=>`<button id="guide-step-${i}" role="tab" data-guide-step="${i}" aria-controls="guide-lesson" aria-selected="${i===0}" tabindex="${i===0?0:-1}" class="reading-step ${i===0?'active':''}"><span class="reading-number">0${i+1}</span><span>${step.short}<small>${i===0?'Set the scope':i===1?'Evaluate the support':i===2?'Follow the source':i===3?'Understand the sample':'Test the mechanism'}</small></span>${icon('chevron')}</button>`).join('')}</nav>
      <article id="guide-lesson" class="panel guide-lesson" role="tabpanel" aria-labelledby="guide-step-0"></article></div>
    <article class="panel annotated-report"><div class="panel-heading"><div><h2>Three numbers. Three different meanings.</h2><p id="guide-example-source">Illustrative values for learning; not a new investigation.</p></div><span id="guide-example-badge" class="tag purple-tag">Illustrative example</span></div><div id="guide-number-cards" class="guide-number-grid"></div><div class="guide-result-context" id="guide-result-context"></div></article>
    <div class="two-column"><article class="panel"><div class="panel-heading"><h2>What the result status tells you</h2></div><div class="status-explainer"><span class="status-badge warning">Human validation required</span><p>There are hypotheses with recorded support. Check the evidence and test the mechanism before assigning a root cause.</p></div><div class="status-explainer"><span class="status-badge muted-badge">Insufficient causal evidence</span><p>The available records do not support a defensible hypothesis. Collect additional evidence; this result does not mean that no problem exists.</p></div></article><article class="panel"><div class="panel-heading"><h2>Common reading mistakes</h2></div><ul class="guide-mistakes"><li><strong>A high score is not a confirmed cause.</strong>Read source support and the proposed validation step.</li><li><strong>Zero observed breaches is not proof of compliance.</strong>Check whether the relevant SLA records are present.</li><li><strong>A busy service is not automatically the cause.</strong>Frequency describes incident volume in the sample.</li><li><strong>A nearby change is a lead.</strong>Verify actual execution and before/after telemetry.</li></ul></article></div>
    <article class="panel guide-glossary"><div class="panel-heading"><div><h2>Keep the key terms close</h2><p>Select a term for a short explanation and the next action.</p></div><button class="button text" data-view="health">Inspect model health${icon('arrow')}</button></div><div class="glossary-grid">${Object.entries(help).map(([key,item])=>`<button class="glossary-term" data-help="${key}"><span>${esc(item.title)}</span>${icon('chevron')}</button>`).join('')}</div></article>
    <div class="guide-bottom-callout"><span>${icon('check')}</span><div><strong>The question to ask before signing off</strong><p>“What evidence shows that this mechanism caused this incident, and what would prevent it from recurring?”</p></div></div>`;

  const dialog=document.createElement('dialog');
  dialog.id='reading-help-dialog';dialog.className='reading-help-dialog';dialog.setAttribute('aria-labelledby','reading-help-title');
  dialog.innerHTML=`<div class="drawer-heading"><div><div class="eyebrow">HOW TO READ THIS</div><h2 id="reading-help-title"></h2></div><button id="close-reading-help" class="icon-button" aria-label="Close explanation">${icon('close')}</button></div><div id="reading-help-body"></div><button id="reading-help-more" class="button secondary full">Open the complete reading guide${icon('arrow')}</button>`;
  document.body.appendChild(dialog);

  function setStep(index, focus=false) {
    currentStep=Math.max(0,Math.min(steps.length-1,index));const step=steps[currentStep];
    document.querySelectorAll('[data-guide-step]').forEach(button=>{const active=Number(button.dataset.guideStep)===currentStep;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
    $('guide-lesson').setAttribute('aria-labelledby',`guide-step-${currentStep}`);
    $('guide-lesson').innerHTML=`<div class="lesson-heading"><span class="lesson-icon">${icon(step.icon)}</span><span class="eyebrow">STEP ${currentStep+1} OF ${steps.length}</span></div><h2>${esc(step.title)}</h2><p class="lesson-question">${esc(step.question)}</p><p class="lesson-description">${esc(step.text)}</p><h3>What to check</h3><ul class="lesson-checks">${step.check.map(text=>`<li>${icon('check')}<span>${esc(text)}</span></li>`).join('')}</ul><div class="lesson-takeaway">${icon('book')}<p>${esc(step.takeaway)}</p></div><button class="button text" data-guide-open="${step.tab}">${esc(step.action)}${icon('arrow')}</button><div class="lesson-pagination"><button class="button secondary compact" data-guide-previous ${currentStep===0?'disabled':''}>Previous</button><span>${currentStep+1} / ${steps.length}</span><button class="button primary compact" data-guide-next ${currentStep===steps.length-1?'disabled':''}>Next step${icon('arrow')}</button></div>`;
    if(focus)$(`guide-step-${currentStep}`).focus();
  }
  function refresh() {
    const report=state.report, leading=report?.hypotheses[0], predicted=report?.cause_category_predictions[0];
    const similar=report?.evidence.find(item=>item.symptom_similarity!=null);
    const score=leading?bounded(leading.confidence_score).toFixed(2):report?'—':'0.57';
    const similarity=similar?bounded(similar.symptom_similarity).toFixed(3):report?'—':'0.420';
    const probability=predicted?percent(predicted.uncalibrated_model_probability):report?'Unavailable':'40.0%';
    const category=leading?.cause_category||(report?'No causal hypothesis':'Network');
    $('guide-example-source').textContent=report?'Values from your current investigation. Each number answers a different question.':'Illustrative values for learning; not a new investigation.';
    $('guide-example-badge').textContent=report?'Current investigation':'Illustrative example';
    const cards=[{key:'confidence',label:'EVIDENCE SCORE',value:score,context:category,text:'How strongly do the retrieved records support this hypothesis?',note:'A support ranking on 0–1. Inspect the basis and sources.'},
      {key:'similarity',label:'SYMPTOM SIMILARITY',value:similarity,context:similar?.ticket_id||'Source-record match',text:'How much does the symptom text overlap with this source?',note:'Text overlap. A matching mechanism still needs verification.'},
      {key:'prediction',label:'MODEL LEAD',value:probability,context:predicted?.cause_category||(report?'No classifier lead':'Network'),text:'Which broad cause category does the classifier favor?',note:'An uncalibrated model output, separate from causal evidence.'}];
    $('guide-number-cards').innerHTML=cards.map(card=>`<div class="guide-number-card ${card.key}"><div><span class="guide-card-label">${card.label}</span><button class="metric-help" data-help="${card.key}" aria-label="Explain ${esc(card.label.toLowerCase())}">?</button></div><strong>${esc(card.value)}</strong><span class="guide-card-context">${esc(card.context)}</span><p>${esc(card.text)}</p><small>${esc(card.note)}</small></div>`).join('');
    $('guide-result-context').textContent=report?`Current scope: ${report.seed_incident_ids.join(', ')||'symptom search'} · ${report.company_scope||'unscoped company search'} · root cause remains unconfirmed.`:'Example values illustrate the meaning of each field. Actual results vary by incident and evidence.';
    document.querySelectorAll('#view-guide [data-action="example"]').forEach(button=>button.disabled=!state.workspace?.linked_examples.length);
    addContextHelp();
  }
  function addContextHelp() {
    const attach=(selector,key)=>document.querySelectorAll(selector).forEach(parent=>{
      if(parent.querySelector(`[data-help="${key}"]`))return;
      const button=document.createElement('button');button.type='button';button.className='metric-help';button.dataset.help=key;button.setAttribute('aria-label',`Explain ${help[key].title.toLowerCase()}`);button.textContent='?';parent.appendChild(button);
    });
    attach('.score-block','confidence');attach('.report-status-group','validation');
    attach('.comparison-panel .panel-heading','confidence');
    attach('#report-timeline-panel .panel-heading','timeline');
    attach('#report-evidence-panel .panel-heading','similarity');
    attach('.snapshot-tag','snapshot');
    document.querySelectorAll('#impact-metrics .metric-card').forEach(card=>{if(card.textContent.includes('Observed SLA breaches'))attachCard(card,'sla');});
  }
  function attachCard(card,key) {
    if(card.querySelector(`[data-help="${key}"]`))return;
    const button=document.createElement('button');button.className='metric-help';button.dataset.help=key;button.setAttribute('aria-label','Explain observed SLA breaches');button.textContent='?';card.querySelector('.metric-top').appendChild(button);
  }
  function openHelp(key) {
    const item=help[key];if(!item)return;
    $('reading-help-title').textContent=item.title;
    $('reading-help-body').innerHTML=`<p class="help-definition">${esc(item.meaning)}</p><div class="help-section"><h3>How to read it</h3><p>${esc(item.read)}</p></div><div class="help-next"><span>${icon('arrow')}</span><div><h3>What to do next</h3><p>${esc(item.next)}</p></div></div>`;
    dialog.showModal();
  }
  document.addEventListener('click',event=>{
    const helpButton=event.target.closest('[data-help]');if(helpButton){openHelp(helpButton.dataset.help);return;}
    const step=event.target.closest('[data-guide-step]');if(step){setStep(Number(step.dataset.guideStep));return;}
    if(event.target.closest('[data-guide-next]'))setStep(currentStep+1,true);
    if(event.target.closest('[data-guide-previous]'))setStep(currentStep-1,true);
    const open=event.target.closest('[data-guide-open]');if(open){navigate('investigations');if(state.report)tab(open.dataset.guideOpen);else{$('incident-input').focus();notify('Start an investigation to read its brief, evidence, and impact.');}}
  });
  document.querySelector('.reading-stepper').addEventListener('keydown',event=>{
    if(!['ArrowDown','ArrowUp','ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;
    event.preventDefault();setStep(event.key==='Home'?0:event.key==='End'?steps.length-1:Math.max(0,Math.min(steps.length-1,currentStep+(['ArrowDown','ArrowRight'].includes(event.key)?1:-1))),true);
  });
  const mobile=window.matchMedia?.('(max-width:760px)');
  const orientation=()=>document.querySelector('.reading-stepper').setAttribute('aria-orientation',mobile?.matches?'horizontal':'vertical');
  mobile?.addEventListener('change',orientation);orientation();
  $('close-reading-help').addEventListener('click',()=>dialog.close());
  $('reading-help-more').addEventListener('click',()=>{dialog.close();navigate('guide',true);});
  dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  window.CoreMindGuide={refresh};setStep(0);refresh();
})();
