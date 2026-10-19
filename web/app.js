'use strict';

// All operational numbers and evidence come from the loaded Snow snapshot.
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const number = value => new Intl.NumberFormat('en-GB').format(Number(value) || 0);
const percent = value => value == null ? 'Unavailable' : `${(Number(value) * 100).toFixed(1)}%`;
const bounded = value => Math.min(1, Math.max(0, Number(value) || 0));
const human = value => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const views = {overview:'Overview', investigations:'Investigations', incidents:'Incident explorer', health:'Data & model health', effectiveness:'RCA effectiveness', guide:'How to read results'};
const state = {manifest:null, workspace:null, report:null, history:[], currentHistory:null, rows:[],
  selected:new Map(), page:0, pageSize:20, nextPage:false, incidentRequest:0, requestController:null,
  running:false, checked:new Set(), clusterName:''};

function date(value, withTime=false) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Dubai', day:'2-digit', month:'short', year:'numeric',
    ...(withTime ? {hour:'2-digit', minute:'2-digit', hourCycle:'h23'} : {})}).format(new Date(value));
}
function show(id, visible=true) { $(id).classList.toggle('hidden', !visible); }
function notify(message) { $('toast').textContent=message; show('toast'); clearTimeout(notify.timer); notify.timer=setTimeout(()=>show('toast',false),4000); }
function error(id, message) { $(id).textContent=message; show(id, Boolean(message)); }
function empty(message, heading='Nothing to show yet') { return `<div class="no-results"><strong>${esc(heading)}</strong>${esc(message)}</div>`; }
function metric(label, value, note, glyph='activity', tone='') {
  return `<article class="metric-card"><div class="metric-top"><span>${esc(label)}</span><span class="metric-icon ${tone}">${icon(glyph)}</span></div><strong>${typeof value === 'number' ? number(value) : esc(value)}</strong><p>${esc(note)}</p></article>`;
}
async function api(url, options={}) {
  const controller=new AbortController(), upstream=options.signal;
  let timedOut=false;
  const abort=()=>controller.abort();
  if(upstream?.aborted)abort();else upstream?.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(()=>{timedOut=true;controller.abort();},60000);
  try {
    const response=await fetch(url,{...options,signal:controller.signal});
    let payload;
    try { payload=await response.json(); } catch { throw new Error('The server returned an unreadable response. Please refresh the workspace.'); }
    if (!response.ok) {
      const detail=payload.detail;
      throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map(item=>item.msg).join('; ') : 'Unable to complete this request.');
    }
    return payload;
  } catch(e) { if(timedOut)throw new Error('The request timed out. Please retry.');throw e; }
  finally {clearTimeout(timeout);upstream?.removeEventListener('abort',abort);}
}
function navigate(view, focus=false) {
  view=views[view] ? view : 'overview';
  for (const key of Object.keys(views)) show(`view-${key}`, key===view);
  document.querySelectorAll('.nav-item').forEach(button=>{
    const active=button.dataset.view===view;
    button.classList.toggle('active',active);
    if(active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
  document.title=`${views[view]} | Problem detection & RCA`;
  if(location.hash!==`#${view}`) history.replaceState(null,'',`#${view}`);
  if (view==='incidents' && !state.rows.length) loadIncidents();
  if (view==='guide') window.CoreMindGuide?.refresh();
  if (view==='effectiveness') window.RCAEffectiveness?.load();
  if(focus) $('main').focus({preventScroll:true});
}
function selectOptions(id, values, title) {
  const selected=$(id).value;
  $(id).innerHTML=`<option value="">${esc(title)}</option>`+values.map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join('');
  if(values.includes(selected)) $(id).value=selected;
}

function renderTrend(rows) {
  const width=620, height=218, left=42, right=12, top=14, bottom=36;
  const values=rows.map(row=>row.count);
  const max=Math.max(1,...values);
  const ceiling=Math.max(4, Math.ceil(max/4)*4);
  const x=i=>left+i*(width-left-right)/Math.max(1,rows.length-1);
  const y=n=>height-bottom-(n/ceiling)*(height-bottom-top);
  const points=values.map((value,i)=>`${x(i)},${y(value)}`);
  const area=`M${left},${height-bottom} L${points.join(' L')} L${x(values.length-1)},${height-bottom} Z`;
  const grids=Array.from({length:5},(_,i)=>{
    const value=ceiling*i/4;
    return `<line x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}" stroke="var(--line)" stroke-dasharray="3 4"/><text x="${left-10}" y="${y(value)+4}" text-anchor="end">${value>=1000 ? `${+(value/1000).toFixed(1)}k` : value}</text>`;
  }).join('');
  const labels=rows.filter((_,i)=>i%3===0 || i===rows.length-1).map(row=>{
    const i=rows.indexOf(row);
    const label=new Intl.DateTimeFormat('en-GB',{month:'short',day:'2-digit',timeZone:'UTC'}).format(new Date(`${row.date}T00:00:00Z`));
    return `<text x="${x(i)}" y="${height-8}" text-anchor="middle">${esc(label)}</text>`;
  }).join('');
  $('trend-chart').innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="trend-title trend-description"><title id="trend-title">Incident volume in the loaded snapshot</title><desc id="trend-description">${esc(rows.map(row=>`${row.date}: ${row.count} incidents`).join('; '))}</desc><defs><linearGradient id="trend-gradient" x1="0" y1="0" x2="0" y2="1"><stop stop-color="var(--green)" stop-opacity=".23"/><stop offset="1" stop-color="var(--green)" stop-opacity=".01"/></linearGradient></defs>${grids}<path d="${area}" fill="url(#trend-gradient)"/><polyline points="${points.join(' ')}" class="chart-line"/>${rows.map((row,i)=>`<circle cx="${x(i)}" cy="${y(row.count)}" r="3" fill="var(--green)" stroke="var(--surface)" stroke-width="1.5"><title>${esc(row.date)}: ${number(row.count)} incidents</title></circle>`).join('')}${labels}</svg>`;
  $('trend-total').textContent=`${number(values.reduce((a,b)=>a+b,0))} recorded in this period`;
}
function renderPriority(distribution) {
  const entries=Object.entries(distribution).sort(([a],[b])=>a.localeCompare(b));
  const colors=['var(--red)','var(--amber)','var(--cyan)','var(--purple)','var(--blue)','var(--subtle)'];
  const total=entries.reduce((sum,[,n])=>sum+n,0), radius=61, circumference=2*Math.PI*radius;
  let offset=0;
  const segments=entries.map(([label,count],i)=>{
    const length=total ? count/total*circumference : 0;
    const segment=`<circle cx="90" cy="90" r="${radius}" fill="none" stroke="${colors[i%colors.length]}" stroke-width="13" stroke-dasharray="${Math.max(0,length-2)} ${circumference}" stroke-dashoffset="${-offset}" transform="rotate(-90 90 90)"><title>${esc(label)}: ${number(count)}</title></circle>`;
    offset+=length; return segment;
  }).join('');
  $('priority-chart').innerHTML=`<svg viewBox="0 0 180 180" role="img" aria-label="Priority distribution, ${number(total)} incidents"><circle cx="90" cy="90" r="61" fill="none" stroke="var(--line)" stroke-width="13"/>${segments}<text x="90" y="89" text-anchor="middle" class="donut-value">${number(total)}</text><text x="90" y="107" text-anchor="middle" class="donut-label">incidents</text></svg>`;
  $('priority-legend').innerHTML=entries.map(([label,count],i)=>`<span class="legend-entry"><i class="legend-dot" style="background:${colors[i%colors.length]}"></i>${esc(/^\d$/.test(label)?`P${label}`:label)}<b>${number(count)}</b></span>`).join('');
}
function bars(id, items, tone='') {
  if(!items.length){ $(id).innerHTML='<p class="empty-inline">No recorded values available for this scope.</p>'; return; }
  const max=Math.max(1,...items.map(item=>item.count));
  $(id).innerHTML=items.map(item=>`<div class="service-item"><div class="bar-heading"><span title="${esc(item.name)}">${esc(item.name)}</span><b>${number(item.count)}</b></div><div class="bar-track"><div class="bar-fill ${tone}" style="width:${item.count/max*100}%"></div></div></div>`).join('');
}
function priorityTag(value) { const n=String(value||'').match(/^(?:p)?([1-5])/i)?.[1]; return `<span class="priority-tag ${n ? `p${n}` : ''}">${esc(n ? `P${n}` : value || 'Unknown')}</span>`; }
function incidentTable(rows, selectable=false) {
  if(!rows.length) return empty('Try a different search or remove filters.','No matching incidents');
  return `<table class="data-table"><thead><tr>${selectable?'<th scope="col">Select</th>':''}<th scope="col">INCIDENT</th><th scope="col">COMPANY</th><th scope="col">PRIORITY</th><th scope="col">STATE</th><th scope="col">CREATED</th><th scope="col">ACTION</th></tr></thead><tbody>${rows.map(row=>`<tr>${selectable?`<td><input type="checkbox" class="selection-checkbox" data-select-incident="${esc(row.id)}" aria-label="Select ${esc(row.id)}" ${state.selected.has(row.id)?'checked':''}></td>`:''}<td class="ticket-cell"><button class="ticket-link" data-incident="${esc(row.id)}" data-company="${esc(row.company)}">${esc(row.id)}</button><div class="ticket-title" title="${esc(row.title)}">${esc(row.title||'Untitled incident')}</div></td><td>${esc(row.company||'Not recorded')}</td><td>${priorityTag(row.priority)}</td><td><span class="status-badge muted-badge">${esc(row.state||'Unknown')}</span></td><td class="table-muted">${esc(date(row.created))}</td><td><button class="button text" data-incident="${esc(row.id)}" data-company="${esc(row.company)}" aria-label="Investigate ${esc(row.id)}">Investigate${icon('arrow')}</button></td></tr>`).join('')}</tbody></table>`;
}
function renderOverview(workspace, manifest, recent) {
  $('overview-metrics').innerHTML=[metric('Incidents in scope',workspace.incident_count,'Including historical linked incidents','layers','blue'),metric('Active incidents',workspace.active_incidents,'New, open, in progress, or on hold','activity'),metric('High priority incidents',workspace.high_priority_incidents,'Recorded priority 1 or 2','alert','orange'),metric('Problem records',workspace.record_counts.problem||0,`${number(manifest.labeled_closed_problems)} eligible closed cause labels`,'book','purple')].join('');
  renderTrend(workspace.trend); renderPriority(workspace.priority_distribution);
  bars('service-bars',workspace.top_services.slice(0,5));
  $('linked-examples').innerHTML=workspace.linked_examples.length ? workspace.linked_examples.slice(0,3).map(row=>`<button class="example-card" data-incident="${esc(row.incident_id)}" data-company="${esc(row.company)}"><span class="example-icon">${icon('link')}</span><span class="example-copy"><strong>${esc(row.incident_id)}</strong><p>${esc(row.title)}</p><small>Linked to ${esc(row.problem_id)}</small></span>${icon('chevron')}</button>`).join('') : '<p class="empty-inline">No incident-to-problem relationships available in this snapshot.</p>';
  document.querySelector('[data-action="example"]').disabled=!workspace.linked_examples.length;
  $('recent-table').innerHTML=incidentTable(recent.slice(0,5));
  ['trend-chart','priority-chart','service-bars','linked-examples'].forEach(id=>$(id).classList.remove('skeleton'));
}
function renderHealth(manifest) {
  const profile=manifest.source_profile||{}, metrics=manifest.metrics||{};
  const populated=Object.values(profile).filter(row=>row.retained>0).length;
  $('health-metrics').innerHTML=[metric('Indexed ticket documents',manifest.indexed_documents,'Symptom retrieval corpus','layers','blue'),metric('Eligible cause labels',manifest.labeled_closed_problems,'Closed problem records','book','purple'),metric('Top-3 holdout accuracy',percent(metrics.top3_accuracy),'Retrospective evaluation','chart'),metric('Populated source tables',`${populated} / ${Object.keys(profile).length}`,'Empty sources remain visible','server','orange')].join('');
  const validation=[['Top-1 accuracy',percent(metrics.accuracy)],['Top-3 accuracy',percent(metrics.top3_accuracy)],['Majority-class baseline',percent(metrics.majority_baseline_accuracy)],['Macro F1',metrics.macro_f1==null?'Unavailable':metrics.macro_f1.toFixed(3)],['Training / holdout records',`${number(metrics.training)} / ${number(metrics.holdout)}`]];
  $('validation-results').innerHTML=validation.map(([label,value],i)=>`<div class="validation-metric ${i===4?'small-metric':''}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
  $('validation-limit').textContent=metrics.limitation||'Not enough labels are available to evaluate this classifier.';
  bars('label-distribution',Object.entries(manifest.cause_distribution||{}).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count).slice(0,8),'purple-bar');
  $('coverage-table').innerHTML=`<table class="data-table"><thead><tr><th scope="col">SOURCE TABLE</th><th scope="col">RETAINED ROWS</th><th scope="col">COVERAGE</th><th scope="col">DATE PARSE FAILURES</th><th scope="col">LINKED INCIDENTS</th></tr></thead><tbody>${Object.entries(profile).map(([name,row])=>`<tr><td><span class="ticket-link">${esc(name)}</span></td><td>${number(row.retained)}</td><td><span class="status-badge ${!row.retained?'muted-badge':row.truncated?'warning':'success'}">${!row.retained?'Empty':row.truncated?'Bounded sample':'Fully extracted'}</span></td><td>${number(Object.values(row.date_parse_failures||{}).reduce((a,b)=>a+b,0))}</td><td>${row.historical_problem_links ? `${number(row.historical_problem_links.added)} added` : '—'}</td></tr>`).join('')}</tbody></table>`;
  $('model-limitations').innerHTML=(manifest.limitations||[]).map(item=>`<li>${esc(item)}</li>`).join('');
  const provenance=[['Database',manifest.database],['Snapshot cutoff',date(manifest.as_of,true)+' · Dubai'],['Source timezone',manifest.source_timezone_assumption],['Date convention',manifest.date_convention],['Canonical records',number(manifest.records)],['Snapshot hash',manifest.snapshot_sha256]];
  $('snapshot-provenance').innerHTML=provenance.map(([key,value])=>`<dt>${esc(key)}</dt><dd class="${key==='Snapshot hash'?'hash':''}">${esc(value||'Unavailable')}</dd>`).join('');
}
async function loadWorkspace() {
  $('refresh').disabled=true; $('refresh').classList.add('spinning'); error('global-error','');
  try {
    const [manifest,workspace,recent]=await Promise.all([api('/api/status'),api('/api/workspace'),api('/api/incidents?limit=5')]);
    state.manifest=manifest; state.workspace=workspace;
    renderOverview(workspace,manifest,recent); renderHealth(manifest);
    window.CoreMindGuide?.refresh();
    $('snapshot-label').textContent=`As of ${date(manifest.as_of)}`;
    $('connection-label').textContent='Snow snapshot loaded'; $('connection-dot').className='dot';
    selectOptions('company-filter',workspace.companies,'All companies'); selectOptions('state-filter',workspace.states,'All states'); selectOptions('priority-filter',workspace.priorities,'All priorities');
    $('company-options').innerHTML=workspace.companies.map(company=>`<option value="${esc(company)}"></option>`).join('');
    await loadIncidents();
  } catch(e) {
    error('global-error',`${e.message} Use the refresh button to retry.`);
    $('connection-label').textContent='Snapshot unavailable'; $('connection-dot').className='dot failed';
    if(!state.workspace) { document.querySelectorAll('.skeleton').forEach(node=>node.classList.remove('skeleton')); $('snapshot-label').textContent='Snapshot unavailable'; }
  } finally { $('refresh').disabled=false; $('refresh').classList.remove('spinning'); }
}

// Incident explorer: filter requests cannot overwrite newer results.
async function loadIncidents() {
  const request=++state.incidentRequest;
  state.requestController?.abort(); state.requestController=new AbortController();
  const params=new URLSearchParams({search:$('incident-search').value.trim(),company:$('company-filter').value,state:$('state-filter').value,priority:$('priority-filter').value,offset:String(state.page*state.pageSize),limit:String(state.pageSize+1)});
  $('previous-page').disabled=true; $('next-page').disabled=true;
  try {
    const rows=await api(`/api/incidents?${params}`,{signal:state.requestController.signal});
    if(request!==state.incidentRequest) return;
    state.nextPage=rows.length>state.pageSize; state.rows=rows.slice(0,state.pageSize);
    $('incident-table').innerHTML=incidentTable(state.rows,true);
    $('page-label').textContent=state.rows.length ? `Showing ${state.page*state.pageSize+1}–${state.page*state.pageSize+state.rows.length} · loaded snapshot` : 'No incidents match these filters';
    $('previous-page').disabled=state.page===0; $('next-page').disabled=!state.nextPage;
    renderSelection();
  } catch(e) { if(e.name!=='AbortError' && request===state.incidentRequest){ $('incident-table').innerHTML=empty(e.message,'Unable to load incidents'); $('page-label').textContent='Request failed'; error('global-error',e.message); } }
}
function renderSelection() {
  const size=state.selected.size;
  $('investigate-selected').disabled=!size || state.running;
  $('investigate-selected').querySelector('span').textContent=size ? `Investigate ${size} selected` : 'Investigate selected';
  show('selection-summary',Boolean(size));
  $('selection-summary').innerHTML=`<span>${size} incident${size===1?'':'s'} selected across pages</span><button class="button text" data-action="clear-selection">Clear selection</button>`;
}
function startInvestigation(incidentIds=[], company='') {
  if(state.running){notify('Please wait for the current investigation to finish.');return;}
  $('incident-input').value=incidentIds.join(', '); $('company-input').value=company; $('symptom-input').value='';
  state.clusterName=''; show('cluster-context',false); error('form-error',''); renderChips();
  state.report=null; state.currentHistory=null; state.checked=new Set();
  show('report-workspace',false); show('investigation-empty'); renderHistory();
  navigate('investigations'); $('incident-input').focus();
}
function parseIds() { return [...new Set($('incident-input').value.split(/[,\s]+/).filter(Boolean).map(id=>id.toUpperCase()))]; }
function renderChips() {
  $('selection-chips').innerHTML=parseIds().map(id=>`<span class="selection-chip">${esc(id)}<button type="button" data-remove-incident="${esc(id)}" aria-label="Remove ${esc(id)}">${icon('close')}</button></span>`).join('');
}
function validatePayload(payload) {
  if(!payload.query && !payload.incident_ids.length) throw new Error('Enter an incident ID or describe the symptoms to start an investigation.');
  if(payload.incident_ids.length>100) throw new Error('An investigation can include at most 100 incident IDs.');
  if(payload.incident_ids.some(id=>!/^INC\d+$/i.test(id))) throw new Error('Incident IDs must start with INC followed by digits.');
  if(payload.query.length>12000) throw new Error('Keep the symptom description under 12,000 characters.');
  if(payload.company.length>300) throw new Error('Company scope must be under 300 characters.');
  return payload;
}
function importCluster(text, filename) {
  const cluster=JSON.parse(text);
  if(!cluster || Array.isArray(cluster) || typeof cluster!=='object') throw new Error('The cluster file must contain a JSON object.');
  if(cluster.incident_ids!=null && (!Array.isArray(cluster.incident_ids) || cluster.incident_ids.some(id=>typeof id!=='string'))) throw new Error('incident_ids must be an array of incident ID strings.');
  if(cluster.summary!=null && typeof cluster.summary!=='string') throw new Error('summary must be a string.');
  if(cluster.company!=null && typeof cluster.company!=='string') throw new Error('company must be a string.');
  const payload=validatePayload({incident_ids:[...new Set((cluster.incident_ids||[]).map(id=>id.trim().toUpperCase()))],query:(cluster.summary||'').trim(),company:(cluster.company||'').trim()});
  if(state.running) throw new Error('Please wait for the current investigation to finish before importing another cluster.');
  $('incident-input').value=payload.incident_ids.join(', '); $('symptom-input').value=payload.query; $('company-input').value=payload.company;
  state.clusterName=filename; $('cluster-context').textContent=`Imported: ${filename}`; show('cluster-context'); error('form-error',''); renderChips(); navigate('investigations'); notify('Cluster imported. Review the scope and run the investigation.');
}
async function runInvestigation(event) {
  event?.preventDefault(); if(state.running) return;
  error('form-error','');
  let payload;
  try { payload=validatePayload({query:$('symptom-input').value.trim(),incident_ids:parseIds(),company:$('company-input').value.trim()}); }
  catch(e){ error('form-error',e.message); return; }
  state.running=true;
  const controls=['incident-input','symptom-input','company-input','run-investigation','import-cluster'];
  controls.forEach(id=>$(id).disabled=true);
  $('run-investigation').querySelector('span').textContent='Investigating...'; $('investigation-form').setAttribute('aria-busy','true');
  show('investigation-empty',false); show('report-workspace',false); show('investigation-loading');
  try {
    const report=await api('/api/investigate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const entry={report,payload,checked:new Set(),clusterName:state.clusterName};
    state.history.unshift(entry); state.history=state.history.slice(0,12); state.currentHistory=entry; state.checked=entry.checked;
    state.report=report; renderReport(report); renderHistory(); notify('Investigation complete. Review the hypotheses and evidence.');
  } catch(e) {
    error('form-error',e.message);
    show('report-workspace',Boolean(state.report)); show('investigation-empty',!state.report);
  } finally {
    state.running=false; controls.forEach(id=>$(id).disabled=false); $('investigation-form').setAttribute('aria-busy','false');
    $('run-investigation').querySelector('span').textContent='Investigate root cause'; show('investigation-loading',false); renderSelection();
  }
}
function renderHistory() {
  $('history-count').textContent=state.history.length; $('session-count').textContent=state.history.length;
  $('session-history').innerHTML=state.history.length ? state.history.map((entry,i)=>`<button class="history-button ${entry===state.currentHistory?'active':''}" data-history="${i}" aria-pressed="${entry===state.currentHistory}"><strong>${esc(entry.report.seed_incident_ids.join(', ')||entry.report.query||'Symptom investigation')}</strong><small>${entry.report.hypotheses.length} hypotheses · ${entry.report.evidence.length} evidence records</small></button>`).join('') : '<p class="empty-inline">Completed investigations appear here for this session.</p>';
}
function restoreHistory(index) {
  if(state.running){notify('Please wait for the current investigation to finish.');return;}
  const entry=state.history[index]; if(!entry) return;
  state.currentHistory=entry; state.report=entry.report; state.checked=entry.checked; state.clusterName=entry.clusterName;
  $('incident-input').value=entry.payload.incident_ids.join(', '); $('symptom-input').value=entry.payload.query; $('company-input').value=entry.payload.company;
  $('cluster-context').textContent=state.clusterName?`Imported: ${state.clusterName}`:''; show('cluster-context',Boolean(state.clusterName));
  error('form-error',''); renderChips(); renderReport(entry.report); renderHistory();
}
function tab(name, focus=false) {
  const allowed=['summary','evidence','impact','timeline']; if(!allowed.includes(name)) return;
  document.querySelectorAll('[data-tab]').forEach(button=>{const selected=button.dataset.tab===name;button.classList.toggle('active',selected);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
  allowed.forEach(key=>show(`report-${key}-panel`,key===name));
  if(focus) $(`tab-${name}`).focus();
}
function evidenceLink(id) { return `<button class="source-link" data-evidence="${esc(id)}">${icon('file')}${esc(id.split(':').slice(1).join(':')||id)}</button>`; }
function renderReport(report) {
  show('report-workspace'); show('investigation-empty',false);
  $('report-title').textContent=report.seed_incident_ids.length ? report.seed_incident_ids.length===1 ? report.seed_incident_ids[0] : `${report.seed_incident_ids.length} incidents · one investigation` : 'Symptom investigation';
  $('report-status').textContent=report.status==='insufficient_causal_evidence'?'Insufficient causal evidence':'Human validation required';
  $('report-status').className=`status-badge ${report.status==='insufficient_causal_evidence'?'muted-badge':'warning'}`;
  $('report-summary').textContent=report.evidence_summary;
  $('report-context').innerHTML=`<span>Company <strong>${esc(report.company_scope||'Unscoped')}</strong></span><span>Snapshot <strong>${esc(date(report.snapshot_as_of))}</strong></span><span>Root cause <strong>Unconfirmed</strong></span>${state.clusterName?`<span>Cluster <strong>${esc(state.clusterName)}</strong></span>`:''}`;
  const stageNames={retrieve_symptoms:'Symptom retrieval',inspect_problem_links:'Problem links',inspect_problem_tasks:'Problem tasks',correlate_changes:'Changes',assess_impact_and_sla:'Impact & SLA',review_hypotheses:'Review'};
  $('execution-trace').innerHTML=report.orchestration_trace.map(item=>`<span class="trace-step">${icon('check')}${esc(stageNames[item.stage]||human(item.stage))}<b>${number(item.result_count)}</b></span>`).join('');
  $('hypothesis-count').textContent=report.hypotheses.length; $('evidence-count').textContent=report.evidence.length;
  $('hypothesis-cards').innerHTML=report.hypotheses.length?report.hypotheses.map((item,i)=>`<article class="panel hypothesis-card ${i===0?'leading':''}"><div class="hypothesis-heading"><div><span class="hypothesis-rank ${i===0?'lead':''}">${i===0?'LEADING HYPOTHESIS':`HYPOTHESIS ${i+1}`}</span><h3>${esc(item.cause_category)}</h3><p>${esc(item.hypothesis)}</p></div><div class="score-block"><strong>${bounded(item.confidence_score).toFixed(2)}</strong><span>evidence score / 1.00</span></div></div><div class="score-track"><i style="width:${bounded(item.confidence_score)*100}%"></i></div><p class="hypothesis-validation">${esc(item.validation)}</p>${(item.recorded_mechanism_statements||[]).map(statement=>`<blockquote class="mechanism-quote">${esc(statement.statement)}<br>${evidenceLink(statement.evidence_id)}</blockquote>`).join('')}<div class="source-links"><span class="tag">${esc(human(item.basis))}</span>${item.evidence_ids.map(evidenceLink).join('')}</div></article>`).join(''):`<article class="panel">${empty('The available records do not establish a defensible causal hypothesis. Inspect the evidence gaps and collect additional signals.','More evidence is needed')}</article>`;
  $('hypothesis-comparison').innerHTML=report.hypotheses.length?`<table class="data-table"><thead><tr><th scope="col">CATEGORY</th><th scope="col">BASIS</th><th scope="col">SCORE</th><th scope="col">SUPPORTING SOURCES</th></tr></thead><tbody>${report.hypotheses.map(item=>`<tr><td>${esc(item.cause_category)}</td><td>${esc(human(item.basis))}</td><td>${bounded(item.confidence_score).toFixed(2)}</td><td>${item.evidence_ids.map(evidenceLink).join(' ')}</td></tr>`).join('')}</tbody></table>`:'<p class="empty-inline">No causal hypotheses available to compare.</p>';
  $('model-leads').innerHTML=report.cause_category_predictions.length?report.cause_category_predictions.map(item=>`<div class="prediction-row"><span>${esc(item.cause_category)}</span><div class="bar-track"><div class="bar-fill purple-bar" style="width:${bounded(item.uncalibrated_model_probability)*100}%"></div></div><b>${percent(item.uncalibrated_model_probability)}</b></div>`).join(''):'<p class="empty-inline">No classifier leads available for these symptoms.</p>';
  $('validation-checklist').innerHTML=report.recommended_actions.map((action,i)=>`<label class="checklist-item ${state.checked.has(i)?'complete':''}"><input type="checkbox" data-check="${i}" ${state.checked.has(i)?'checked':''}><span>${esc(action)}</span></label>`).join('');
  $('checklist-count').textContent=`${state.checked.size} complete`;
  $('evidence-gaps').innerHTML=report.evidence_gaps.map(gap=>`<li>${esc(gap)}</li>`).join('');
  $('evidence-search').value=''; selectOptions('evidence-kind',[...new Set(report.evidence.map(item=>item.kind))],'All record types'); $('evidence-kind').value='';
  renderEvidence(); renderImpact(report.impact_analysis,report.suggested_owners); renderTimeline(report.evidence); tab('summary');
  window.CoreMindGuide?.refresh();
}
function renderEvidence() {
  if(!state.report) return;
  const search=$('evidence-search').value.toLowerCase(), kind=$('evidence-kind').value;
  const rows=state.report.evidence.filter(row=>(!kind || row.kind===kind) && `${row.ticket_id} ${row.title} ${row.excerpt}`.toLowerCase().includes(search));
  $('evidence-table').innerHTML=rows.length?`<table class="data-table"><thead><tr><th scope="col">SOURCE RECORD</th><th scope="col">TYPE</th><th scope="col">RELATIONSHIP</th><th scope="col">SIMILARITY</th><th scope="col">DETAILS</th></tr></thead><tbody>${rows.map(row=>`<tr><td><button class="ticket-link" data-evidence="${esc(row.evidence_id)}">${esc(row.ticket_id)}</button><div class="evidence-table-title" title="${esc(row.title)}">${esc(row.title)}</div></td><td><span class="evidence-kind ${esc(row.kind)}">${esc(human(row.kind))}</span></td><td>${esc(row.relations.map(human).join(', '))}</td><td>${row.symptom_similarity==null?'—':row.symptom_similarity.toFixed(3)}</td><td><button class="button text" data-evidence="${esc(row.evidence_id)}" aria-label="Inspect ${esc(row.ticket_id)}">Inspect${icon('arrow')}</button></td></tr>`).join('')}</tbody></table>`:empty('Change the search or record type filter.','No matching evidence');
}
function renderImpact(impact, owners) {
  $('impact-metrics').innerHTML=[metric('Related incidents',impact.incident_count,'Observed in this scope','layers','blue'),metric('Active incidents',impact.active_incident_count,'Recorded active states','activity'),metric('High priority',impact.high_priority_incidents,'Priority 1 or 2','alert','orange'),metric('Recorded affected users',impact.distinct_recorded_affected_users,'Distinct recorded identifiers','layers','purple'),metric('Observed SLA breaches',impact.incidents_with_observed_sla_breach,'Distinct matched incidents','clock','orange'),metric('Matched SLA rows',impact.sla_rows_matched,'Independently bounded SLA data','file','blue')].join('');
  const entries=values=>Object.entries(values||{}).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
  bars('impact-services',entries(impact.services)); bars('impact-groups',entries(impact.assignment_groups)); bars('impact-cis',entries(impact.configuration_items));
  $('impact-owners').innerHTML=owners.length?owners.map(owner=>`<div class="owner-card"><h3>${esc(owner.name)}</h3><span class="status-badge ${owner.active?'success':'muted-badge'}">${owner.active?'Active group':'Inactive group'}</span><p>${esc(owner.responsibility||owner.capability||'No responsibility description recorded.')}</p></div>`).join(''):'<p class="empty-inline">No matching assignment-group metadata was found.</p>';
  $('impact-scope').innerHTML=[['Observed scope',impact.scope],['Matching rule',impact.matching_rule],['SLA coverage',impact.sla_coverage],['Reported outage hours',`${impact.reported_outage_hours_sum} hours. ${impact.outage_measure_note}`]].map(([label,text])=>`<p><strong>${esc(label)}</strong><br>${esc(text)}</p>`).join('');
}
function renderTimeline(evidence) {
  const valid=evidence.filter(item=>item.created && Number.isFinite(new Date(item.created).getTime())).sort((a,b)=>new Date(a.created)-new Date(b.created));
  $('timeline-count').textContent=`${valid.length} dated records`;
  $('record-timeline').innerHTML=valid.length?valid.map(item=>`<div class="timeline-item ${item.relations.includes('investigation_seed')?'seed':''}"><div class="timeline-date">${esc(date(item.created,true))} · Dubai</div><h3><button class="ticket-link" data-evidence="${esc(item.evidence_id)}">${esc(item.ticket_id)}</button> · ${esc(human(item.kind))}</h3><p>${esc(item.title)}</p></div>`).join(''):empty('No valid creation timestamps were recorded for this evidence.');
}
function openEvidence(id) {
  const item=state.report?.evidence.find(row=>row.evidence_id===id); if(!item) return;
  $('evidence-dialog-title').textContent=item.ticket_id;
  const fields=[['Source table',item.source_table],['Record type',human(item.kind)],['Created',date(item.created,true)],['Service',item.service||'Not recorded'],['Configuration item',item.ci||'Not recorded'],['Assignment group',item.assignment_group||'Not recorded'],['Symptom similarity',item.symptom_similarity==null?'Not scored':item.symptom_similarity.toFixed(4)]];
  $('evidence-detail').innerHTML=`<span class="evidence-kind ${esc(item.kind)}">${esc(human(item.kind))}</span><h3 class="evidence-subject">${esc(item.title||'Untitled record')}</h3><dl class="detail-list">${fields.map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl><div class="drawer-section"><h3>Record excerpt</h3><p class="evidence-excerpt">${esc(item.excerpt||'No text excerpt available.')}</p></div><div class="drawer-section"><h3>Why this record was included</h3><div class="drawer-relations">${item.relations.map(relation=>`<span class="tag">${esc(human(relation))}</span>`).join('')}</div></div>${Object.keys(item.details||{}).length?`<div class="drawer-section"><h3>Recorded evidence details</h3>${Object.entries(item.details).map(([label,value])=>`<div class="drawer-detail-row"><strong>${esc(human(label))}</strong>${esc(typeof value==='object'?JSON.stringify(value):String(value))}</div>`).join('')}</div>`:''}`;
  $('evidence-dialog').showModal();
}
function download(filename, value) {
  if(!value){notify('No report is available to export.');return;}
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const link=document.createElement('a'); link.href=url; link.download=filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  notify('Your JSON export is ready.');
}

// Event delegation keeps dynamic source records and history interactive.
document.addEventListener('click',event=>{
  const target=event.target.closest('button[data-view],button[data-action],button[data-incident],button[data-evidence],button[data-history],button[data-remove-incident],button[data-tab]');
  if(!target) return;
  if(target.dataset.view) navigate(target.dataset.view,true);
  else if(target.dataset.incident) startInvestigation([target.dataset.incident],target.dataset.company||'');
  else if(target.dataset.evidence) openEvidence(target.dataset.evidence);
  else if(target.dataset.history!=null) restoreHistory(Number(target.dataset.history));
  else if(target.dataset.removeIncident){if(state.running)return;$('incident-input').value=parseIds().filter(id=>id!==target.dataset.removeIncident).join(', ');renderChips();}
  else if(target.dataset.tab) tab(target.dataset.tab);
  else if(target.dataset.action==='new-investigation') startInvestigation();
  else if(target.dataset.action==='example'){const example=state.workspace?.linked_examples[0];if(example)startInvestigation([example.incident_id],example.company);}
  else if(target.dataset.action==='clear-selection'){state.selected.clear();document.querySelectorAll('[data-select-incident]').forEach(node=>node.checked=false);renderSelection();}
});
document.addEventListener('change',event=>{
  if(event.target.matches('[data-select-incident]')){
    const node=event.target, row=state.rows.find(row=>row.id===node.dataset.selectIncident);
    if(node.checked && row){if(state.selected.size>=100){node.checked=false;notify('You can select at most 100 incidents.');return;}state.selected.set(row.id,row);}else state.selected.delete(node.dataset.selectIncident);renderSelection();
  }
  if(event.target.matches('[data-check]')){const i=Number(event.target.dataset.check);if(event.target.checked)state.checked.add(i);else state.checked.delete(i);event.target.closest('label').classList.toggle('complete',event.target.checked);$('checklist-count').textContent=`${state.checked.size} complete`;}
});
document.querySelector('.report-tabs').addEventListener('keydown',event=>{
  if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;
  const buttons=[...document.querySelectorAll('[data-tab]')], current=buttons.indexOf(document.activeElement);if(current<0)return;
  event.preventDefault();let next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;tab(buttons[next].dataset.tab,true);
});
$('investigation-form').addEventListener('submit',runInvestigation);
$('incident-input').addEventListener('input',()=>{renderChips();state.clusterName='';show('cluster-context',false);});
$('refresh').addEventListener('click',loadWorkspace);
window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)));
$('close-evidence').addEventListener('click',()=>$('evidence-dialog').close());
$('evidence-dialog').addEventListener('click',event=>{if(event.target===$('evidence-dialog')){const r=$('evidence-dialog').getBoundingClientRect();if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom)$('evidence-dialog').close();}});
$('export-report').addEventListener('click',()=>download(`coremind-rca-${state.report?.seed_incident_ids[0]||'symptoms'}.json`,state.report));
$('export-manifest').addEventListener('click',()=>download('coremind-model-metadata.json',state.manifest));
$('print-report').addEventListener('click',()=>{
  if(!state.report)return;
  const search=$('evidence-search').value,kind=$('evidence-kind').value;
  $('evidence-search').value='';$('evidence-kind').value='';renderEvidence();
  try{window.print();}finally{$('evidence-search').value=search;$('evidence-kind').value=kind;renderEvidence();}
});
$('import-cluster').addEventListener('click',()=>$('cluster-file').click());
$('cluster-file').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  try{if(file.size>256000)throw new Error('Choose a cluster JSON file smaller than 250 KB.');importCluster(await file.text(),file.name);}catch(e){navigate('investigations');error('form-error',e instanceof SyntaxError?'The selected file is not valid JSON.':e.message);}finally{event.target.value='';}
});
let searchTimer;
$('incident-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.page=0;loadIncidents();},250);});
['company-filter','state-filter','priority-filter'].forEach(id=>$(id).addEventListener('change',()=>{state.page=0;loadIncidents();}));
$('clear-filters').addEventListener('click',()=>{clearTimeout(searchTimer);['incident-search','company-filter','state-filter','priority-filter'].forEach(id=>$(id).value='');state.page=0;loadIncidents();});
$('previous-page').addEventListener('click',()=>{if(state.page>0){state.page--;loadIncidents();}});
$('next-page').addEventListener('click',()=>{if(state.nextPage){state.page++;loadIncidents();}});
$('investigate-selected').addEventListener('click',()=>{
  const rows=[...state.selected.values()];const companies=[...new Set(rows.map(row=>row.company).filter(Boolean))];
  if(companies.length>1){notify('Select incidents from one company for a focused investigation.');return;}
  startInvestigation(rows.map(row=>row.id),companies[0]||'');
});
$('evidence-search').addEventListener('input',renderEvidence); $('evidence-kind').addEventListener('change',renderEvidence);
navigate(location.hash.slice(1));
loadWorkspace();
