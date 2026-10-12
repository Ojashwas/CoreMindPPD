import argparse
import json

from .config import Settings
from .data import write_json
from .model import build
from .rca import RCAOrchestrator


def main():
    parser = argparse.ArgumentParser(description='CoreMind Workstream 3 RCA')
    commands = parser.add_subparsers(dest='command', required=True)
    build_parser = commands.add_parser('build', help='Read Snow tables, fit retrieval and cause models, evaluate and save')
    build_parser.add_argument('--resume', action='store_true', help='Fit from a complete, local extraction checkpoint')
    investigate = commands.add_parser('investigate', help='Investigate an incident, symptom or Workstream 2 cluster')
    investigate.add_argument('--incident', action='append', default=[])
    investigate.add_argument('--query', default='')
    investigate.add_argument('--company', default='')
    investigate.add_argument('--cluster', help='JSON file with incident_ids, summary and optional company')
    investigate.add_argument('--output', default='artifacts/latest_rca.json')
    serve = commands.add_parser('serve', help='Run the local RCA dashboard and API')
    serve.add_argument('--port', type=int, default=8000)
    commands.add_parser('status', help='Show snapshot and evaluation metadata')
    args = parser.parse_args()
    settings = Settings.load()
    if args.command == 'build':
        if args.resume:
            from .data import TABLES, enrich_linked_incidents, source_signature
            from .model import fit_snapshot
            snapshot = json.loads((settings.artifacts / 'extraction_checkpoint.json').read_text(encoding='utf-8'))
            if set(snapshot['profile']) != {table[0] for table in TABLES.values()}:
                raise ValueError('Extraction checkpoint is incomplete; rerun build without --resume')
            if snapshot['as_of'] != settings.as_of:
                raise ValueError('Extraction checkpoint cutoff differs from RCA_AS_OF; rerun build without --resume')
            if snapshot.get('source') != source_signature(settings):
                raise ValueError('Extraction checkpoint source settings differ; rerun build without --resume')
            records, links = enrich_linked_incidents(settings, snapshot['records'])
            snapshot['profile']['snow_Incident_DnA']['historical_problem_links'] = links
            fit_snapshot(settings, records, snapshot['profile'])
        else:
            build(settings)
    elif args.command == 'serve':
        import uvicorn
        uvicorn.run('coremind.api:app', host='127.0.0.1', port=args.port)
    elif args.command == 'status':
        print((settings.artifacts / 'manifest.json').read_text(encoding='utf-8'))
    else:
        incident_ids, query, company = args.incident, args.query, args.company
        if args.cluster:
            from pathlib import Path
            cluster = json.loads(Path(args.cluster).read_text(encoding='utf-8'))
            incident_ids += cluster.get('incident_ids', [])
            query = query or cluster.get('summary', '')
            company = company or cluster.get('company', '')
        engine = RCAOrchestrator.load(settings.artifacts / 'model.joblib')
        report = engine.investigate(query=query, incident_ids=incident_ids, company=company)
        from pathlib import Path
        write_json(Path(args.output), report)
        print(json.dumps({key: report[key] for key in ('status', 'evidence_summary', 'hypotheses')}, indent=2))
        print(f'Report saved to {args.output}')


if __name__ == '__main__':
    main()
