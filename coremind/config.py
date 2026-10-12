from dataclasses import dataclass
from pathlib import Path
from datetime import datetime
import os
import re

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    server: str
    database: str
    username: str
    password: str
    driver: str
    schema: str
    query_timeout: int
    max_rows: int
    artifacts: Path
    source_timezone: str
    as_of: str

    @classmethod
    def load(cls):
        load_dotenv(ROOT / '.env')
        schema = os.getenv('SQL_SCHEMA', 'Service_Analytics')
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', schema):
            raise ValueError('Invalid SQL_SCHEMA identifier')
        as_of = os.getenv('RCA_AS_OF', '2026-10-08T23:59:59+04:00')
        if datetime.fromisoformat(as_of).tzinfo is None:
            raise ValueError('RCA_AS_OF must be an ISO timestamp with an explicit timezone offset')
        return cls(
            os.getenv('SQL_SERVER', ''), os.getenv('SQL_DATABASE', ''),
            os.getenv('SQL_USERNAME', ''), os.getenv('SQL_PASSWORD', ''),
            os.getenv('SQL_DRIVER', 'ODBC Driver 18 for SQL Server'), schema,
            int(os.getenv('SQL_QUERY_TIMEOUT', '120')),
            int(os.getenv('RCA_MAX_ROWS_PER_TABLE', '15000')),
            ROOT / os.getenv('RCA_ARTIFACT_DIR', 'artifacts'),
            os.getenv('RCA_SOURCE_TIMEZONE', 'Asia/Dubai'),
            as_of,
        )

    def connection_string(self):
        if not all((self.server, self.database, self.username, self.password)):
            raise ValueError('Set SQL_SERVER, SQL_DATABASE, SQL_USERNAME and SQL_PASSWORD in .env')
        def escape(value):
            return '{' + value.replace('}', '}}') + '}'
        fields = {'DRIVER': self.driver, 'SERVER': f'tcp:{self.server},1433',
                  'DATABASE': self.database, 'UID': self.username, 'PWD': self.password}
        return ';'.join(f'{key}={escape(value)}' for key, value in fields.items()) + ';Encrypt=yes;TrustServerCertificate=no;Connection Timeout=20;ApplicationIntent=ReadOnly;'
