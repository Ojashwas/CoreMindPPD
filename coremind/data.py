"""Allowlisted SELECT-only extraction and canonical Snow data contract."""
from datetime import datetime, timezone
from collections import Counter
import hashlib
import html
import json
import re
from zoneinfo import ZoneInfo

import pyodbc

TABLES = {
    'incident': ('snow_Incident_DnA', 'created', {
        'id': 'ticketID', 'title': 'ticketSubject', 'description': 'Description',
        'service': 'services', 'ci': 'Configuration_Item', 'group': 'assigned_group',
        'company': 'u_company', 'category': 'u_category', 'subcategory': 'u_subcategory',
        'priority': 'priority', 'state': 'state', 'created': 'created', 'updated': 'updated',
        'closed': 'closed', 'resolved': 'resolved_at', 'resolution': 'resolution_code',
        'location': 'location', 'affected_user': 'affected_user', 'parent': 'parent_incident',
        'case': 'CaseNumber', 'impact': 'impact', 'urgency': 'urgency',
        'outage_start': 'Outage_start', 'outage_end': 'Outage_end', 'reopens': 'reopen_count'}),
    'problem': ('snow_Problem_DnA', 'created', {
        'id': 'ticketID', 'title': 'ticketSubject', 'description': 'description',
        'service': 'services', 'ci': 'cmdb_ci', 'group': 'assignment_group',
        'company': 'u_company', 'category': 'u_category', 'subcategory': 'subcategory',
        'priority': 'priority', 'state': 'state', 'created': 'created', 'updated': 'updated',
        'closed': 'closed', 'cause': 'cause_code', 'fixed_at': 'fix',
        'incident': 'first_reported_by_task', 'change': 'change_request', 'knowledge': 'knowledge'}),
    'problem_task': ('snow_Problem_Task_DnA', 'created', {
        'id': 'ticketID', 'title': 'ticketSubject', 'description': 'description',
        'ci': 'cmdb_ci', 'group': 'assignment_group', 'company': 'company',
        'priority': 'priority', 'state': 'state', 'created': 'created', 'updated': 'updated',
        'cause': 'task_cause_code', 'subcause': 'task_sub_cause_code',
        'resolution': 'close_notes', 'problem': 'problem', 'change': 'change_request'}),
    'change': ('snow_Change_DnA', 'created_on', {
        'id': 'ticketID', 'title': 'short_description', 'description': 'description',
        'service': 'business_service', 'ci': 'cmdb_ci', 'group': 'assignmentGroup',
        'company': 'company', 'category': 'u_category', 'priority': 'priority', 'state': 'state',
        'created': 'created_on', 'updated': 'updated_at', 'closed': 'closed_at',
        'start': 'start_date', 'end': 'end_date', 'actual_start': 'work_start',
        'risk': 'risk', 'risk_analysis': 'risk_impact_analysis', 'resolution': 'close_code'}),
    'case': ('snow_case_DnA', 'created_on', {
        'id': 'ticketID', 'title': 'short_description', 'description': 'description',
        'service': 'services', 'group': 'assignment_group', 'company': 'u_company',
        'category': 'category', 'priority': 'priority', 'state': 'state', 'created': 'created_on',
        'closed': 'closed', 'resolution': 'resolution_notes'}),
    'request': ('snow_RequestedItems_DnA', 'created_on', {
        'id': 'ticketID', 'title': 'short_description', 'description': 'description',
        'service': 'service', 'ci': 'configuration_item', 'group': 'assignment_group',
        'company': 'u_company', 'category': 'task_category', 'priority': 'priority',
        'state': 'state', 'created': 'created_on', 'updated': 'updated_at',
        'closed': 'closed_on', 'parent': 'parent', 'request': 'request'}),
    'catalog_task': ('snow_ServiceCatalog_Task_DnA', 'created_on', {
        'id': 'ticketID', 'title': 'short_description', 'description': 'description',
        'service': 'service', 'ci': 'configuration_item', 'group': 'assignment_group',
        'company': 'u_company', 'category': 'task_category', 'priority': 'priority',
        'state': 'state', 'created': 'created_on', 'updated': 'updated_at',
        'closed': 'closed_on', 'parent': 'parent', 'request': 'request'}),
    'sla_incident': ('snow_SLA_Incident_DnA', 'created', {
        'task': 'task', 'sla': 'sla', 'breached': 'has_breached', 'state': 'stage',
        'group': 'u_breached_assignment_group', 'created': 'created', 'updated': 'updated',
        'start': 'start_time', 'end': 'end_time', 'elapsed': 'business_elapsed_time'}),
    'sla_request': ('snow_SLA_RITMS_DnA', 'created', {
        'task': 'task', 'sla': 'sla', 'breached': 'has_breached', 'state': 'stage',
        'group': 'u_breached_assignment_group', 'created': 'created', 'updated': 'updated',
        'start': 'start_time', 'end': 'end_time', 'elapsed': 'business_elapsed_time'}),
    'assignment_group': ('snow_AssignmentGroup_DnA', None, {
        'id': 'name', 'title': 'name', 'company': 'company', 'active': 'active',
        'capability': 'capability', 'responsibility': 'responsibility', 'domain': 'domain'}),
}
DATES = {'created', 'updated', 'closed', 'resolved', 'fixed_at', 'start', 'end', 'actual_start', 'outage_start', 'outage_end'}
NULLS = {'', 'null', 'none', 'nan', 'n/a', '(empty)', 'undefined'}


def clean(value):
    value = '' if value is None else str(value).strip()
    if value.casefold() in NULLS:
        return ''
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', value))).strip()


def redact(value):
    value = re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[email]', value)
    return re.sub(r'(?i)\b(password|passwd|pwd|secret|token|api[_ -]?key)\s*[:=]\s*\S+', r'\1=[redacted]', value)


def parse_date(value, source_timezone='Asia/Dubai'):
    if not value:
        return None
    value = str(value).strip()
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        parsed = None
        # Verified source convention: day-month-year, not US month-day-year.
        for fmt in ('%d-%m-%Y %H:%M:%S', '%d-%m-%Y', '%d/%m/%Y %H:%M:%S', '%d/%m/%Y', '%Y-%m-%d %H:%M:%S'):
            try:
                parsed = datetime.strptime(value, fmt)
                break
            except ValueError:
                continue
        if parsed is None:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(source_timezone))
    return parsed.astimezone(timezone.utc).isoformat()


def normalize(kind, raw, source_timezone='Asia/Dubai'):
    table, _, mapping = TABLES[kind]
    result = {target: clean(raw.get(source)) for target, source in mapping.items()}
    for key in DATES & result.keys():
        result[key] = parse_date(result[key], source_timezone)
    if kind.startswith('sla_'):
        result['id'] = hashlib.sha256(json.dumps(raw, sort_keys=True, default=str).encode()).hexdigest()[:20]
        result['breached'] = result.get('breached', '').casefold() in {'true', '1', 'yes'}
    if result.get('affected_user'):
        result['affected_user'] = hashlib.sha256(result['affected_user'].casefold().encode()).hexdigest()[:16]
    for key in ('title', 'description', 'resolution', 'risk_analysis', 'knowledge'):
        if key in result:
            result[key] = redact(result[key])[:12000]
    result.update(kind=kind, table=table, key=f'{kind}:{result.get("id", "")}')
    return result


def extract(settings):
    if not 1 <= settings.max_rows <= 100000:
        raise ValueError('RCA_MAX_ROWS_PER_TABLE must be between 1 and 100000')
    records, profile = [], {}
    with pyodbc.connect(settings.connection_string(), autocommit=True) as connection:
        connection.timeout = settings.query_timeout
        cursor = connection.cursor()
        for kind, (table, date, mapping) in TABLES.items():
            columns = ', '.join(f'[{column}]' for column in dict.fromkeys(mapping.values()))
            date_expr = f'COALESCE(TRY_CONVERT(datetime2, [{date}], 105), TRY_CONVERT(datetime2, [{date}], 126), TRY_CONVERT(datetime2, [{date}], 103))' if date else ''
            order = f'{date_expr} DESC, ' if date else ''
            tie = '[ticketID]' if 'id' in mapping and mapping['id'] == 'ticketID' else f'[{next(iter(mapping.values()))}]'
            cutoff = datetime.fromisoformat(settings.as_of).astimezone(ZoneInfo(settings.source_timezone)).replace(tzinfo=None)
            where = f' WHERE {date_expr} <= ? OR {date_expr} IS NULL' if date else ''
            sql = f'SELECT TOP (?) {columns} FROM [{settings.schema}].[{table}]{where} ORDER BY {order}{tie}'
            params = (settings.max_rows + 1, cutoff) if date else (settings.max_rows + 1,)
            cursor.execute(sql, *params)
            names = [item[0] for item in cursor.description]
            rows = cursor.fetchall()
            truncated = len(rows) > settings.max_rows
            raw_rows = [dict(zip(names, row)) for row in rows[:settings.max_rows]]
            normalized = [normalize(kind, row, settings.source_timezone) for row in raw_rows]
            valid = [row for row in normalized if row.get('id')]
            # Source has no declared keys; retain newest version of each ticket.
            latest = {}
            for row in valid:
                old = latest.get(row['key'])
                if old is None or (row.get('updated') or row.get('created') or '') > (old.get('updated') or old.get('created') or ''):
                    latest[row['key']] = row
            records.extend(latest.values())
            date_failures = {target: sum(bool(clean(raw.get(source))) and row.get(target) is None
                                        for raw, row in zip(raw_rows, normalized))
                             for target, source in mapping.items() if target in DATES}
            profile[table] = {'fetched': len(normalized), 'retained': len(latest),
                              'duplicate_or_missing_ids': len(normalized) - len(latest),
                              'truncated': truncated, 'date_parse_failures': date_failures}
            # Checkpoint each completed table so a modeling failure does not require new SQL reads.
            write_json(settings.artifacts / 'extraction_checkpoint.json',
                       {'as_of': settings.as_of, 'source': source_signature(settings),
                        'records': records, 'profile': profile})
            print(f'{table}: {len(latest)} records' + (' (bounded sample)' if truncated else ''), flush=True)
    return records, profile


def symptom_text(record):
    # Never include cause codes, fixes, close notes or knowledge in model features.
    return ' '.join(record.get(key) or '' for key in ('title', 'description', 'service', 'ci', 'category', 'subcategory'))


def source_signature(settings):
    return {'server': settings.server, 'database': settings.database, 'schema': settings.schema,
            'max_rows': settings.max_rows, 'source_timezone': settings.source_timezone}


def enrich_linked_incidents(settings, records):
    """Keep exact historical problem links usable even outside the latest-row sample."""
    existing = {row['id'].upper() for row in records if row['kind'] == 'incident'}
    wanted = sorted({ticket.upper() for row in records if row['kind'] == 'problem'
                     for ticket in re.findall(r'\bINC\d+\b', row.get('incident', ''), re.I)} - existing)
    table, _, mapping = TABLES['incident']
    columns = ', '.join(f'[{column}]' for column in dict.fromkeys(mapping.values()))
    additions = {}
    cutoff = datetime.fromisoformat(settings.as_of).astimezone(timezone.utc).isoformat()
    if wanted:
        with pyodbc.connect(settings.connection_string(), autocommit=True) as connection:
            connection.timeout = settings.query_timeout
            cursor = connection.cursor()
            for offset in range(0, len(wanted), 500):
                batch = wanted[offset:offset + 500]
                placeholders = ','.join('?' for _ in batch)
                cursor.execute(f'SELECT {columns} FROM [{settings.schema}].[{table}] WHERE [ticketID] IN ({placeholders})', *batch)
                names = [item[0] for item in cursor.description]
                for raw in cursor.fetchall():
                    row = normalize('incident', dict(zip(names, raw)), settings.source_timezone)
                    if row.get('created') and row['created'] > cutoff:
                        continue
                    old = additions.get(row['key'])
                    if old is None or (row.get('updated') or '') > (old.get('updated') or ''):
                        additions[row['key']] = row
    print(f'Historical problem-linked incidents added: {len(additions)}', flush=True)
    return records + list(additions.values()), {'requested': len(wanted), 'added': len(additions),
                                               'unmatched_ids': sorted(set(wanted) - {r['id'].upper() for r in additions.values()})}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, default=str), encoding='utf-8')
