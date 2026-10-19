/* RCA outcomes: equal observation windows, explicit coverage, source-level drilldown. */
'use strict';
(() => {
  const labels={reduced:'Reduced recurrence',increased:'Recurrence increased',unchanged:'No reduction',monitoring:'Still monitoring',insufficient_history:'Incomplete history',insufficient_baseline:'Small baseline',awaiting_closure:'Awaiting closure'};
  const tones={reduced:'success',increased:'warning',unchanged:'warning',monitoring:'neutral',insufficient_history:'muted-badge',insufficient_baseline:'muted-badge',awaiting_closure:'muted-badge'};
  let dataset=null,selected=null,request=0,detailRequest=0,loading=false;
  const screen=$('view-effectiveness');
  screen.innerHTML=`
    <div class="page-heading"><div><div class="eyebrow">CLOSE THE LOOP</div><h1 id="effectiveness-title">Did the fix make a difference?</h1><p>Track recurring incidents after problem closure. See what improved, what returned, and what needs a closer look.</p></div><button class="button secondary" id="effect-show-method">How scoring works ${icon('book')}</button></div>
    <div class="effect-toolbar panel"><div class="effect-control"><label for="effect-window">Comparison window</label><select id="effect-window"><option value="7">7 days before & after</option><option value="14">14 days before & after</option><option value="30">30 days before & after</option><option value="90" selected>90 days before & after</option></select></div><div class="effect-control"><label for="effect-company">Company</label><select id="effect-company"><option value="">All companies</option></select></div><div class="effect-search effect-control"><label for="effect-search">Find a problem</label><div class="search-field">${icon('search')}<input id="effect-search" type="search" placeholder="Problem ID, service, or symptoms"></div></div><button id="effect-refresh" class="button secondary" aria-label="Refresh effectiveness analysis">${icon('refresh')} Refresh</button></div>
    <div id="effect-error" class="alert error hidden" role="alert"></div>
    <div id="effect-loading" class="panel effect-loading hidden" role="status"><div class="spinner"></div><strong>Comparing problem outcomes</strong><p>Matching incident families and checking observation coverage.</p></div>
    <div id="effect-results" class="hidden">
      <div id="effect-coverage" class="effect-coverage" role="status"></div>
      <div id="effect-metrics" class="metric-grid"></div>
      <article class="panel effect-readiness"><div class="panel-heading"><div><h2>What is blocking the scores?</h2><p>Missing evidence is different from poor RCA effectiveness. Select a reason to review the affected problems.</p></div><span id="effect-readiness-total" class="tag"></span></div><div id="effect-reasons" class="effect-reasons"></div><p class="effect-readiness-note">Historical incidents linked to an old problem do not establish complete history around its closure. The required date range appears in each problem's follow-up guidance.</p></article>
      <div class="effect-section-title"><div><div class="eyebrow">PROBLEM SPOTLIGHT</div><h2>Follow the outcome, then inspect the evidence.</h2></div><span class="tag">Problem closure is the comparison point</span></div>
      <div id="effect-detail" class="effect-detail" aria-live="polite"></div>
      <article class="panel effect-register"><div class="panel-heading"><div><h2>Problem outcome register</h2><p>Select a problem to inspect its trend and candidate recurrences.</p></div><span id="effect-result-count" class="tag"></span></div><div class="effect-filter-row" role="group" aria-label="Filter problem outcomes"><button data-effect-filter="scored" aria-pressed="false">Scored outcomes</button><button class="active" data-effect-filter="all" aria-pressed="true">All problems</button><button data-effect-filter="review" aria-pressed="false">Recurrence flagged</button><button data-effect-filter="monitoring" aria-pressed="false">Still monitoring</button><button data-effect-filter="reduced" aria-pressed="false">Reduced recurrence</button><button data-effect-filter="unscored" aria-pressed="false">Needs more evidence</button></div><div id="effect-table" class="table-wrap"></div><div class="effect-pagination"><button id="effect-prev" class="button secondary compact">Previous</button><span id="effect-page" role="status"></span><button id="effect-next" class="button secondary compact">Next</button></div></article>
      <details class="panel effect-method" id="effectiveness-method"><summary>Understand the effectiveness score <span>Method, matching rules & limitations</span>${icon('chevron')}</summary><div class="effect-method-grid"><div><h3>1. Define the incident family</h3><p id="effect-match-rule"></p></div><div><h3>2. Compare equal windows</h3><p id="effect-formula"></p><p>At least three matching baseline incidents, complete coverage, and a full follow-up window are required. An increase scores 0 and retains its actual percentage change.</p></div><div><h3>3. Review before claiming success</h3><p id="effect-limitations"></p><p>A score of 100 means no matching recurrence was observed in this window. It does not guarantee that the issue cannot return.</p></div></div></details>
    </div>`;
  let filter='all',page=0,chosenFilter=false;
  const windowDays=()=>Number($('effect-window').value);
  const badge=row=>`<span class="status-badge ${tones[row.status]||'muted-badge'}">${esc(labels[row.status]||row.status)}</span>`;
  const count=(value)=>value==null?'—':number(value);
  function rowMatches(row) {
    const query=$('effect-search').value.trim().toLowerCase();
    return (!query || [row.id,row.title,row.service,row.ci,row.owner].some(v=>(v||'').toLowerCase().includes(query))) &&
      (filter.startsWith('reason:') && row.status===filter.slice(7) || filter==='all' || filter==='scored' && row.score!=null || filter==='review' && row.after_count>0 || filter==='monitoring' && row.status==='monitoring' || filter==='reduced' && row.status==='reduced' || filter==='unscored' && row.score==null);
  }
  function renderTable() {
    const rows=dataset.problems.filter(rowMatches),pageSize=12;
    page=Math.max(0,Math.min(page,Math.ceil(rows.length/pageSize)-1));
    const visible=rows.slice(page*pageSize,(page+1)*pageSize);
    $('effect-result-count').textContent=`${number(rows.length)} problems`;
    $('effect-table').innerHTML=rows.length?`<table class="data-table effect-data"><thead><tr><th scope="col">PROBLEM / SERVICE</th><th scope="col">CLOSED</th><th scope="col">BEFORE → AFTER</th><th scope="col">SCORE</th><th scope="col">OUTCOME</th><th scope="col">REVIEW</th></tr></thead><tbody>${visible.map(row=>`<tr class="${row.id===selected?'effect-selected':''}"><td><button class="ticket-link" data-effect-problem="${esc(row.id)}" aria-label="Review ${esc(row.id)}">${esc(row.id)}</button><span class="ticket-title" title="${esc(row.title)}">${esc(row.title||'Untitled problem')}</span><small>${esc(row.service||'Service not recorded')}</small></td><td>${esc(date(row.closed))}</td><td><strong>${count(row.before_count)}</strong> <span class="muted">→</span> <strong>${count(row.after_count)}</strong>${row.before_count!=null && (!row.baseline_covered||!row.post_covered)?'<small>Partial history</small>':''}</td><td>${row.score==null?'<span class="effect-no-score">Not scored</span>':`<strong class="effect-inline-score">${row.score}<small>/100</small></strong>`}</td><td>${badge(row)}</td><td><button class="button text" data-effect-problem="${esc(row.id)}">View ${icon('arrow')}</button></td></tr>`).join('')}</tbody></table>`:empty('Try another search, company, or outcome filter.','No matching problems');
    $('effect-page').textContent=rows.length?`${page*pageSize+1}–${Math.min((page+1)*pageSize,rows.length)} of ${number(rows.length)}`:'0 problems';
    $('effect-prev').disabled=page===0;$('effect-next').disabled=(page+1)*pageSize>=rows.length;
  }
  function renderSummary() {
    const s=dataset.summary;
    if(!chosenFilter)filter=s.scored?'scored':'all';
    $('effect-metrics').innerHTML=[metric('Average observed score',s.average_score==null?'Not yet scorable':`${s.average_score} / 100`,`${number(s.scored)} of ${number(s.problems)} problems meet scoring criteria`,'chart'),metric('Candidate recurrences',s.recurrence_candidates,'Unique incidents in post-closure windows; review required','activity','orange'),metric('Scored problems needing review',s.needs_review,'Equal or higher incident rate after closure','alert','orange'),metric('Still monitoring',s.monitoring,`${windowDays()}-day follow-up windows in progress`,'clock','blue')].join('');
    $('effect-coverage').innerHTML=`${icon('clock')}<div><strong>Snapshot through ${esc(date(dataset.as_of))}</strong><span>${dataset.coverage_start?`Continuous incident extract begins ${esc(date(dataset.coverage_start,true))} · Dubai time.`:'Continuous incident coverage is not established.'} ${dataset.targeted_history_problems?`${number(dataset.targeted_history_problems)} problems also have complete targeted SQL history for this window. `:""}${number(s.unscored)} problems currently have no score. This analysis updates when a new snapshot is loaded.</span></div>`;
    const reasons=dataset.unscored_reasons||{};
    const reasonText={insufficient_history:['Missing comparison history','Load the complete before/after incident range.'],awaiting_closure:['Missing valid closure','Record a valid closure date and final problem state.'],monitoring:['Follow-up not complete','Wait for the selected follow-up period and load the new incidents.'],insufficient_baseline:['Too few baseline incidents','Try a longer window with enough historical coverage.']};
    $('effect-readiness-total').textContent=`${number(s.unscored)} unscored / ${number(s.problems)} problems`;
    $('effect-reasons').innerHTML=Object.entries(reasons).sort((a,b)=>b[1]-a[1]).map(([key,value])=>`<button data-effect-filter="reason:${esc(key)}" aria-pressed="false"><span class="effect-reason-count">${number(value)}</span><strong>${esc(reasonText[key]?.[0]||labels[key])}</strong><span>${esc(reasonText[key]?.[1]||'Review the evidence requirements.')}</span><small>Review problems ${icon('arrow')}</small></button>`).join('')||(s.unscored?'<p class="empty-inline">Select a problem to inspect its missing scoring requirements.</p>':'<p class="empty-inline">Every problem in this scope meets the scoring requirements.</p>');
    $('effect-match-rule').textContent=dataset.method.matching;$('effect-formula').textContent=dataset.method.formula;$('effect-limitations').textContent=dataset.method.limitation;
    const previous=$('effect-company').value;
    $('effect-company').innerHTML='<option value="">All companies</option>'+dataset.companies.map(v=>`<option>${esc(v)}</option>`).join('');$('effect-company').value=previous;
    screen.querySelectorAll('[data-effect-filter]').forEach(b=>{const active=b.dataset.effectFilter===filter;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    renderTable();
  }
  function trend(row) {
    if(!row.daily.length)return empty('A valid problem closure date is needed to place incidents on this timeline.','Trend not available');
    const width=920,height=226,left=40,right=16,top=24,bottom=40,plot=width-left-right,mid=left+plot/2,base=height-bottom;
    const max=Math.max(1,...row.daily.map(d=>d.count||0)),step=plot/row.daily.length;
    const y=v=>base-v/max*(base-top);
    const bars=row.daily.map((d,i)=>d.count==null?`<rect x="${left+i*step}" y="${top}" width="${step}" height="${base-top}" fill="url(#effect-gap)"/>`:`<rect x="${left+i*step+step*.12}" y="${y(d.count)}" width="${step*.76}" height="${base-y(d.count)}" rx="2" fill="${d.day<0?'var(--blue)':'var(--teal)'}"><title>Day ${d.day>=0?'+':''}${d.day}: ${d.count} candidate incidents</title></rect>`).join('');
    return `<svg class="effect-trend" viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily incident matches ${row.window_days} days before and after problem closure; hatched areas have insufficient observation"><defs><pattern id="effect-gap" patternUnits="userSpaceOnUse" width="7" height="7"><path d="M-1 1l2-2M0 7l7-7M6 8l2-2" stroke="var(--line)" stroke-width="1"/></pattern></defs><rect x="${left}" y="${top}" width="${plot/2}" height="${base-top}" fill="var(--blue-soft)" opacity=".4"/><rect x="${mid}" y="${top}" width="${plot/2}" height="${base-top}" fill="var(--mint-soft)" opacity=".5"/>${[0,.5,1].map(f=>`<line x1="${left}" y1="${y(max*f)}" x2="${width-right}" y2="${y(max*f)}" stroke="var(--line)" stroke-dasharray="3 5"/><text x="${left-9}" y="${y(max*f)+4}" text-anchor="end">${Number((max*f).toFixed(1))}</text>`).join('')}${bars}<line x1="${mid}" y1="10" x2="${mid}" y2="${base+5}" stroke="var(--ink)" stroke-dasharray="4 4"/><text x="${mid+8}" y="14">Problem closed</text>${[-row.window_days,-Math.floor(row.window_days/2),0,Math.floor(row.window_days/2),row.window_days].map(n=>`<text x="${left+(n+row.window_days)/(2*row.window_days)*plot}" y="${height-16}" text-anchor="middle">${n>0?'+':''}${n}d</text>`).join('')}</svg><div class="effect-chart-legend"><span><i style="background:var(--blue)"></i>Before closure</span><span><i style="background:var(--teal)"></i>After closure</span><span><i class="effect-gap-key"></i>Unobserved / incomplete day</span></div>`;
  }
  function nextStep(row) {
    if(row.status==='awaiting_closure')return 'Complete the RCA, record remediation evidence, and close the problem before measuring the outcome.';
    if(row.status==='insufficient_history')return `Load incidents from ${date(row.before_start)} through ${date(row.after_end)}. Historical linked tickets alone do not establish full coverage.`;
    if(row.status==='monitoring')return `Continue observation through ${date(row.after_end)}. Review new matches as they arrive; score only when the full window is available.`;
    if(row.status==='insufficient_baseline')return 'Try a longer comparison window with full history. Verify the incident family before drawing conclusions from a small baseline.';
    if(row.after_count>0)return 'Validate the candidate recurrences with the service owner. If the same mechanism returned, reassess the RCA and corrective action before closing the loop.';
    return 'No matching recurrence was observed in this window. Confirm the fix evidence with the service owner and continue monitoring over a longer period.';
  }
  function renderDetail(row) {
    const score=row.score,partial=row.before_count!=null&&(!row.baseline_covered||!row.post_covered);
    const movement=row.rate_change_percent==null?'A fair comparison is not yet available.':row.rate_change_percent<0?`${Math.abs(row.rate_change_percent)}% more candidate incidents after closure.`:`${row.rate_change_percent}% fewer candidate incidents after closure.`;
    $('effect-detail').innerHTML=`<article class="panel effect-score-panel"><div class="panel-heading"><div><span class="eyebrow">OBSERVED EFFECTIVENESS</span><h2>${esc(row.id)}</h2></div>${badge(row)}</div><h3 class="effect-problem-title">${esc(row.title||'Untitled problem')}</h3><p class="effect-problem-context">${esc(row.company||'Company not recorded')} · ${esc(row.service||row.ci||'Context not recorded')}</p><div class="effect-score-ring ${score==null?'unscored':''}" style="--score:${score||0}"><div><strong>${score==null?'—':score}</strong><span>${score==null?'Not scored':'out of 100'}</span></div></div><p class="effect-score-caption">${score==null?'Evidence before a verdict.':'Observed recurrence reduction'}</p><p class="effect-score-reason">${esc(row.reason)}</p>${row.scoring_requirements?`<div class="effect-requirements"><h3>Evidence needed for a score</h3><ul>${row.scoring_requirements.map(check=>`<li><span class="effect-check ${check.met===true?'met':check.met===false?'missing':'pending'}">${check.met===true?icon('check'):check.met===false?icon('close'):icon('clock')}</span><span>${esc(check.label)}<small>${check.met===true?'Available':check.met===false?'Missing / incomplete':'Cannot assess yet'}</small></span></li>`).join('')}</ul></div>`:''}<dl class="effect-facts"><div><dt>Assignment group</dt><dd>${esc(row.owner||'Not recorded')}</dd></div><div><dt>Problem closed</dt><dd>${esc(date(row.closed,true))}</dd></div><div><dt>Recorded cause category</dt><dd>${esc(row.cause||'Not recorded')}</dd></div><div><dt>Matching basis</dt><dd>${esc(row.anchor_basis)}</dd></div></dl></article>
    <article class="panel effect-trend-panel"><div class="panel-heading"><div><h2>Incident recurrence around closure</h2><p>${row.window_days} days on each side · daily candidate incident counts</p></div><span class="tag">${esc(row.monitored_days)} / ${row.window_days} days followed</span></div><div class="effect-comparison"><div><span>Before closure</span><strong>${count(row.before_count)}</strong><small>${row.before_rate!=null?`${row.before_rate} per week`:partial?'Partial observed count':'Baseline candidates'}</small></div><span class="effect-compare-arrow">${icon('arrow')}</span><div><span>After closure</span><strong>${count(row.after_count)}</strong><small>${row.after_rate!=null?`${row.after_rate} per week`:partial?'Partial observed count':'Observed candidates'}</small></div><div class="effect-movement"><strong>${row.rate_change_percent==null?'Comparison pending':row.rate_change_percent<0?'Recurrence increased':row.rate_change_percent===0?'No recurrence reduction':row.after_count===0?'No recurrence observed':'Recurrence reduced'}</strong><p>${esc(movement)}</p></div></div>${trend(row)}<div class="effect-follow-up"><span>${icon('arrow')}</span><div><strong>Recommended follow-up</strong><p>${esc(nextStep(row))}</p></div></div><div class="effect-secondary-stats"><span>First candidate recurrence <strong>${row.first_recurrence_days==null?'Not observed':`${row.first_recurrence_days} days after closure`}</strong></span><span>High-priority candidates after closure <strong>${number(row.high_priority_after)}</strong></span></div></article>
    <article class="panel effect-evidence"><div class="panel-heading"><div><h2>Inspect the matching incidents</h2><p>Potential recurrences require validation against the failure mechanism. Similarity alone does not confirm the same cause.</p></div><span class="tag">${row.match_total||0} matches in comparison windows</span></div>${row.matches.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th scope="col">INCIDENT</th><th scope="col">CREATED</th><th scope="col">PERIOD</th><th scope="col">RELATIONSHIP</th><th scope="col">SYMPTOM MATCH</th></tr></thead><tbody>${row.matches.map(m=>`<tr><td><button class="ticket-link" data-incident="${esc(m.id)}" data-company="${esc(row.company)}">${esc(m.id)}</button><div class="ticket-title" title="${esc(m.title)}">${esc(m.title)}</div></td><td>${esc(date(m.created,true))}</td><td><span class="status-badge ${m.period==='After closure'?'warning':'neutral'}">${esc(m.period)}</span></td><td>${esc(m.relation)}</td><td>${m.relation==='Explicit first-reported incident'?'Exact record link':Number(m.similarity).toFixed(3)}</td></tr>`).join('')}</tbody></table></div>${row.match_total>row.matches.length?`<p class="field-help">Showing ${row.matches.length} of ${row.match_total} matches. Trend and totals include every match.</p>`:''}`:empty('No matching incidents were found in the available comparison windows. Missing history remains unknown.','No observed matches')}</article>`;
  }
  async function selectProblem(id) {
    selected=id;renderTable();const serial=++detailRequest;
    $('effect-detail').innerHTML='<div class="panel effect-detail-loading" role="status">Loading problem trend…</div>';
    try {
      const data=await api(`/api/effectiveness/${encodeURIComponent(id)}?window_days=${windowDays()}`);
      if(serial!==detailRequest)return;
      renderDetail(data);
    }catch(e){if(serial===detailRequest)$('effect-detail').innerHTML=`<div class="panel alert error" role="alert">${esc(e.message)} Select the problem again to retry.</div>`;}
  }
  async function load(force=false) {
    if(loading&&!force)return;
    if(dataset&&!force)return;
    const serial=++request;++detailRequest;loading=true;
    error('effect-error','');show('effect-loading');show('effect-results',false);
    $('effect-refresh').disabled=true;
    try {
      const data=await api(`/api/effectiveness?window_days=${windowDays()}&company=${encodeURIComponent($('effect-company').value)}`);
      if(serial!==request)return;
      dataset=data;page=0;renderSummary();show('effect-results');
      selected=data.problems.some(r=>r.id===selected)?selected:data.problems[0]?.id;
      if(selected)await selectProblem(selected);else $('effect-detail').innerHTML=empty('Choose another company scope.','No problems in this scope');
    }catch(e){if(serial===request)error('effect-error',`${e.message} Use Refresh to retry.`);}
    finally {if(serial===request){loading=false;show('effect-loading',false);$('effect-refresh').disabled=false;}}
  }
  ['effect-window','effect-company'].forEach(id=>$(id).addEventListener('change',()=>load(true)));
  $('effect-refresh').addEventListener('click',()=>load(true));
  $('effect-show-method').addEventListener('click',()=>{const method=$('effectiveness-method');method.open=true;method.scrollIntoView?.({behavior:'smooth',block:'start'});});
  $('effect-search').addEventListener('input',()=>{page=0;if(dataset)renderTable();});
  $('effect-prev').addEventListener('click',()=>{page--;renderTable();});$('effect-next').addEventListener('click',()=>{page++;renderTable();});
  screen.addEventListener('click',event=>{
    const target=event.target.closest('[data-effect-filter],[data-effect-problem]');if(!target)return;
    if(target.dataset.effectFilter){chosenFilter=true;filter=target.dataset.effectFilter;page=0;screen.querySelectorAll('[data-effect-filter]').forEach(b=>{const active=b.dataset.effectFilter===filter;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});if(dataset)renderTable();if(filter.startsWith('reason:'))screen.querySelector('.effect-register').scrollIntoView?.({behavior:'smooth',block:'start'});}
    else selectProblem(target.dataset.effectProblem);
  });
  window.RCAEffectiveness={load};
  if(location.hash==='#effectiveness')load();
})();
