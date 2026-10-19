"""Backfill plans and SQL reads must not certify unrelated or incomplete history."""
from dataclasses import replace

import joblib
import pytest

from coremind import history
from coremind.config import Settings
from coremind.effectiveness import EffectivenessTracker
from test_effectiveness import tracker, measured


def settings(tmp_path):
    return replace(Settings.load(), server='test-server', database='test-db',
                   username='test-user', password='test-password', artifacts=tmp_path)


def snapshot(tmp_path):
    t = tracker()
    t.engine.bundle['manifest'].update(database='test-db', schema='Service_Analytics',
                                     snapshot_sha256='base-snapshot')
    joblib.dump(t.engine.bundle, tmp_path / 'model.joblib')
    return t.engine


def test_plan_includes_only_valid_context_and_closure():
    t = tracker(); result = history.plan(t.engine, 90)
    assert len(result) == 1
    assert result[0]['contexts'] == [['a', 'db1', 'database', 'ops']]
    assert result[0]['end'] == t.manifest['as_of']
    assert (history.stamp(result[0]['closed']) - history.stamp(result[0]['start'])).days == 90
    t.problems['PRB1']['state'] = 'New'
    assert history.plan(t.engine,90) == []
    with pytest.raises(ValueError):
        history.plan(t.engine,1)


def test_query_is_parameterized_and_keeps_context_and_dates_together(tmp_path):
    t = tracker(); targets = history.plan(t.engine,7)
    targets[0]['contexts'][0][0] = "a'; DROP TABLE incidents; --"
    sql, params = history.query(settings(tmp_path), targets)
    assert 'DROP TABLE' not in sql
    assert params[0] == "a'; DROP TABLE incidents; --"
    assert 'EXISTS' in sql and 'targets t' in sql
    assert 'parsed.created_at >= t.start_at' in sql
    assert 'parsed.created_at IS NULL' in sql
    assert len(params) == 6


def test_targeted_coverage_is_scoped_to_problem_context_and_window():
    t = tracker()
    t.manifest['source_profile'] = {}
    coverage = history.plan(t.engine,7)[0]
    coverage['complete'] = True
    t.manifest['effectiveness_coverage'] = {'PRB1': coverage}
    assert measured(EffectivenessTracker(t.engine))['score'] == 67
    assert measured(EffectivenessTracker(t.engine),14)['score'] is None
    coverage['contexts'] = [['b','db1','database','ops']]
    assert measured(EffectivenessTracker(t.engine))['score'] is None
    coverage['contexts'] = [['a','db1','database','ops']]
    coverage['complete'] = False
    assert measured(EffectivenessTracker(t.engine))['score'] is None


def test_preview_does_not_connect_and_missing_credentials_stop_sql(tmp_path, monkeypatch):
    snapshot(tmp_path)
    monkeypatch.setattr(history.pyodbc,'connect',lambda *args,**kw: pytest.fail('SQL should not run'))
    config = replace(settings(tmp_path), password='')
    assert history.run(config,preview=True)['source_configured'] is False
    with pytest.raises(ValueError,match='SQL_PASSWORD'):
        history.run(config)


def test_backfill_streams_rows_rebuilds_and_preserves_prior_model(tmp_path, monkeypatch):
    snapshot(tmp_path)
    raw = {'ticketID':'INC99','ticketSubject':'database connectivity timeout',
           'Description':'database connection error','created':'2026-09-26T12:00:00+00:00',
           'u_company':'A','Configuration_Item':'DB1','services':'Database',
           'assigned_group':'Ops','priority':'2'}
    class Cursor:
        description = [(key,) for key in raw]
        sent = False
        def execute(self, sql, *params):
            assert 'SELECT' in sql and 'targets' in sql
        def fetchmany(self, size):
            if self.sent:
                return []
            self.sent = True
            return [tuple(raw.values())]
        def close(self):
            pass
    class Connection:
        timeout = 0
        def __enter__(self):
            return self
        def __exit__(self,*args):
            pass
        def cursor(self):
            return Cursor()
    monkeypatch.setattr(history.pyodbc,'connect',lambda *args,**kw: Connection())
    out = history.run(settings(tmp_path),days=7)
    assert out['incident_rows_loaded'] == 1 and out['covered_problems'] == 1
    refreshed = history.RCAOrchestrator.load(tmp_path/'model.joblib')
    assert 'INC99' in refreshed.incidents
    assert refreshed.bundle['manifest']['effectiveness_coverage']['PRB1']['complete'] is True
    assert (tmp_path/'before-history-backfill/model.joblib').exists()
    original = history.RCAOrchestrator.load(tmp_path/'before-history-backfill/model.joblib')
    assert original.bundle['manifest']['snapshot_sha256'] == 'base-snapshot'
    assert measured(EffectivenessTracker(refreshed))['score'] == 75
