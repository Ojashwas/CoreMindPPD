"""Query valid incident IDs directly from Snow using the existing .env settings.

Run: python query_incident_ids.py --limit 10
"""
import argparse
from datetime import datetime
import json
from zoneinfo import ZoneInfo

import pyodbc

from coremind.config import Settings
from coremind.data import redact, write_json


def main():
    parser = argparse.ArgumentParser(description='Show recent incident IDs from the Snow SQL table')
    parser.add_argument('--limit', type=int, default=10, help='Number of incidents to display (1-100)')
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error('--limit must be between 1 and 100')

    settings = Settings.load()
    cutoff = datetime.fromisoformat(settings.as_of).astimezone(
        ZoneInfo(settings.source_timezone)
    ).replace(tzinfo=None)
    # Parameterized values; schema is validated by Settings.load(). Source dates are day-first.
    query = f"""
        SELECT TOP (?)
            [ticketID] AS incident_id,
            [state],
            [priority],
            [created],
            LEFT([ticketSubject], 160) AS subject
        FROM [{settings.schema}].[snow_Incident_DnA]
        CROSS APPLY (VALUES (
            COALESCE(
                TRY_CONVERT(datetime2, [created], 105),
                TRY_CONVERT(datetime2, [created], 126),
                TRY_CONVERT(datetime2, [created], 103)
            )
        )) AS parsed(created_at)
        WHERE [ticketID] LIKE 'INC[0-9]%'
          AND parsed.created_at <= ?
        ORDER BY parsed.created_at DESC, [ticketID] DESC
    """
    with pyodbc.connect(settings.connection_string(), autocommit=True) as connection:
        connection.timeout = settings.query_timeout
        cursor = connection.cursor()
        cursor.execute(query, args.limit, cutoff)
        columns = [column[0] for column in cursor.description]
        incidents = [dict(zip(columns, row)) for row in cursor.fetchall()]

    for incident in incidents:
        incident['subject'] = redact(incident['subject'] or '')
    print(f'Live SQL results: {settings.schema}.snow_Incident_DnA')
    print(f'Created-date cutoff: {settings.as_of}\n')
    print(json.dumps(incidents, indent=2, ensure_ascii=False))
    output = settings.artifacts / 'valid_incident_ids.json'
    write_json(output, incidents)
    print(f'\nSaved {len(incidents)} incident(s) to {output}')


if __name__ == '__main__':
    main()
