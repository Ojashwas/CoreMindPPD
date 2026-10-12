"""Symptom retrieval and an optional, evaluated cause-code classifier."""
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import platform

import joblib
import numpy as np
import sklearn
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, confusion_matrix

from .data import extract, enrich_linked_incidents, symptom_text, write_json

IGNORED_LABELS = {'', 'unknown', 'other', 'none', 'n/a', 'null'}


def vectorizer():
    return TfidfVectorizer(ngram_range=(1, 2), max_features=60000,
                           sublinear_tf=True, strip_accents='unicode', stop_words='english')


def eligible(record, as_of):
    return (record['kind'] == 'problem' and record.get('cause', '').casefold() not in IGNORED_LABELS
            and bool(record.get('closed')) and record['closed'] <= as_of
            and bool(record.get('created')) and len(symptom_text(record).strip()) >= 15)


def fingerprint(record):
    return hashlib.sha256(symptom_text(record).casefold().encode()).hexdigest()


def classifier_fit(records):
    counts = Counter(row['cause'] for row in records)
    supported = {label for label, count in counts.items() if count >= 3}
    rows = [row for row in records if row['cause'] in supported]
    if len(rows) < 20 or len(supported) < 2:
        return None, None, rows
    vec = vectorizer()
    matrix = vec.fit_transform([symptom_text(row) for row in rows])
    classifier = LogisticRegression(max_iter=1500, class_weight='balanced', C=2.0, random_state=42)
    classifier.fit(matrix, [row['cause'] for row in rows])
    return vec, classifier, rows


def evaluate(rows):
    rows = sorted(rows, key=lambda row: row['created'])
    base = {'method': 'chronological holdout; training labels closed before holdout boundary',
            'limitation': 'Current descriptions can contain post-incident information. No historical text snapshots exist; this is retrospective validation, not proven live RCA accuracy.'}
    if len(rows) < 30:
        return dict(base, status='insufficient_labels', labeled_records=len(rows))
    boundary = rows[int(len(rows) * .8)]['created']
    training = [row for row in rows if row['created'] < boundary and row['closed'] < boundary]
    held = [row for row in rows if row['created'] >= boundary]
    seen = {fingerprint(row) for row in training}
    held = [row for row in held if fingerprint(row) not in seen]
    vec, model, training = classifier_fit(training)
    if model is None or not held:
        return dict(base, status='insufficient_temporal_training_data', training=len(training), holdout=len(held))
    y = [row['cause'] for row in held]
    x = vec.transform([symptom_text(row) for row in held])
    predicted = model.predict(x)
    probabilities = model.predict_proba(x)
    top3 = [set(model.classes_[np.argsort(p)[-3:]]) for p in probabilities]
    labels = sorted(set(y) | set(predicted))
    majority = Counter(row['cause'] for row in training).most_common(1)[0][0]
    return dict(base, status='evaluated', split_boundary=boundary, training=len(training), holdout=len(held),
                accuracy=round(accuracy_score(y, predicted), 4),
                macro_f1=round(f1_score(y, predicted, average='macro', zero_division=0), 4),
                top3_accuracy=round(sum(label in ranked for label, ranked in zip(y, top3)) / len(y), 4),
                majority_baseline_accuracy=round(sum(label == majority for label in y) / len(y), 4),
                unseen_holdout_labels=sorted(set(y) - set(model.classes_)),
                labels=labels, confusion_matrix=confusion_matrix(y, predicted, labels=labels).tolist())


def build(settings):
    records, profile = extract(settings)
    records, links = enrich_linked_incidents(settings, records)
    profile['snow_Incident_DnA']['historical_problem_links'] = links
    return fit_snapshot(settings, records, profile)


def fit_snapshot(settings, records, profile):
    docs = [row for row in records if row['kind'] in {'incident', 'problem', 'problem_task', 'change', 'case', 'request', 'catalog_task'}
            and symptom_text(row).strip()]
    if not docs:
        raise ValueError('No usable Snow records were extracted')
    vec = vectorizer()
    matrix = vec.fit_transform([symptom_text(row) for row in docs])
    as_of = datetime.fromisoformat(settings.as_of).astimezone(timezone.utc).isoformat()
    labeled = [row for row in docs if eligible(row, as_of)]
    # Exact duplicate symptom records cannot inflate training or validation support.
    unique = {}
    for row in sorted(labeled, key=lambda row: row['created']):
        unique.setdefault(fingerprint(row), row)
    labeled = list(unique.values())
    metrics = evaluate(labeled)
    cause_vec, cause_model, fitted = classifier_fit(labeled)
    snapshot_hash = hashlib.sha256(json.dumps(records, sort_keys=True, default=str).encode()).hexdigest()
    manifest = {'version': 1, 'as_of': as_of, 'schema': settings.schema, 'database': settings.database,
                'source_timezone_assumption': settings.source_timezone, 'date_convention': 'day-month-year; ISO supported',
                'snapshot_sha256': snapshot_hash, 'records': len(records), 'indexed_documents': len(docs),
                'source_profile': profile, 'labeled_closed_problems': len(labeled),
                'classifier_training_records': len(fitted), 'cause_distribution': dict(Counter(row['cause'] for row in labeled)),
                'classifier_enabled': cause_model is not None, 'metrics': metrics,
                'versions': {'python': platform.python_version(), 'sklearn': sklearn.__version__},
                'limitations': ['Bounded latest-row extraction; impact counts describe the snapshot only.',
                                'No logs, ITOM events, standalone knowledge articles, work notes or CMDB dependencies are available.',
                                'Problem fix is a timestamp, and knowledge is a flag; neither is resolution evidence.',
                                'Confidence is a heuristic evidence score, not a calibrated causal probability.',
                                'Mutable Snow snapshots do not establish point-in-time label or field availability.']}
    settings.artifacts.mkdir(parents=True, exist_ok=True)
    bundle = {'records': records, 'docs': docs, 'vectorizer': vec, 'matrix': matrix,
              'cause_vectorizer': cause_vec, 'cause_model': cause_model, 'manifest': manifest}
    temporary = settings.artifacts / 'model.tmp.joblib'
    joblib.dump(bundle, temporary, compress=3)
    temporary.replace(settings.artifacts / 'model.joblib')
    write_json(settings.artifacts / 'manifest.json', manifest)
    write_json(settings.artifacts / 'evaluation.json', metrics)
    print(json.dumps({'indexed_documents': len(docs), 'labeled_closed_problems': len(labeled), 'metrics': metrics}, indent=2))
    return bundle
