"""Retrospective recurrence monitoring; closure is a proxy, never proof of RCA causality."""
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from .data import symptom_text
from .rca import ids, priority_high

SIMILARITY_THRESHOLD = 0.35
MIN_BASELINE = 3


def stamp(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def norm(value):
    value = str(value or '').strip().casefold()
    return '' if value in {'unknown', 'n/a', 'none', 'null', '(empty)', '-', 'not applicable'} else value


def anchor_contexts(problem, incidents):
    company = norm(problem.get('company'))
    linked = [incidents[k] for k in sorted(ids(problem.get('incident')))
              if k in incidents and company and norm(incidents[k].get('company')) == company]
    contexts = set()
    for row in linked or [problem]:
        ci, service, group = (norm(row.get(k)) for k in ('ci', 'service', 'group'))
        if company and (ci or service and group):
            contexts.add((company, ci, service, group))
    return sorted(contexts)


class EffectivenessTracker:
    def __init__(self, engine):
        self.engine = engine
        self.manifest = engine.bundle['manifest']
        self.as_of = stamp(self.manifest['as_of'])
        self.incidents = engine.incidents
        self.problems = {r['id'].upper(): r for r in engine.records if r['kind'] == 'problem'}
        self.doc_index = {r['key']: i for i, r in enumerate(engine.docs)}
        self.by_ci, self.by_service_group = defaultdict(set), defaultdict(set)
        self.created = {}
        for key, row in self.incidents.items():
            self.created[key] = stamp(row.get('created'))
            company = norm(row.get('company'))
            if company and norm(row.get('ci')):
                self.by_ci[(company, norm(row['ci']))].add(key)
            if company and norm(row.get('service')) and norm(row.get('group')):
                self.by_service_group[(company, norm(row['service']), norm(row['group']))].add(key)
        profile = self.manifest.get('source_profile', {}).get('snow_Incident_DnA', {})
        dated = sorted((d for d in self.created.values() if d and d <= self.as_of), reverse=True)
        self.coverage_start = None
        self.coverage_reason = 'Incident extraction coverage is unknown.'
        if (profile and all(self.created.values())
                and not profile.get('date_parse_failures', {}).get('created')):
            retained = profile.get('retained', 0)
            clean = not profile.get('duplicate_or_missing_ids', 0)
            if profile.get('truncated') and clean and retained and len(dated) >= retained:
                # Historical first-reported incidents were appended AFTER the latest-N extract.
                # They must not make an isolated older date look like continuous coverage.
                self.coverage_start = dated[retained - 1]
            elif profile.get('truncated') is False and clean and dated:
                self.coverage_start = dated[-1]
            self.coverage_reason = ('Latest incident extract plus isolated historical links; '
                                    'only the continuous extract interval is used for scores.')
        self.cache = {}
        self.families = {}

    def family(self, problem):
        key = problem['id'].upper()
        if key in self.families:
            return self.families[key]
        company = norm(problem.get('company'))
        linked = [self.incidents[k] for k in sorted(ids(problem.get('incident')))
                  if k in self.incidents and company and norm(self.incidents[k].get('company')) == company]
        anchors = linked or [problem]
        candidates = set()
        for row in anchors:
            if norm(row.get('ci')):
                candidates |= self.by_ci[(company, norm(row['ci']))]
            if norm(row.get('service')) and norm(row.get('group')):
                candidates |= self.by_service_group[(company, norm(row['service']), norm(row['group']))]
        # A different text query per linked seed prevents a broad averaged symptom family.
        scores = {}
        candidates = [self.incidents[k] for k in sorted(candidates)
                      if self.incidents[k]['key'] in self.doc_index]
        if candidates and company:
            matrix = self.engine.bundle['matrix'][[self.doc_index[r['key']] for r in candidates]]
            for anchor in anchors:
                text = symptom_text(anchor).strip()
                if not text:
                    continue
                q = self.engine.bundle['vectorizer'].transform([text])
                similarities = (matrix @ q.T).toarray().ravel()
                for row, score in zip(candidates, similarities):
                    same_ci = norm(anchor.get('ci')) and norm(anchor.get('ci')) == norm(row.get('ci'))
                    same_service_group = (norm(anchor.get('service')) and norm(anchor.get('group'))
                                          and norm(anchor['service']) == norm(row.get('service'))
                                          and norm(anchor['group']) == norm(row.get('group')))
                    if (same_ci or same_service_group) and score >= SIMILARITY_THRESHOLD:
                        old = scores.get(row['id'], (0, ''))
                        if float(score) > old[0]:
                            scores[row['id']] = (float(score), 'Same CI' if same_ci else 'Same service & assignment group')
        for row in linked:
            scores[row['id']] = (1.0, 'Explicit first-reported incident')
        matches = []
        for incident_id, (similarity, relation) in scores.items():
            row = self.incidents[incident_id]
            matches.append({'id': incident_id, 'title': row.get('title', ''),
                            'created': row.get('created'), 'priority': row.get('priority', ''),
                            'service': row.get('service', ''), 'ci': row.get('ci', ''),
                            'similarity': round(similarity, 4), 'relation': relation})
        matches.sort(key=lambda r: r.get('created') or '', reverse=True)
        self.families[key] = (matches, [r['id'] for r in linked])
        return self.families[key]

    def measure(self, problem, days):
        closed = stamp(problem.get('closed'))
        created = stamp(problem.get('created'))
        terminal = norm(problem.get('state')) in {'closed', 'resolved'}
        valid = bool(closed and terminal and closed <= self.as_of and (not created or closed >= created))
        matches, linked = self.family(problem)
        result = {'id': problem['id'], 'title': problem.get('title', ''),
                  'company': problem.get('company', ''), 'service': problem.get('service', ''),
                  'ci': problem.get('ci', ''), 'owner': problem.get('group', ''),
                  'cause': problem.get('cause', ''), 'state': problem.get('state', ''),
                  'created': problem.get('created'), 'closed': problem.get('closed'),
                  'fixed_at': problem.get('fixed_at'), 'window_days': days,
                  'linked_incident_ids': linked, 'anchor_basis': 'Linked incident symptoms' if linked else 'Problem symptoms',
                  'score': None, 'rate_change_percent': None, 'before_count': None, 'after_count': None,
                  'before_rate': None, 'after_rate': None, 'monitored_days': 0,
                  'first_recurrence_days': None, 'high_priority_after': 0, 'daily': [], 'matches': []}
        result['scoring_requirements'] = [
            {'label': 'Valid problem closure', 'met': valid},
            {'label': f'Full {days}-day baseline history', 'met': None},
            {'label': f'Full {days}-day follow-up history', 'met': None},
            {'label': f'{days} days elapsed after closure', 'met': None},
            {'label': f'At least {MIN_BASELINE} baseline incidents', 'met': None},
        ]
        if not valid:
            result.update(status='awaiting_closure', reason='A closed/resolved problem with a valid closure date is needed.')
            return result
        start, end = closed - timedelta(days=days), closed + timedelta(days=days)
        before = [r for r in matches if (d := self.created.get(r['id'])) and start <= d < closed]
        after = [r for r in matches if (d := self.created.get(r['id'])) and closed <= d < end and d <= self.as_of]
        elapsed = min(days, max(0, (self.as_of - closed).total_seconds() / 86400))
        baseline_covered = self.coverage_start is not None and self.coverage_start <= start
        post_covered = self.coverage_start is not None and self.coverage_start <= closed
        history = self.manifest.get('effectiveness_coverage', {}).get(problem['id'].upper(), {})
        scope_matches = (history.get('complete') is True
                         and history.get('closed') == problem.get('closed')
                         and history.get('contexts') == [list(c) for c in anchor_contexts(problem, self.incidents)])
        backfill_start = stamp(history.get('start')) if scope_matches else None
        backfill_end = stamp(history.get('end')) if scope_matches else None
        result['targeted_history'] = bool(backfill_start and backfill_end
                                           and backfill_start <= start
                                           and backfill_end >= min(end, self.as_of))
        if backfill_start and backfill_end:
            baseline_covered |= backfill_start <= start and backfill_end >= closed
            post_covered |= backfill_start <= closed and backfill_end >= min(end, self.as_of)
        result['scoring_requirements'] = [
            {'label': 'Valid problem closure', 'met': True},
            {'label': f'Full {days}-day baseline history', 'met': baseline_covered},
            {'label': f'Full {days}-day follow-up history', 'met': post_covered and elapsed >= days},
            {'label': f'{days} days elapsed after closure', 'met': elapsed >= days},
            {'label': f'At least {MIN_BASELINE} baseline incidents',
             'met': len(before) >= MIN_BASELINE if baseline_covered else None},
        ]
        result.update(before_count=len(before), after_count=len(after), monitored_days=round(elapsed, 1),
                      before_start=start.isoformat(), after_end=end.isoformat(),
                      baseline_covered=baseline_covered, post_covered=post_covered,
                      high_priority_after=sum(priority_high(r['priority']) for r in after),
                      first_recurrence_days=round(min((self.created[r['id']] - closed).total_seconds() / 86400
                                                      for r in after), 1) if after else None,
                      matches=[dict(r, period='Before closure') for r in before] +
                              [dict(r, period='After closure') for r in after])
        for offset in range(-days, days):
            bin_start = closed + timedelta(days=offset)
            bin_end = bin_start + timedelta(days=1)
            observed = bool(self.coverage_start and self.coverage_start <= bin_start and bin_end <= self.as_of)
            observed |= bool(backfill_start and backfill_end
                             and backfill_start <= bin_start and bin_end <= backfill_end)
            count = sum(bin_start <= self.created[r['id']] < bin_end for r in before + after)
            result['daily'].append({'day': offset, 'count': count if observed else None})
        if not baseline_covered or not post_covered:
            result.update(status='insufficient_history', reason='The incident extract does not cover both comparison windows. Counts are partial; no score is assigned.')
        elif elapsed < days:
            result.update(status='monitoring', reason=f'The {days}-day follow-up window is still open. No final score yet.')
        elif len(before) < MIN_BASELINE:
            result.update(status='insufficient_baseline', reason=f'At least {MIN_BASELINE} matching baseline incidents are needed to score a trend.')
        else:
            reduction = 100 * (1 - len(after) / len(before))
            result.update(score=round(max(0, min(100, reduction))), rate_change_percent=round(reduction, 1),
                          before_rate=round(len(before) / days * 7, 2), after_rate=round(len(after) / days * 7, 2))
            status = 'reduced' if reduction > 0 else 'increased' if reduction < 0 else 'unchanged'
            result.update(status=status, reason='Observed incident-rate reduction after closure. Matching recurrences are candidates for review; this does not establish RCA causality.')
        return result

    def results(self, days):
        if days not in self.cache:
            self.cache[days] = {key: self.measure(row, days) for key, row in self.problems.items()}
        return self.cache[days]

    def overview(self, days=7, company=''):
        rows = [r for r in self.results(days).values() if not company or norm(r['company']) == norm(company)]
        scored = [r for r in rows if r['score'] is not None]
        status_order = {'increased': 0, 'unchanged': 1, 'reduced': 2, 'monitoring': 3,
                        'insufficient_baseline': 4, 'insufficient_history': 5, 'awaiting_closure': 6}
        rows.sort(key=lambda r: (status_order[r['status']], -(stamp(r.get('closed')) or datetime.min.replace(tzinfo=timezone.utc)).toordinal()))
        return {'as_of': self.manifest['as_of'], 'window_days': days,
                'coverage_start': self.coverage_start.isoformat() if self.coverage_start else None,
                'coverage_note': self.coverage_reason,
                'targeted_history_problems': sum(bool(r.get('targeted_history')) for r in rows),
                'unscored_reasons': dict(Counter(r['status'] for r in rows if r['score'] is None)),
                'companies': sorted({r.get('company') for r in self.problems.values() if r.get('company')}),
                'summary': {'problems': len(rows), 'scored': len(scored),
                            'average_score': round(sum(r['score'] for r in scored) / len(scored)) if scored else None,
                            'recurrence_candidates': len({m['id'] for r in rows for m in r['matches'] if m['period'] == 'After closure'}),
                            'needs_review': sum(r['status'] in {'increased', 'unchanged'} for r in rows),
                            'monitoring': sum(r['status'] == 'monitoring' for r in rows),
                            'unscored': len(rows) - len(scored)},
                'method': {'similarity_threshold': SIMILARITY_THRESHOLD, 'minimum_baseline': MIN_BASELINE,
                           'formula': 'Score = clamp(100 × (1 − after / before), 0, 100), using equal observation windows.',
                           'matching': 'Same company and same CI, or same service + assignment group, with symptom similarity ≥ 0.35. Explicit first-reported incident links are included.',
                           'limitation': 'Closure is a timing proxy. No verified RCA approval or remediation completion is present. Candidate matches are not confirmed recurrences. Snapshot counts do not prove prevention; one incident may match multiple problems.'},
                'problems': [{k: v for k, v in row.items() if k not in {'daily', 'matches'}} for row in rows]}
