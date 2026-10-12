"""Bounded RCA orchestration with source citations and explicit abstention."""
from collections import Counter
from datetime import datetime
import re

import joblib
import numpy as np

from .data import symptom_text, redact


def ids(value):
    if not value:
        return set()
    matches = re.findall(r'\b(?:INC|PRB|CHG|CS|RITM|SCTASK|PTASK)\d+\b', str(value), re.I)
    return {item.upper() for item in matches} or {str(value).strip().upper()}


def same(a, b):
    return bool(a and b and a.strip().casefold() == b.strip().casefold())


def priority_high(value):
    return bool(re.match(r'^(?:[12]\b|p[12]\b|critical\b|high\b)', str(value).casefold()))


def hours_between(a, b):
    return (datetime.fromisoformat(a) - datetime.fromisoformat(b)).total_seconds() / 3600


def excerpt(row):
    text = redact(' '.join(filter(None, (row.get('title'), row.get('description')))))
    return text[:700]


def causal_statement(row):
    """Extract a source statement; do not invent a mechanism from a cause category."""
    pattern = r'\b(due to|caused by|root cause|because of|result of|identified as)\b'
    for sentence in re.split(r'(?<=[.!?])\s+', row.get('description', '')):
        if re.search(pattern, sentence, re.I):
            return redact(sentence)[:350]
    return ''


class RCAOrchestrator:
    def __init__(self, bundle):
        self.bundle = bundle
        self.records = bundle['records']
        self.docs = bundle['docs']
        self.by_key = {row['key']: row for row in self.records}
        self.incidents = {row['id'].upper(): row for row in self.records if row['kind'] == 'incident'}

    @classmethod
    def load(cls, path):
        # Only load the locally generated artifact; joblib is not safe for untrusted files.
        return cls(joblib.load(path))

    def investigate(self, query='', incident_ids=None, company='', top_k=12):
        incident_ids = list(dict.fromkeys(item.upper() for item in (incident_ids or [])))
        if len(incident_ids) > 100:
            raise ValueError('A Workstream 2 cluster may contain at most 100 incident IDs')
        missing = [item for item in incident_ids if item not in self.incidents]
        if missing:
            raise ValueError('Incident IDs absent from the bounded snapshot: ' + ', '.join(missing[:10]))
        seeds = [self.incidents[item] for item in incident_ids]
        companies = {row.get('company', '').casefold() for row in seeds if row.get('company')}
        if len(companies) > 1:
            raise ValueError('Investigate each company separately; cluster contains multiple companies')
        if company and companies and company.casefold() not in companies:
            raise ValueError('Company does not match the selected incidents')
        company = company or next((row['company'] for row in seeds if row.get('company')), '')
        text = ' '.join([query] + [symptom_text(row) for row in seeds[:10]])[:20000].strip()
        if not text:
            raise ValueError('Supply a symptom description or one or more incident IDs')
        q = self.bundle['vectorizer'].transform([text])
        scores = (self.bundle['matrix'] @ q.T).toarray().ravel()
        seed_keys = {row['key'] for row in seeds}
        ranked = []
        direct_problems = []
        for i, row in enumerate(self.docs):
            if row['key'] in seed_keys:
                continue
            if company and not same(company, row.get('company')):
                continue
            direct = row['kind'] == 'problem' and bool(ids(row.get('incident')) & set(incident_ids))
            if direct:
                direct_problems.append((row, float(scores[i]), True))
            if scores[i] >= .18:
                context = max([0] + [float(same(row.get('ci'), seed.get('ci'))) * .10 +
                                             float(same(row.get('service'), seed.get('service'))) * .04 for seed in seeds])
                ranked.append((row, float(scores[i]), min(1.0, float(scores[i]) + context)))
        ranked.sort(key=lambda item: item[2], reverse=True)
        similar = [(row, sim, False) for row, sim, _ in ranked[:top_k]]
        problems = direct_problems[:]
        for row, sim, _ in ranked:
            if row['kind'] == 'problem' and sim >= .25 and row['key'] not in {p[0]['key'] for p in problems}:
                problems.append((row, sim, False))
            if len(problems) >= 6:
                break
        evidence = {}

        def cite(row, relation, similarity=None, details=None):
            key = row['key']
            if key not in evidence:
                evidence[key] = {'evidence_id': key, 'ticket_id': row['id'], 'source_table': row['table'],
                                 'kind': row['kind'], 'title': row.get('title', ''), 'excerpt': excerpt(row),
                                 'created': row.get('created'), 'service': row.get('service', ''),
                                 'ci': row.get('ci', ''), 'assignment_group': row.get('group', ''),
                                 'relations': [], 'details': {}}
            if relation not in evidence[key]['relations']:
                evidence[key]['relations'].append(relation)
            if similarity is not None:
                evidence[key]['symptom_similarity'] = round(similarity, 4)
            evidence[key]['details'].update(details or {})
            return key

        for row in seeds:
            cite(row, 'investigation_seed')
        for row, sim, _ in similar:
            cite(row, 'similar_symptoms', sim)
        for row, sim, direct in problems:
            cite(row, 'explicit_first_reported_incident' if direct else 'historical_problem_similarity', sim,
                 {'recorded_cause_code': row.get('cause', ''), 'cause_status': 'source record label; applicability requires validation'})
            statement = causal_statement(row)
            if statement:
                evidence[row['key']]['details']['recorded_causal_statement'] = statement

        # Problem-task evidence is included only through an exact parent relationship.
        tasks = []
        problem_ids = {row['id'].upper() for row, _, _ in problems}
        for row in self.records:
            if row['kind'] == 'problem_task' and ids(row.get('problem')) & problem_ids:
                if company and row.get('company') and not same(company, row.get('company')):
                    continue
                tasks.append(row)
                cite(row, 'explicit_problem_task', details={'recorded_cause_code': row.get('cause', ''),
                                                         'close_notes': row.get('resolution', '')[:700]})

        # Correlation needs a matching CI or matching service AND group, and a preceding time.
        changes = []
        contexts = seeds or [row for row, _, _ in ranked[:5] if row['kind'] == 'incident']
        for row in self.records:
            if row['kind'] != 'change' or 'cancel' in row.get('state', '').casefold():
                continue
            if company and not same(company, row.get('company')):
                continue
            actual = row.get('actual_start')
            event_time = actual or row.get('start')
            if not event_time:
                continue
            for target in contexts:
                if not target.get('created'):
                    continue
                ci_match = same(row.get('ci'), target.get('ci'))
                service_match = same(row.get('service'), target.get('service')) and same(row.get('group'), target.get('group'))
                delta = hours_between(target['created'], event_time)
                if (ci_match or service_match) and 0 <= delta <= 72:
                    changes.append((row, delta, bool(actual), ci_match))
                    cite(row, 'preceding_change_correlation', details={'hours_before_incident': round(delta, 2),
                         'matched_incident': target['id'], 'matched_dimension': 'ci' if ci_match else 'service_and_group',
                         'time_basis': 'actual_work_start' if actual else 'planned_start',
                         'causation_proven': False})
                    break
        changes.sort(key=lambda item: (not item[2], item[1]))
        hypotheses = []
        by_cause = {}
        for row, sim, direct in problems:
            cause = row.get('cause', '')
            if not cause or cause.casefold() in {'unknown', 'other'}:
                continue
            by_cause.setdefault(cause, []).append((row, sim, direct))
        for cause, supports in by_cause.items():
            best = max(s[1] for s in supports)
            direct = any(s[2] for s in supports)
            score = min(.85, .20 + .40 * best + .20 * direct + .05 * min(len(supports)-1, 2))
            hypotheses.append({'hypothesis': f'{cause}: recorded cause in related problem records',
                'cause_category': cause, 'basis': 'explicit_problem_link' if direct else 'historical_analogy',
                'confidence_score': round(score, 3), 'confidence_components': {'symptom_similarity': round(best, 3),
                    'explicit_link': direct, 'supporting_problem_count': len(supports)},
                'evidence_ids': [s[0]['key'] for s in supports],
                'recorded_mechanism_statements': [{'evidence_id': s[0]['key'], 'statement': causal_statement(s[0])}
                                                  for s in supports if causal_statement(s[0])],
                'validation': 'Verify that the recorded mechanism also occurs in this incident using service logs and an SME.'})
        for row, delta, actual, ci_match in changes[:3]:
            hypotheses.append({'hypothesis': f'Change {row["id"]} may be associated with the observed symptoms',
                'cause_category': 'Change', 'basis': 'temporal_correlation',
                'confidence_score': round(min(.60, .20 + .15 * actual + .10 * ci_match + .10 * (1-delta/72)), 3),
                'confidence_components': {'hours_before_incident': round(delta, 2), 'actual_start_present': actual,
                                          'ci_match': ci_match},
                'evidence_ids': [row['key']],
                'validation': 'Check implementation audit and before/after telemetry; planned time alone does not show execution.'})
        cause_model = self.bundle.get('cause_model')
        predictions = []
        if cause_model is not None:
            x = self.bundle['cause_vectorizer'].transform([text])
            if x.nnz:
                probabilities = cause_model.predict_proba(x)[0]
                predictions = [{'cause_category': str(cause_model.classes_[i]), 'uncalibrated_model_probability': round(float(probabilities[i]), 4)}
                               for i in np.argsort(probabilities)[::-1][:3]]
        # Classifier output is a lead, never evidence or a standalone confirmed root cause.
        hypotheses.sort(key=lambda item: item['confidence_score'], reverse=True)
        hypotheses = hypotheses[:5]
        related = {row['key']: row for row in seeds}
        for row, sim, _ in ranked:
            if row['kind'] != 'incident' or sim < .30:
                continue
            if seeds:
                matches = False
                for seed in seeds:
                    if not seed.get('created') or not row.get('created'):
                        continue
                    if abs(hours_between(row['created'], seed['created'])) <= 168 and (
                        same(seed.get('ci'), row.get('ci')) or same(seed.get('service'), row.get('service'))):
                        matches = True
                        break
                if not matches:
                    continue
            related[row['key']] = row
        incident_set = {row['id'].upper() for row in related.values()}
        sla_rows = [row for row in self.records if row['kind'] == 'sla_incident' and ids(row.get('task')) & incident_set]
        breached_ids = set().union(*(ids(row.get('task')) & incident_set for row in sla_rows if row.get('breached'))) if sla_rows else set()
        users = {row['affected_user'] for row in related.values() if row.get('affected_user')}
        active = [row for row in related.values() if row.get('state', '').casefold() in {'new', 'in progress', 'on hold', 'open'}]
        outage_durations = []
        for row in related.values():
            if row.get('outage_start') and row.get('outage_end'):
                hours = hours_between(row['outage_end'], row['outage_start'])
                if hours >= 0:
                    outage_durations.append(hours)
        impact = {'scope': 'Observed related incidents in the bounded snapshot; not a fleet-wide blast radius.',
                  'matching_rule': 'Seed incidents plus symptom similarity >=0.30; seed investigations also require same CI/service and +/-7 days.',
                  'incident_count': len(related), 'active_incident_count': len(active),
                  'high_priority_incidents': sum(priority_high(row.get('priority')) for row in related.values()),
                  'distinct_recorded_affected_users': len(users),
                  'sla_rows_matched': len(sla_rows), 'incidents_with_observed_sla_breach': len(breached_ids),
                  'services': dict(Counter(row['service'] for row in related.values() if row.get('service'))),
                  'configuration_items': dict(Counter(row['ci'] for row in related.values() if row.get('ci'))),
                  'assignment_groups': dict(Counter(row['group'] for row in related.values() if row.get('group'))),
                  'locations': dict(Counter(row['location'] for row in related.values() if row.get('location'))),
                  'reported_outage_hours_sum': round(sum(outage_durations), 2),
                  'outage_measure_note': 'Sum of ticket intervals; overlapping intervals are not deduplicated service downtime.',
                  'incident_ids': sorted(incident_set), 'sla_coverage': 'SLA rows are independently bounded; absence of a breach record is unknown.'}
        owner_names = set(impact['assignment_groups'])
        owners = [{'name': row['id'], 'active': row.get('active', '').casefold() in {'1', 'true', 'yes'},
                   'capability': row.get('capability', ''), 'responsibility': row.get('responsibility', '')}
                  for row in self.records if row['kind'] == 'assignment_group' and row['id'] in owner_names]
        status = 'hypotheses_require_validation' if hypotheses else 'insufficient_causal_evidence'
        gaps = ['Logs, ITOM events, work notes and standalone KB article content are unavailable.',
                'The classifier predicts broad cause categories; probabilities are uncalibrated.',
                'Source timestamps are assumed to use ' + self.bundle['manifest']['source_timezone_assumption'] + '.']
        if not company:
            gaps.append('No company scope provided; similarities may cross company boundaries.')
        if not problems:
            gaps.append('No sufficiently similar or explicitly linked problem record was found.')
        if not tasks:
            gaps.append('No linked problem-task evidence was found.')
        if any(entry['truncated'] for entry in self.bundle['manifest']['source_profile'].values()):
            gaps.append('One or more tables are truncated; missing records may change hypotheses and impact counts.')
        actions = ['Review cited problem records and confirm the failure mechanism with the responsible assignment group.',
                   'Collect incident-time application, infrastructure and network logs to test each hypothesis.',
                   'Record the validated cause and rejected hypotheses for future model evaluation.']
        if changes:
            actions.insert(1, 'Review correlated change implementation records and actual execution times.')
        summary = (f'{len(related)} related incident(s), {len(problems)} problem record(s), and {len(changes)} preceding change correlation(s) found. '
                   + (f'The leading hypothesis is {hypotheses[0]["cause_category"]}; validation is required.' if hypotheses else 'Available records do not establish a defensible causal hypothesis.'))
        return {'workstream': 3, 'mode': 'local_evidence_orchestration', 'status': status,
                'query': redact(query), 'seed_incident_ids': incident_ids, 'company_scope': company,
                'snapshot_as_of': self.bundle['manifest']['as_of'], 'root_cause_confirmed': False,
                'evidence_summary': summary, 'hypotheses': hypotheses, 'cause_category_predictions': predictions,
                'confidence_definition': 'Heuristic evidence strength on [0,1]; not calibrated probability or causal proof.',
                'evidence': list(evidence.values()), 'impact_analysis': impact, 'suggested_owners': owners,
                'recommended_actions': actions, 'evidence_gaps': gaps,
                'orchestration_trace': [{'stage': 'retrieve_symptoms', 'result_count': len(similar)},
                    {'stage': 'inspect_problem_links', 'result_count': len(problems)},
                    {'stage': 'inspect_problem_tasks', 'result_count': len(tasks)},
                    {'stage': 'correlate_changes', 'result_count': len(changes)},
                    {'stage': 'assess_impact_and_sla', 'result_count': len(related)},
                    {'stage': 'review_hypotheses', 'result_count': len(hypotheses), 'status': status}]}
