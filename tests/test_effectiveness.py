"""Outcome scoring must abstain on missing coverage, not reward a missing dataset."""
from fastapi.testclient import TestClient

from coremind import api
from coremind.effectiveness import EffectivenessTracker
from test_rca import engine, row


def record(kind, ticket, created, **fields):
    result = row(kind, ticket, ci='DB1', service='Database', group='Ops')
    result.update(created=created, **fields)
    return result


def tracker(before=3, after=1):
    rows = [record('incident', 'INC0', '2026-09-01T00:00:00+00:00')]
    rows[0]['ci'] = 'UNRELATED'
    rows[0]['service'] = 'Other'
    for i in range(before):
        rows.append(record('incident', f'INC{i+1}', f'2026-09-{25+i:02d}T12:00:00+00:00'))
    for i in range(after):
        rows.append(record('incident', f'INC{20+i}', f'2026-10-{2+i:02d}T12:00:00+00:00', priority='1'))
    rows.append(record('problem', 'PRB1', '2026-09-01T00:00:00+00:00',
                       closed='2026-10-01T00:00:00+00:00', state='Closed', incident='INC1'))
    model = engine(rows)
    model.bundle['manifest']['source_profile'] = {'snow_Incident_DnA': {
        'retained': len(rows)-1, 'truncated': False, 'date_parse_failures': {'created': 0}}}
    return EffectivenessTracker(model)


def measured(t, days=7):
    return t.results(days)['PRB1']


def test_equal_window_score_and_actual_increase():
    result = measured(tracker())
    assert result['score'] == 67
    assert result['rate_change_percent'] == 66.7
    assert result['before_count'] == 3 and result['after_count'] == 1
    assert result['first_recurrence_days'] == 1.5
    assert result['high_priority_after'] == 1
    worse = measured(tracker(3, 4))
    assert worse['score'] == 0 and worse['status'] == 'increased'
    assert worse['rate_change_percent'] < 0
    assert measured(tracker(3, 0))['score'] == 100
    assert measured(tracker(3, 3))['status'] == 'unchanged'


def test_short_follow_up_and_small_baseline_are_not_scored():
    assert measured(tracker(), 14)['status'] == 'monitoring'
    assert measured(tracker(2, 0))['status'] == 'insufficient_baseline'
    t = tracker()
    t.problems['PRB1']['state'] = 'Root Cause Analysis'
    assert measured(t)['status'] == 'awaiting_closure'


def test_historical_link_does_not_extend_continuous_coverage():
    t = tracker()
    profile = t.manifest['source_profile']['snow_Incident_DnA']
    profile.update(retained=2, truncated=True)
    t = EffectivenessTracker(t.engine)
    assert t.coverage_start.isoformat() == '2026-09-27T12:00:00+00:00'
    result = measured(t)
    assert result['status'] == 'insufficient_history' and result['score'] is None


def test_matching_excludes_cross_company_wrong_context_and_future_incidents():
    t = tracker()
    extras = [record('incident', 'INC50', '2026-10-03T00:00:00+00:00', company='B'),
              record('incident', 'INC51', '2026-10-03T00:00:00+00:00'),
              record('incident', 'INC52', '2026-10-15T00:00:00+00:00')]
    extras[1].update(ci='OTHER', service='Unrelated')
    model = engine(t.engine.records + extras)
    model.bundle['manifest'] = t.manifest
    result = measured(EffectivenessTracker(model))
    assert result['after_count'] == 1
    assert not {'INC50','INC51','INC52'} & {r['id'] for r in result['matches']}


def test_closure_boundary_and_unobserved_buckets():
    t = tracker()
    extra = record('incident', 'INC60', '2026-10-01T00:00:00+00:00')
    model = engine(t.engine.records + [extra]); model.bundle['manifest'] = t.manifest
    result = measured(EffectivenessTracker(model))
    assert result['after_count'] == 2 and result['before_count'] == 3
    assert result['first_recurrence_days'] == 0
    pending = measured(tracker(),14)
    assert any(d['count'] is None for d in pending['daily'])


def test_missing_company_and_unknown_coverage_do_not_produce_score():
    t = tracker(); t.problems['PRB1']['company'] = ''
    assert measured(t)['score'] is None
    t = tracker(); t.manifest['source_profile'] = {}
    assert measured(EffectivenessTracker(t.engine))['score'] is None
    t = tracker(); t.manifest['source_profile']['snow_Incident_DnA']['date_parse_failures']['created'] = 1
    assert measured(EffectivenessTracker(t.engine))['score'] is None


def test_effectiveness_api_filters_validation_and_missing_problem(monkeypatch):
    t = tracker(); monkeypatch.setattr(api, 'engine', t.engine)
    client = TestClient(api.app)
    response = client.get('/api/effectiveness', params={'window_days':7})
    assert response.status_code == 200
    assert response.json()['summary']['average_score'] == 67
    assert client.get('/api/effectiveness', params={'company':'B'}).json()['problems'] == []
    detail = client.get('/api/effectiveness/prb1', params={'window_days':7})
    assert detail.status_code == 200 and detail.json()['match_total'] == 4
    assert client.get('/api/effectiveness/UNKNOWN').status_code == 404
    assert client.get('/api/effectiveness', params={'window_days':8}).status_code == 422
    assert client.get('/').headers['cache-control'] == 'no-store'


def test_coverage_losses_and_undated_incidents_withhold_scores():
    t = tracker()
    t.manifest['source_profile']['snow_Incident_DnA']['duplicate_or_missing_ids'] = 1
    assert measured(EffectivenessTracker(t.engine))['score'] is None
    t = tracker()
    t.engine.incidents['INC0']['created'] = None
    assert measured(EffectivenessTracker(t.engine))['score'] is None


def test_summary_deduplicates_incidents_across_problem_families():
    t = tracker()
    second = dict(t.problems['PRB1'], id='PRB2', key='problem:PRB2')
    model = engine(t.engine.records + [second]); model.bundle['manifest'] = t.manifest
    summary = EffectivenessTracker(model).overview()['summary']
    assert summary['scored'] == 2
    assert summary['recurrence_candidates'] == 1


def test_unscored_reasons_and_requirements_explain_the_data_gap():
    t = tracker()
    t.manifest['source_profile']['snow_Incident_DnA'].update(retained=2, truncated=True)
    t = EffectivenessTracker(t.engine)
    overview = t.overview()
    assert overview['unscored_reasons'] == {'insufficient_history': 1}
    result = measured(t)
    requirements = {item['label']: item['met'] for item in result['scoring_requirements']}
    assert requirements['Valid problem closure'] is True
    assert requirements['Full 7-day baseline history'] is False
    assert requirements['At least 3 baseline incidents'] is None
    assert result['before_start'] == '2026-09-24T00:00:00+00:00'
    assert result['after_end'] == '2026-10-08T00:00:00+00:00'
