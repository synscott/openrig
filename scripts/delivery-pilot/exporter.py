#!/usr/bin/env python3
"""Read immutable task records; export sanitized metadata without judging acceptance."""
import argparse
import datetime
import math
import hashlib
import json
import pathlib
import re
import sys


TERMINAL = {'failed', 'abandoned', 'repaired', 'succeeded', 'rejected', 'infrastructure-failed'}


def identifier(value):
    if (not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', value)
            or re.search(r'(?i)(?:^|[.:_-])(?:sk[-_]|gh[pousr]_|github_pat_|bearer[-_:])', value)):
        raise ValueError('invalid metadata identity')
    return value


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value if parsed.tzinfo is not None else None
    except ValueError:
        return None


def code_revision(value):
    return value if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', value) else None


def sha(value):
    return hashlib.sha256(value).hexdigest()


def history_summary(spec):
    path = pathlib.Path(spec['path'])
    start, end = spec['start'], spec['end']
    if not isinstance(start, int) or not isinstance(end, int) or not (1 <= start <= end and end - start < 10000):
        raise ValueError('history range unavailable')
    selected = []
    with path.open('rb') as stream:
        for index, line in enumerate(stream, 1):
            if index > end:
                break
            if index >= start:
                if len(line) > 4 * 1024 * 1024:
                    raise ValueError('oversize history event')
                selected.append(line.rstrip(b'\r\n'))
    if len(selected) != end - start + 1:
        raise ValueError('history range truncated')
    counts = {'tool_calls': 0, 'tool_results': 0, 'workaround_indicators': 0}
    for line in selected:
        event = json.loads(line)
        payload = event.get('payload', event)
        kind = payload.get('type')
        if kind in ('function_call', 'custom_tool_call'):
            counts['tool_calls'] += 1
        if kind in ('function_call_output', 'custom_tool_call_output'):
            counts['tool_results'] += 1
        content = event.get('message', {}).get('content', [])
        if isinstance(content, list):
            counts['tool_calls'] += sum(c.get('type') == 'tool_use' for c in content if isinstance(c, dict))
            counts['tool_results'] += sum(c.get('type') == 'tool_result' for c in content if isinstance(c, dict))
        counts['workaround_indicators'] += int(b'--skip-checks' in line)
    return {'reference': sha(str(path.resolve()).encode()), 'range': [start, end],
            'sha256': sha(b'\n'.join(selected)), **counts}


def export(task, sources, contract):
    if contract.get('task_id') != task:
        raise ValueError('wrong export contract task')
    identifier(task)
    by_id, attempts, handoffs = {}, [], []
    for source in sources:
        for line in pathlib.Path(source).read_text().splitlines():
            event = json.loads(line)
            if event['task_id'] != task:
                raise ValueError('wrong task record')
            ident = event['event_id']
            attempt_id = event['attempt_id']
            if not all(isinstance(value, str) and 0 < len(value) <= 4096
                       for value in (ident, attempt_id)):
                raise ValueError('invalid event or attempt identity')
            canonical = json.dumps(event, sort_keys=True)
            if ident in by_id:
                if by_id[ident] != canonical:
                    raise ValueError('conflicting event identity')
                continue
            by_id[ident] = canonical
            if event['kind'] == 'handoff':
                handoffs.append({'event_id': sha(ident.encode()), 'attempt_id': sha(attempt_id.encode()),
                                 'time': timestamp(event.get('time')),
                                 'owner_ref': None, 'coverage_gaps': ['owner-identity-not-exported']})
                continue
            if event['kind'] != 'attempt':
                raise ValueError('unsupported event kind')
            gaps = []
            outcome = event.get('outcome')
            if outcome not in TERMINAL:
                outcome = 'unknown-nonterminal'
                gaps.append('terminal-outcome')
            histories = []
            supplied_histories = event.get('histories', [])
            if not isinstance(supplied_histories, list):
                supplied_histories = []
                gaps.append('history-malformed')
            for spec in supplied_histories:
                try:
                    histories.append(history_summary(spec))
                except (OSError, ValueError, KeyError, TypeError, AttributeError):
                    gaps.append('history-unavailable')
            if not histories:
                gaps.append('native-history')
            usage = event.get('usage')
            if usage is not None and not isinstance(usage, dict):
                usage = None
                gaps.append('usage-malformed')
            if usage is None:
                gaps.append('usage')
            safe_usage = None if usage is None else {
                k: v for k, v in usage.items()
                if k in ('input_tokens', 'output_tokens', 'cached_tokens', 'cost_usd')
                and isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0}
            timing = {key: timestamp(event.get(key)) for key in ('started_at', 'ended_at')}
            if usage is not None and (not safe_usage or len(safe_usage) != len(usage)):
                gaps.append('usage-partial')
            revisions = {k: code_revision(v)
                         for k, v in event.get('revisions', {}).items()
                         if k in ('head', 'base')}
            supplied_revision = event.get('revisions', {}).get('contract_revision')
            if supplied_revision is not None:
                if supplied_revision == contract['revision']:
                    revisions['contract_revision'] = contract['revision']
                else:
                    gaps.append('contract-revision-outside-fixed-contract')
            checks = []
            for check in event.get('checks', []):
                if check.get('id') not in contract['checks']:
                    gaps.append('check-outside-fixed-contract')
                    continue
                if check.get('outcome') not in {'pass', 'fail', 'skip', 'pending', 'unknown', 'incomplete'}:
                    gaps.append('unsupported-check-outcome')
                    continue
                checks.append({'id': check['id'], 'outcome': check['outcome']})
            if not revisions or any(v is None for v in revisions.values()):
                gaps.append('revisions')
            if not all(timing.values()):
                gaps.append('timing')
            attempts.append({'event_id': sha(ident.encode()), 'attempt_id': sha(attempt_id.encode()),
                             'outcome': outcome, 'revisions': revisions,
                             'checks': checks,
                             **timing, 'usage': safe_usage, 'histories': histories,
                             'coverage_gaps': sorted(set(gaps))})
    if len({a['attempt_id'] for a in attempts}) != len(attempts):
        raise ValueError('conflicting attempt identity')
    return {'task_id': task, 'attempts': attempts, 'handoffs': handoffs,
            'acceptance_claim': 'none; exporter does not judge acceptance'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--task', required=True)
    parser.add_argument('--contract', required=True)
    parser.add_argument('--records', action='append', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        result = export(args.task, args.records, json.loads(pathlib.Path(args.contract).read_text()))
        target = pathlib.Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix('.tmp')
        temp.write_text(json.dumps(result, sort_keys=True, indent=2) + '\n')
        temp.replace(target)
    except Exception as error:
        print(type(error).__name__ + ': export failed', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
