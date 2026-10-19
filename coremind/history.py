"""Read-only Snow incident backfill scoped to problem closure windows and context."""
from datetime import timedelta
import json
import shutil
from zoneinfo import ZoneInfo

import joblib
import pyodbc

from .data import TABLES, normalize, source_signature, write_json
from .effectiveness import anchor_contexts, norm, stamp
from .rca import RCAOrchestrator

BATCH_SIZE = 40


def plan(engine, days):
    if days not in (7, 14, 30, 90):
        raise ValueError('Choose 7, 14, 30 or 90 days')
    cutoff = stamp(engine.bundle['manifest']['as_of'])
    targets = []
    for problem in engine.records:
        if problem['kind'] != 'problem':
            continue
        closed, created = stamp(problem.get('closed')), stamp(problem.get('created'))
        contexts = anchor_contexts(problem, engine.incidents)
        if (closed and contexts and norm(problem.get('state')) in {'closed', 'resolved'}
                and closed <= cutoff and (not created or closed >= created)):
            targets.append({'id': problem['id'].upper(), 'closed': problem['closed'],
                            'start': (closed - timedelta(days=days)).isoformat(),
                            'end': min(closed + timedelta(days=days), cutoff).isoformat(),
                            'contexts': [list(c) for c in contexts]})
    return sorted(targets, key=lambda r: r['id'])


def query(settings, targets):
    """Values are parameters; only validated schema and allowlisted columns are interpolated."""
    if not targets:
        raise ValueError('A query needs at least one target')
    table, _, mapping = TABLES['incident']
    columns = ', '.join(f'i.[{column}]' for column in dict.fromkeys(mapping.values()))
    values, params = [], []
    for target in targets:
        for company, ci, service, group in target['contexts']:
            values.append('(?, ?, ?, ?, ?, ?)')
            start, end = (stamp(target[k]).astimezone(ZoneInfo(settings.source_timezone)).replace(tzinfo=None)
                          for k in ('start', 'end'))
            params.extend((company, ci, service, group, start, end))
    if len(params) > 2000:
        raise ValueError('Too many query parameters; reduce the target batch size')
    sql = f"""
    WITH targets(company, ci, service, assignment_group, start_at, end_at) AS (
        SELECT * FROM (VALUES {','.join(values)}) v(company, ci, service, assignment_group, start_at, end_at)
    )
    SELECT {columns}
    FROM [{settings.schema}].[{table}] i
    CROSS APPLY (VALUES (COALESCE(TRY_CONVERT(datetime2, i.[created], 105),
        TRY_CONVERT(datetime2, i.[created], 126), TRY_CONVERT(datetime2, i.[created], 103)))) parsed(created_at)
    WHERE EXISTS (
        SELECT 1 FROM targets t
        WHERE LOWER(LTRIM(RTRIM(i.[u_company]))) = t.company
          AND ((t.ci <> '' AND LOWER(LTRIM(RTRIM(i.[Configuration_Item]))) = t.ci)
            OR (t.service <> '' AND t.assignment_group <> ''
                AND LOWER(LTRIM(RTRIM(i.[services]))) = t.service
                AND LOWER(LTRIM(RTRIM(i.[assigned_group]))) = t.assignment_group))
          AND ((parsed.created_at >= t.start_at AND parsed.created_at <= t.end_at)
               OR parsed.created_at IS NULL)
    )
    """
    return sql, params


def run(settings, days=90, resume=False, preview=False):
    model_path = settings.artifacts / 'model.joblib'
    engine = RCAOrchestrator.load(model_path)
    manifest = engine.bundle['manifest']
    if settings.database and settings.database != manifest.get('database'):
        raise ValueError('SQL_DATABASE must match the loaded snapshot database')
    if settings.schema != manifest.get('schema'):
        raise ValueError('SQL_SCHEMA must match the loaded snapshot schema')
    if stamp(settings.as_of) != stamp(manifest['as_of']):
        raise ValueError('RCA_AS_OF must match the loaded snapshot cutoff; rebuild to change cutoff')
    targets = plan(engine, days)
    report = {'problems': len(targets), 'maximum_window_days': days,
              'source_configured': all((settings.server, settings.database, settings.username, settings.password)),
              'start': min((r['start'] for r in targets), default=None),
              'end': max((r['end'] for r in targets), default=None),
              'snapshot_as_of': manifest['as_of']}
    print(json.dumps(report, indent=2), flush=True)
    if preview:
        return report
    if not targets:
        raise ValueError('No closed problems with usable company and resource context')
    connection_string = settings.connection_string()
    checkpoint_path = settings.artifacts / 'history-backfill.joblib'
    signature = {'source': source_signature(settings), 'snapshot': manifest['snapshot_sha256'],
                 'as_of': manifest['as_of'], 'days': days, 'targets': targets}
    state = {'signature': signature, 'completed': 0, 'records': {}, 'coverage': {}}
    if resume:
        state = joblib.load(checkpoint_path)
        if state['signature'] != signature:
            raise ValueError('Backfill checkpoint differs from the current source, plan or snapshot')
    batches = [targets[i:i+BATCH_SIZE] for i in range(0, len(targets), BATCH_SIZE)]
    with pyodbc.connect(connection_string, autocommit=True) as connection:
        connection.timeout = settings.query_timeout
        for batch_number, batch in enumerate(batches):
            if batch_number < state['completed']:
                continue
            cursor = connection.cursor()
            sql, params = query(settings, batch)
            cursor.execute(sql, *params)
            names = [column[0] for column in cursor.description]
            invalid = 0
            while rows := cursor.fetchmany(500):
                for raw in rows:
                    row = normalize('incident', dict(zip(names, raw)), settings.source_timezone)
                    if not row.get('id') or not stamp(row.get('created')):
                        invalid += 1
                        continue
                    previous = state['records'].get(row['key'])
                    if previous is None or (row.get('updated') or '') >= (previous.get('updated') or ''):
                        state['records'][row['key']] = row
            cursor.close()
            for target in batch:
                state['coverage'][target['id']] = dict(target, complete=invalid == 0,
                                                      invalid_source_rows=invalid)
            state['completed'] = batch_number + 1
            temporary = checkpoint_path.with_suffix('.tmp.joblib')
            joblib.dump(state, temporary, compress=3)
            temporary.replace(checkpoint_path)
            print(f'Completed batch {batch_number+1}/{len(batches)}; '
                  f'{len(state["records"])} unique incidents; {invalid} invalid rows in this batch', flush=True)
    # Keep the existing snapshot usable throughout extraction and fitting.
    merged = {r['key']: r for r in engine.records}
    merged.update(state['records'])
    from .model import fit_snapshot
    from dataclasses import replace
    stage = settings.artifacts / 'history-staging'
    staged_settings = replace(settings, artifacts=stage)
    fit_snapshot(staged_settings, list(merged.values()), manifest['source_profile'], state['coverage'])
    previous = settings.artifacts / 'before-history-backfill'
    previous.mkdir(exist_ok=True)
    for name in ('model.joblib', 'manifest.json', 'evaluation.json'):
        source = settings.artifacts / name
        if source.exists():
            shutil.copy2(source, previous / name)
    # The API reads the model bundle; swap that file only after all other files are ready.
    for name in ('manifest.json', 'evaluation.json', 'model.joblib'):
        (stage / name).replace(settings.artifacts / name)
    report.update(incident_rows_loaded=len(state['records']),
                  covered_problems=sum(r['complete'] for r in state['coverage'].values()))
    write_json(settings.artifacts / 'history-backfill-report.json', report)
    print('Backfill complete. Restart RCA to load the new snapshot.', flush=True)
    return report
