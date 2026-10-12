import pytest
from sklearn.feature_extraction.text import TfidfVectorizer

from coremind.data import normalize, parse_date, symptom_text
from coremind.model import eligible, evaluate
from coremind.rca import RCAOrchestrator


def row(kind, ticket, **fields):
    return dict(kind=kind, id=ticket, key=f'{kind}:{ticket}', table=f'snow_{kind}',
                title='database connectivity timeout', description='database connection error',
                created='2026-09-01T10:00:00+00:00', company='A', **fields)


def engine(rows):
    docs = [r for r in rows if not r['kind'].startswith('sla') and r['kind'] != 'assignment_group']
    vec = TfidfVectorizer()
    matrix = vec.fit_transform([symptom_text(r) for r in docs])
    return RCAOrchestrator({'records': rows, 'docs': docs, 'vectorizer': vec, 'matrix': matrix,
        'cause_model': None, 'manifest': {'as_of': '2026-10-08T19:59:59+00:00',
        'source_timezone_assumption': 'Asia/Dubai', 'source_profile': {'incident': {'truncated': True}}}})


def test_day_first_dates_are_not_misread_as_future_months():
    assert parse_date('12-08-2026 15:14:26') == '2026-08-12T11:14:26+00:00'
    assert parse_date('2026-08-12T15:14:26Z') == '2026-08-12T15:14:26+00:00'
    assert parse_date('bad date') is None


def test_problem_fix_is_timestamp_not_resolution_evidence():
    p = normalize('problem', {'ticketID': 'PRB1', 'fix': '27-08-2026 10:23:03'})
    assert p['fixed_at'] == '2026-08-27T06:23:03+00:00'
    assert 'resolution' not in p


def test_no_target_or_resolution_features():
    p = row('problem', 'PRB1', cause='Network', resolution='restart secret mechanism', knowledge='private label')
    assert 'Network' not in symptom_text(p)
    assert 'secret' not in symptom_text(p)


def test_redaction_and_user_hashing():
    r = normalize('incident', {'ticketID': 'INC1', 'Description': 'email jane@example.com password=abc123', 'affected_user': 'Jane'})
    assert 'jane@example.com' not in r['description']
    assert 'abc123' not in r['description']
    assert r['affected_user'] != 'Jane'


def test_unclosed_problem_does_not_become_training_label():
    p = row('problem', 'PRB1', cause='Network', closed=None)
    assert not eligible(p, '2026-10-08T19:59:59+00:00')


def test_explicit_problem_link_is_cited_without_confirming_causation():
    e = engine([row('incident', 'INC1', ci='DB1', service='S'),
                row('problem', 'PRB1', incident='INC1', cause='Network')])
    report = e.investigate(incident_ids=['INC1'])
    assert report['hypotheses'][0]['basis'] == 'explicit_problem_link'
    assert report['hypotheses'][0]['evidence_ids'] == ['problem:PRB1']
    assert report['root_cause_confirmed'] is False
    assert 'recorded_cause_code' in next(r for r in report['evidence'] if r['kind'] == 'problem')['details']


def test_recorded_mechanism_is_extracted_and_all_hypotheses_have_valid_citations():
    problem = row('problem', 'PRB1', incident='INC1', cause='Software')
    problem['description'] = 'Failure caused by a stale database connection pool.'
    report = engine([row('incident', 'INC1'), problem]).investigate(incident_ids=['INC1'])
    known = {e['evidence_id'] for e in report['evidence']}
    assert all(set(h['evidence_ids']) <= known for h in report['hypotheses'])
    statement = report['hypotheses'][0]['recorded_mechanism_statements'][0]
    assert statement['statement'] == problem['description']
    assert statement['evidence_id'] == 'problem:PRB1'


def test_company_scope_prevents_cross_company_false_analogy():
    a = row('incident', 'INC1')
    b = row('problem', 'PRB2', cause='Network', incident='INC1')
    b['company'] = 'B'
    report = engine([a, b]).investigate(incident_ids=['INC1'])
    assert not report['hypotheses']
    assert all(r['ticket_id'] != 'PRB2' for r in report['evidence'])


def test_mixed_company_cluster_rejected():
    a, b = row('incident', 'INC1'), row('incident', 'INC2')
    b['company'] = 'B'
    with pytest.raises(ValueError, match='multiple companies'):
        engine([a, b]).investigate(incident_ids=['INC1', 'INC2'])


def test_preceding_change_requires_matching_resource_and_is_only_correlation():
    inc = row('incident', 'INC1', ci='DB1', service='S', group='G')
    change = row('change', 'CHG1', ci='DB1', start='2026-09-01T09:00:00+00:00')
    report = engine([inc, change]).investigate(incident_ids=['INC1'])
    h = report['hypotheses'][0]
    assert h['basis'] == 'temporal_correlation'
    ev = next(e for e in report['evidence'] if e['ticket_id'] == 'CHG1')
    assert ev['details']['time_basis'] == 'planned_start'
    assert ev['details']['causation_proven'] is False


def test_future_and_cancelled_changes_do_not_support_causal_hypotheses():
    inc = row('incident', 'INC1', ci='DB1')
    future = row('change', 'CHG1', ci='DB1', start='2026-09-01T11:00:00+00:00')
    cancelled = row('change', 'CHG2', ci='DB1', start='2026-09-01T09:00:00+00:00', state='Canceled')
    r = engine([inc, future, cancelled]).investigate(incident_ids=['INC1'])
    assert not any(h['basis'] == 'temporal_correlation' for h in r['hypotheses'])


def test_sla_breach_incident_counts_do_not_multiply_on_many_sla_rows():
    r = engine([row('incident', 'INC1', ci='DB1'),
        row('sla_incident', 'SLA1', task='INC1', breached=True),
        row('sla_incident', 'SLA2', task='INC1', breached=True)]).investigate(incident_ids=['INC1'])
    assert r['impact_analysis']['sla_rows_matched'] == 2
    assert r['impact_analysis']['incidents_with_observed_sla_breach'] == 1


def test_oov_query_abstains():
    r = engine([row('incident', 'INC1')]).investigate(query='zzzzquuxxyz')
    assert r['status'] == 'insufficient_causal_evidence'
    assert r['hypotheses'] == []
    assert r['impact_analysis']['incident_count'] == 0


def test_unknown_incident_returns_clear_error():
    with pytest.raises(ValueError, match='absent from the bounded snapshot'):
        engine([row('incident', 'INC1')]).investigate(incident_ids=['INC999'])


def test_no_holdout_training_with_labels_closed_after_boundary():
    records = []
    for i in range(50):
        r = row('problem', f'PRB{i}', cause='Network' if i % 2 else 'Software', closed='2026-10-01T00:00:00+00:00')
        r['created'] = f'2026-08-{i//2+1:02d}T{i%2:02d}:00:00+00:00'
        records.append(r)
    metrics = evaluate(records)
    assert metrics['status'] == 'insufficient_temporal_training_data'
    assert metrics['training'] == 0


def test_multiclass_temporal_evaluation_reports_macro_f1():
    from datetime import datetime, timedelta, timezone
    records = []
    for i in range(60):
        label, words = [('Network', 'packet router switch'), ('Software', 'application version bug'),
                        ('Capacity Related', 'disk memory capacity')][i % 3]
        r = row('problem', f'PRB{i}', cause=label)
        date = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(days=i)
        r.update(created=date.isoformat(), closed=(date + timedelta(hours=1)).isoformat(),
                 description=f'{words} issue signature{i}')
        records.append(r)
    result = evaluate(records)
    assert result['status'] == 'evaluated'
    assert result['training'] == 48 and result['holdout'] == 12
    assert result['macro_f1'] >= .5
    assert result['top3_accuracy'] == 1
