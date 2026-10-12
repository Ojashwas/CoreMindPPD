from fastapi.testclient import TestClient

from coremind import api
from test_rca import engine, row


def test_api_investigation_and_missing_id(monkeypatch):
    monkeypatch.setattr(api, 'engine', engine([row('incident', 'INC1'), row('problem', 'PRB1', incident='INC1', cause='Network')]))
    client = TestClient(api.app)
    result = client.post('/api/investigate', json={'incident_ids': ['INC1']})
    assert result.status_code == 200
    assert result.json()['root_cause_confirmed'] is False
    missing = client.post('/api/investigate', json={'incident_ids': ['INC999']})
    assert missing.status_code == 422
    assert 'bounded snapshot' in missing.json()['detail']


def test_api_schema_limits_and_incident_search(monkeypatch):
    monkeypatch.setattr(api, 'engine', engine([row('incident', 'INC1')]))
    client = TestClient(api.app)
    assert client.post('/api/investigate', json={'query': 'timeout', 'top_k': 100}).status_code == 422
    assert client.get('/api/incidents', params={'search': 'INC1'}).json()[0]['id'] == 'INC1'
    assert client.get('/api/incidents', params={'search': 'nonexistent'}).json() == []


def test_dashboard_is_served():
    result = TestClient(api.app).get('/')
    assert result.status_code == 200
    assert 'Root cause investigation' in result.text


def test_incident_filters_pagination_and_context(monkeypatch):
    first = row('incident', 'INC1', priority='1', state='New', ci='DB1', group='G')
    second = row('incident', 'INC2', priority='2', state='Closed')
    second['company'] = 'B'
    monkeypatch.setattr(api, 'engine', engine([first, second]))
    client = TestClient(api.app)
    filtered = client.get('/api/incidents', params={'company': 'A', 'state': 'new', 'priority': '1'}).json()
    assert [r['id'] for r in filtered] == ['INC1']
    assert filtered[0]['state'] == 'New' and filtered[0]['ci'] == 'DB1'
    assert filtered[0]['assignment_group'] == 'G'
    assert len(client.get('/api/incidents', params={'offset': 1, 'limit': 1}).json()) == 1
    assert client.get('/api/incidents', params={'offset': -1}).status_code == 422


def test_workspace_uses_snapshot_counts_links_and_unique_breaches(monkeypatch):
    incident = row('incident', 'INC1', priority='1', state='New', service='Database', group='Operations')
    incident['created'] = '2026-10-07T21:00:00+00:00'  # 8 October in Dubai
    problem = row('problem', 'PRB1', incident='INC1', cause='Network')
    sla1 = row('sla_incident', 'SLA1', task='INC1', breached=True)
    sla2 = row('sla_incident', 'SLA2', task='INC1', breached=True)
    monkeypatch.setattr(api, 'engine', engine([incident, problem, sla1, sla2]))
    result = TestClient(api.app).get('/api/workspace')
    assert result.status_code == 200
    data = result.json()
    assert data['incident_count'] == data['active_incidents'] == data['high_priority_incidents'] == 1
    assert data['incidents_with_observed_sla_breach'] == 1
    assert data['trend'][-1] == {'date': '2026-10-08', 'count': 1}
    assert sum(day['count'] for day in data['trend']) == 1
    assert data['linked_examples'][0]['problem_id'] == 'PRB1'
    assert data['top_services'] == [{'name': 'Database', 'count': 1}]


def test_workspace_does_not_offer_cross_company_linked_examples(monkeypatch):
    problem = row('problem', 'PRB1', incident='INC1', cause='Network')
    problem['company'] = 'B'
    monkeypatch.setattr(api, 'engine', engine([row('incident', 'INC1'), problem]))
    assert TestClient(api.app).get('/api/workspace').json()['linked_examples'] == []


def test_static_assets_are_served():
    client = TestClient(api.app)
    assert client.get('/static/styles.css').status_code == 200
    assert client.get('/static/app.js').status_code == 200
    assert client.get('/static/reading-guide.js').status_code == 200
    assert client.get('/static/reading-guide.css').status_code == 200
