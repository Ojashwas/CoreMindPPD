from collections import Counter
from datetime import datetime, timedelta
from threading import Lock
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import Settings, ROOT
from .rca import RCAOrchestrator, ids, priority_high

settings = Settings.load()
engine = None
engine_lock = Lock()


def get_engine():
    global engine
    with engine_lock:
        if engine is None:
            path = settings.artifacts / 'model.joblib'
            if not path.exists():
                raise HTTPException(503, 'Build the model first: python -m coremind build')
            engine = RCAOrchestrator.load(path)
    return engine


app = FastAPI(title='CoreMind | Workstream 3 RCA', version='1.0.0')
app.mount('/static', StaticFiles(directory=ROOT / 'web'), name='static')


class Investigation(BaseModel):
    query: str = Field(default='', max_length=12000)
    incident_ids: list[str] = Field(default_factory=list, max_length=100)
    company: str = Field(default='', max_length=300)
    top_k: int = Field(default=12, ge=1, le=30)


@app.get('/', include_in_schema=False)
def dashboard():
    return FileResponse(ROOT / 'web' / 'index.html')


@app.get('/api/status')
def status():
    return get_engine().bundle['manifest']


@app.get('/api/incidents')
def incidents(search: str = Query(default='', max_length=200), limit: int = Query(default=40, ge=1, le=100),
              offset: int = Query(default=0, ge=0), company: str = Query(default='', max_length=300),
              state: str = Query(default='', max_length=100), priority: str = Query(default='', max_length=30)):
    rows = get_engine().incidents.values()
    search = search.casefold()
    rows = [row for row in rows if search in (row['id'] + ' ' + (row.get('title') or '') + ' ' + (row.get('company') or '')).casefold()]
    for field, value in (('company', company), ('state', state), ('priority', priority)):
        if value:
            rows = [row for row in rows if (row.get(field) or '').casefold() == value.casefold()]
    rows.sort(key=lambda row: row.get('created') or '', reverse=True)
    return [{'id': row['id'], 'title': row.get('title', ''), 'company': row.get('company', ''),
             'service': row.get('service', ''), 'priority': row.get('priority', ''), 'state': row.get('state', ''),
             'ci': row.get('ci', ''), 'assignment_group': row.get('group', ''), 'created': row.get('created')}
            for row in rows[offset:offset + limit]]


@app.get('/api/workspace')
def workspace():
    """Aggregate the actual loaded snapshot; never substitute synthetic operational data."""
    model = get_engine()
    rows = list(model.incidents.values())
    counts = Counter(row['kind'] for row in model.records)
    manifest = model.bundle['manifest']
    zone = ZoneInfo(manifest['source_timezone_assumption'])
    end = datetime.fromisoformat(manifest['as_of']).astimezone(zone).date()
    days = [(end - timedelta(days=13-i)).isoformat() for i in range(14)]
    trend = {day: 0 for day in days}
    for row in rows:
        if row.get('created'):
            day = datetime.fromisoformat(row['created']).astimezone(zone).date().isoformat()
            if day in trend:
                trend[day] += 1
    states = Counter(row.get('state') or 'Unknown' for row in rows)
    priorities = Counter(row.get('priority') or 'Unknown' for row in rows)
    services = Counter(row['service'] for row in rows if row.get('service'))
    groups = Counter(row['group'] for row in rows if row.get('group'))
    active = sum(count for name, count in states.items() if name.casefold() in {'new', 'open', 'in progress', 'on hold'})
    breached = set()
    for row in model.records:
        if row['kind'] == 'sla_incident' and row.get('breached'):
            breached.update(ids(row.get('task')) & model.incidents.keys())
    examples = []
    for problem in sorted((r for r in model.records if r['kind'] == 'problem'),
                          key=lambda r: r.get('created') or '', reverse=True):
        if not problem.get('cause') or problem['cause'].casefold() in {'other', 'unknown'}:
            continue
        for ticket in sorted(ids(problem.get('incident')) & model.incidents.keys()):
            incident = model.incidents[ticket]
            if (incident.get('company') or '').casefold() != (problem.get('company') or '').casefold():
                continue
            examples.append({'incident_id': ticket, 'problem_id': problem['id'], 'title': incident.get('title', ''),
                             'company': incident.get('company', '')})
        if len(examples) >= 6:
            break
    return {'incident_count': len(rows), 'active_incidents': active,
            'high_priority_incidents': sum(priority_high(row.get('priority')) for row in rows),
            'incidents_with_observed_sla_breach': len(breached), 'record_counts': dict(counts),
            'trend': [{'date': day, 'count': trend[day]} for day in days],
            'state_distribution': dict(states), 'priority_distribution': dict(priorities),
            'top_services': [{'name': name, 'count': n} for name, n in services.most_common(6)],
            'top_assignment_groups': [{'name': name, 'count': n} for name, n in groups.most_common(6)],
            'companies': sorted({row['company'] for row in rows if row.get('company')}),
            'states': sorted(states), 'priorities': sorted(priorities),
            'linked_examples': examples[:6], 'as_of': manifest['as_of'],
            'scope_note': 'Counts describe the bounded loaded snapshot. SLA coverage is independently bounded.'}


@app.post('/api/investigate')
def investigate(request: Investigation):
    try:
        return get_engine().investigate(**request.model_dump())
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
