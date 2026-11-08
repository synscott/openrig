#!/usr/bin/env python3
"""One explicit terminal handoff to Research. Never runs product or provider work."""
import argparse
import fcntl
import json
import os
import pathlib
import subprocess
import sys
import tempfile

import exporter


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n'


def atomic(path, data):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
            name = stream.name
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def publication_summary(event, binding):
    value = event.get('publication')
    if not isinstance(value, dict):
        return {'coverage_gaps': ['publication-unavailable']}
    repo = binding.get('repo')
    if not isinstance(repo, str) or len(repo.split('/')) != 2:
        raise ValueError('publication repository binding required')
    for component in repo.split('/'):
        exporter.identifier(component)
    if value.get('repo') != repo or value.get('provider') not in ('forgejo', 'github'):
        raise ValueError('publication outside binding')
    safe = {'repo': repo, 'provider': value['provider']}
    number = value.get('number')
    safe['number'] = number if type(number) is int and number > 0 else None
    safe['state'] = value.get('state') if value.get('state') in ('open', 'closed', 'merged') else None
    safe['draft'] = value.get('draft') if type(value.get('draft')) is bool else None
    safe.update({key: exporter.code_revision(value.get(key)) for key in ('head', 'base', 'merge_base', 'tree')})
    safe['coverage_gaps'] = ['publication-partial'] if any(v is None for v in safe.values()) else []
    return safe


class Queue:
    """Bounded CLI adapter. Only explicit not-found means absent."""
    def __init__(self, command=('rig',), run=subprocess.run):
        self.command, self.run = list(command), run

    def show(self, ident):
        try:
            result = self.run(self.command + ['queue', 'show', ident, '--full', '--json'],
                              capture_output=True, text=True, timeout=20, check=False)
            value = json.loads(result.stdout)
            if result.returncode == 0 and isinstance(value, dict) and value.get('qitemId') == ident:
                return 'found', value
            if result.returncode != 0 and isinstance(value, dict) and value.get('error') == 'qitem_not_found':
                return 'absent', None
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
        return 'unknown', None

    def create(self, intent, body_path):
        try:
            self.run(self.command + ['queue', 'create', '--id', intent['queue_id'],
                     '--destination', intent['destination'], '--summary', intent['summary'],
                     '--body-file', str(body_path), '--json'],
                     capture_output=True, text=True, timeout=20, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
        # A response is not a readback. Timeout may follow persistence.


def intake(binding, terminal_id, queue=None):
    queue = queue or Queue()
    task = exporter.identifier(binding['task_id'])
    integration = exporter.identifier(binding['integration_id'])
    destination = binding['destination']
    if destination != 'research-lead@ci-research':
        raise ValueError('destination outside Research intake')
    sources = [pathlib.Path(p).resolve() for p in binding['records']]
    contract_path = pathlib.Path(binding['contract']).resolve()
    state = pathlib.Path(binding['state']).resolve()
    output = pathlib.Path(binding['output']).resolve()
    body_path = state.with_suffix(state.suffix + '.body')
    lock = state.with_suffix(state.suffix + '.lock')
    inputs = sources + [contract_path]
    outputs = [state, output, body_path, lock]
    if len(set(outputs)) != len(outputs) or set(inputs) & set(outputs):
        raise ValueError('input/output alias')
    events = []
    for source in sources:
        events.extend(json.loads(line) for line in source.read_text().splitlines())
    for event in events:
        local_refs = event.get('histories', [])
        if not isinstance(local_refs, list):
            local_refs = []
        local_refs = local_refs + [event.get('timing_link')]
        for ref in local_refs:
            if isinstance(ref, dict) and isinstance(ref.get('path'), str):
                if pathlib.Path(ref['path']).resolve() in outputs:
                    raise ValueError('native history/output alias')
    selected = [e for e in events if e.get('event_id') == terminal_id]
    if not selected or any(canonical(e) != canonical(selected[0]) for e in selected):
        raise ValueError('missing or conflicting terminal event')
    terminal = selected[0]
    if (terminal.get('task_id') != task or terminal.get('kind') != 'handoff' or
            terminal.get('logical_task_terminal') is not True or
            terminal.get('outcome') not in exporter.TERMINAL):
        raise ValueError('not a logical terminal handoff')
    report = exporter.export(task, sources, json.loads(contract_path.read_text()))
    report['integration_id'] = integration
    report['publication'] = publication_summary(terminal, binding)
    report_bytes = canonical(report)
    report_sha = exporter.sha(report_bytes.encode())
    ident = 'qitem-research-' + exporter.sha(canonical([task, destination, terminal_id]).encode())[:40]
    body = canonical({'task_id': task, 'integration_id': integration,
                      'terminal_event_ref': exporter.sha(terminal_id.encode()),
                      'report_ref': str(output), 'report_sha256': report_sha,
                      'outcome': terminal['outcome'], 'acceptance_claim': 'none'})
    intent = {'queue_id': ident, 'destination': destination,
              'summary': 'Research intake for ' + task, 'body': body,
              'report_sha256': report_sha,
              'endpoint_ref': exporter.sha(canonical({key: os.environ.get(key) for key in
                   ('OPENRIG_URL', 'OPENRIG_HOME', 'OPENRIG_SESSION', 'OPENRIG_NODE_ID')}).encode())}
    state.parent.mkdir(parents=True, exist_ok=True)
    with lock.open('a') as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if state.exists():
            saved = json.loads(state.read_text())
            if saved['intent'] != intent:
                raise ValueError('changed terminal payload or endpoint')
        else:
            atomic(output, report_bytes)
            atomic(body_path, body)
            atomic(state, canonical({'intent': intent, 'status': 'pending'}))
        if output.read_text() != report_bytes or body_path.read_text() != body:
            raise ValueError('changed saved handoff files')
        status, row = queue.show(ident)
        if status == 'absent':
            queue.create(intent, body_path)
            status, row = queue.show(ident)
        if status == 'found':
            if row.get('body') != body or row.get('destinationSession') != destination:
                raise ValueError('queue identity conflict')
            result = {'queue_id': ident, 'status': 'persisted', 'report_sha256': report_sha}
        else:
            result = {'queue_id': ident, 'status': 'pending-unknown', 'report_sha256': report_sha}
        atomic(state, canonical({'intent': intent, **result}))
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binding', required=True)
    parser.add_argument('--terminal-event', required=True)
    args = parser.parse_args()
    try:
        print(canonical(intake(json.loads(pathlib.Path(args.binding).read_text()), args.terminal_event)), end='')
        return 0
    except Exception as error:
        print(type(error).__name__ + ': intake failed; preserve state and reconcile', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
