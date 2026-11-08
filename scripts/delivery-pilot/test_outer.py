import json
import pathlib
import tempfile
import unittest

import exporter
import timing
import intake
import subprocess
import sys


class OuterTests(unittest.TestCase):
    def test_native_result_before_call_rejected_despite_ordered_timestamps(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root)/'native'
            for native_format in ('codex', 'claude'):
                with self.subTest(native_format=native_format):
                    call = {'timestamp': '2026-11-08T19:00:00Z'}
                    result = {'timestamp': '2026-11-08T19:00:01Z'}
                    if native_format == 'codex':
                        call['payload'] = {'type': 'function_call', 'call_id': 'id'}
                        result['payload'] = {'type': 'function_call_output', 'call_id': 'id'}
                    else:
                        call['message'] = {'content': [{'type': 'tool_use', 'id': 'id'}]}
                        result['message'] = {'content': [{'type': 'tool_result', 'tool_use_id': 'id'}]}
                    path.write_text('\n'.join(json.dumps(e) for e in (result, call)))
                    with self.assertRaises(ValueError):
                        timing.join({'path': str(path), 'start': 1, 'end': 2,
                                     'call_id': 'id', 'format': native_format})

    def test_queue_boundary_with_disposable_subprocess(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            script = root/'fake_queue.py'
            script.write_text('''import json, pathlib, sys
state = pathlib.Path(sys.argv[1])
args = sys.argv[2:]
if args[1] == 'show':
    if state.exists():
        print(state.read_text())
    else:
        print(json.dumps({'error': 'qitem_not_found'}))
        sys.exit(1)
else:
    state.write_text(json.dumps({'qitemId': args[args.index('--id')+1],
        'destinationSession': args[args.index('--destination')+1],
        'body': pathlib.Path(args[args.index('--body-file')+1]).read_text()}))
    sys.exit(7)  # committed, response failed
''')
            queue = intake.Queue(command=(sys.executable, '-B', str(script), str(root/'row')))
            self.assertEqual(queue.show('test')[0], 'absent')
            body = root/'body'
            body.write_text('literal body\n')
            queue.create({'queue_id': 'test', 'destination': 'research-lead@ci-research',
                          'summary': 'summary'}, body)
            status, row = queue.show('test')
            self.assertEqual(status, 'found')
            self.assertEqual(row['body'], 'literal body\n')

    def test_publication_projection_drops_raw_url_and_credentials(self):
        publication = {'provider': 'forgejo', 'repo': 'lacuna/dione', 'number': 734,
                       'state': 'open', 'draft': False, 'head': 'a'*40, 'base': 'b'*40,
                       'merge_base': 'b'*40, 'tree': 'c'*40,
                       'url': 'https://SECRET.invalid', 'credential': 'SECRET'}
        result = intake.publication_summary({'publication': publication}, {'repo': 'lacuna/dione'})
        self.assertEqual(result['number'], 734)
        self.assertEqual(result['coverage_gaps'], [])
        self.assertNotIn('SECRET', json.dumps(result))
        with self.assertRaises(ValueError):
            intake.publication_summary({'publication': publication}, {'repo': 'other/repo'})

    def test_conflicting_queue_row_is_never_accepted_or_recreated(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            (root/'contract').write_text(json.dumps({'task_id': 'task', 'revision': 'v1', 'checks': []}))
            (root/'events').write_text(json.dumps({'task_id': 'task', 'kind': 'handoff',
                'event_id': 'end', 'attempt_id': 'a', 'outcome': 'failed', 'logical_task_terminal': True}))
            binding = {'task_id': 'task', 'integration_id': 'i', 'destination': 'research-lead@ci-research',
                       'contract': str(root/'contract'), 'records': [str(root/'events')],
                       'output': str(root/'report'), 'state': str(root/'state')}
            calls = []
            def run(argv, **options):
                calls.append(argv)
                return subprocess.CompletedProcess(argv, 0, json.dumps({'qitemId': argv[3],
                    'destinationSession': 'research-lead@ci-research', 'body': 'other payload'}))
            with self.assertRaises(ValueError):
                intake.intake(binding, 'end', intake.Queue(run=run))
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][2], 'show')

    def test_unknown_show_never_creates_and_nonterminal_cannot_trigger(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            contract, records = root/'contract', root/'records'
            contract.write_text(json.dumps({'task_id': 'task', 'revision': 'v1', 'checks': []}))
            event = {'task_id': 'task', 'kind': 'handoff', 'event_id': 'end',
                     'attempt_id': 'a', 'logical_task_terminal': True, 'outcome': 'rejected'}
            records.write_text(json.dumps(event))
            binding = {'task_id': 'task', 'integration_id': 'integration',
                       'destination': 'research-lead@ci-research', 'contract': str(contract),
                       'records': [str(records)], 'state': str(root/'state'), 'output': str(root/'report')}
            calls = []
            def run(argv, **options):
                calls.append(argv)
                raise subprocess.TimeoutExpired(argv, 20)
            result = intake.intake(binding, 'end', intake.Queue(run=run))
            self.assertEqual(result['status'], 'pending-unknown')
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][2], 'show')
            event['kind'] = 'attempt'
            records.write_text(json.dumps(event))
            with self.assertRaises(ValueError):
                intake.intake(binding, 'end', intake.Queue(run=run))
            self.assertEqual(len(calls), 1)

    def test_lifecycle_retains_start_only_failure_repair_and_success(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root)/'events'
            events = [{'task_id': 'task', 'kind': 'attempt-start', 'event_id': 'start', 'attempt_id': 'unfinished'}]
            for i, outcome in enumerate(['failed', 'rejected', 'infrastructure-failed', 'abandoned', 'repaired', 'succeeded']):
                events.append({'task_id': 'task', 'kind': 'attempt', 'event_id': str(i),
                               'attempt_id': str(i), 'outcome': outcome})
            path.write_text('\n'.join(json.dumps(e) for e in events + events))
            result = exporter.export('task', [path], {'task_id': 'task', 'revision': 'v1', 'checks': []})
            self.assertEqual(len(result['attempts']), 6)
            self.assertEqual(result['incomplete_attempt_refs'], [exporter.sha(b'unfinished')])
            events.append({**events[1], 'event_id': 'different'})
            path.write_text('\n'.join(json.dumps(e) for e in events))
            with self.assertRaises(ValueError):
                exporter.export('task', [path], {'task_id': 'task', 'revision': 'v1', 'checks': []})

    def test_claude_exact_link_and_ambiguous_timing(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root)/'native'
            events = [
                {'timestamp': '2026-11-08T19:00:00Z', 'message': {'content': [
                    {'type': 'tool_use', 'id': 'id', 'input': {'secret': 'SECRET'}}]}},
                {'timestamp': '2026-11-08T19:00:01Z', 'message': {'content': [
                    {'type': 'tool_result', 'tool_use_id': 'id', 'content': 'SECRET'}]}}]
            path.write_text('\n'.join(json.dumps(e) for e in events))
            spec = {'path': str(path), 'start': 1, 'end': 2, 'call_id': 'id', 'format': 'claude'}
            result = timing.join(spec)
            self.assertEqual(result['result_observed_at'], '2026-11-08T19:00:01Z')
            self.assertNotIn('SECRET', json.dumps(result))
            path.write_text('\n'.join(json.dumps(e) for e in events + [events[1]]))
            with self.assertRaises(ValueError):
                timing.join({**spec, 'end': 3})

    def test_dirty_checkout_parent_is_not_tested_candidate(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root) / 'records'
            path.write_text(json.dumps({'task_id': 'task', 'kind': 'attempt',
                'event_id': 'e', 'attempt_id': 'a', 'outcome': 'succeeded',
                'revisions': {'head': 'a'*40}, 'local_only': {'dirty': True, 'path': 'SECRET'}}))
            result = exporter.export('task', [path], {'task_id': 'task', 'revision': 'v1', 'checks': []})
            attempt = result['attempts'][0]
            self.assertIsNone(attempt['revisions']['head'])
            self.assertIsNone(attempt['revisions']['tree'])
            self.assertEqual(attempt['checkout_parent'], 'a'*40)
            self.assertIn('dirty-source-unknown-candidate', attempt['coverage_gaps'])
            self.assertNotIn('SECRET', json.dumps(result))

    def test_queue_adapter_unknown_and_explicit_absence(self):
        for returncode, payload, expected in [(1, {'error': 'qitem_not_found'}, 'absent'),
                                              (1, {'error': 'other'}, 'unknown'),
                                              (0, {'qitemId': 'x'}, 'found')]:
            calls = []
            def run(argv, **options):
                calls.append((argv, options))
                return subprocess.CompletedProcess(argv, returncode, json.dumps(payload))
            self.assertEqual(intake.Queue(run=run).show('x')[0], expected)
            self.assertEqual(calls[0][0], ['rig', 'queue', 'show', 'x', '--full', '--json'])
            self.assertEqual(calls[0][1]['timeout'], 20)

    def test_intake_reconciles_lost_response_and_rejects_changed_payload(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            contract, records = root/'contract', root/'records'
            contract.write_text(json.dumps({'task_id': 'task', 'revision': 'v1', 'checks': []}))
            event = {'task_id': 'task', 'kind': 'handoff', 'event_id': 'terminal',
                     'attempt_id': 'a', 'logical_task_terminal': True, 'outcome': 'succeeded'}
            records.write_text(json.dumps(event))
            binding = {'task_id': 'task', 'integration_id': 'integration',
                       'destination': 'research-lead@ci-research', 'contract': str(contract),
                       'records': [str(records)], 'state': str(root/'state'), 'output': str(root/'report')}
            rows, creates = {}, []
            def run(argv, **options):
                if argv[2] == 'show':
                    ident = argv[3]
                    return subprocess.CompletedProcess(argv, 0 if ident in rows else 1,
                        json.dumps(rows.get(ident, {'error': 'qitem_not_found'})))
                ident = argv[argv.index('--id')+1]
                body = pathlib.Path(argv[argv.index('--body-file')+1]).read_text()
                rows[ident] = {'qitemId': ident, 'body': body,
                               'destinationSession': 'research-lead@ci-research'}
                creates.append(ident)
                raise subprocess.TimeoutExpired(argv, 20)
            queue = intake.Queue(run=run)
            first = intake.intake(binding, 'terminal', queue)
            self.assertEqual(first['status'], 'persisted')
            self.assertEqual(intake.intake(binding, 'terminal', queue), first)
            self.assertEqual(len(creates), 1)
            event['outcome'] = 'failed'
            records.write_text(json.dumps(event))
            with self.assertRaises(ValueError):
                intake.intake(binding, 'terminal', queue)
            self.assertEqual(len(creates), 1)

    def test_native_timing_requires_exact_call_and_hashes_private_data(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root) / 'private-history'
            path.write_text('\n'.join(json.dumps(e) for e in [
                {'timestamp': '2026-11-08T19:00:00Z', 'payload': {
                    'type': 'function_call', 'call_id': 'private-call', 'arguments': 'SECRET'}},
                {'timestamp': '2026-11-08T19:00:03Z', 'payload': {
                    'type': 'function_call_output', 'call_id': 'private-call', 'output': 'SECRET'}}]))
            result = timing.join({'path': str(path), 'start': 1, 'end': 2,
                                  'call_id': 'private-call', 'format': 'codex'})
            self.assertEqual(result['call_emitted_at'], '2026-11-08T19:00:00Z')
            self.assertEqual(result['result_observed_at'], '2026-11-08T19:00:03Z')
            self.assertNotIn('SECRET', json.dumps(result))
            self.assertNotIn('private-', json.dumps(result))
            with self.assertRaises(ValueError):
                timing.join({'path': str(path), 'start': 1, 'end': 2,
                             'call_id': 'wrong', 'format': 'codex'})

    def test_recorded_at_never_fills_occurrence_and_local_fields_stay_local(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root) / 'events'
            path.write_text(json.dumps({'task_id': 'task', 'kind': 'attempt',
                'event_id': 'private-event', 'attempt_id': 'private-attempt',
                'outcome': 'failed', 'recorded_at': '2026-11-08T19:00:00Z',
                'argv': ['SECRET'], 'cwd': '/private/source',
                'revisions': {'head': 'a'*40, 'merge_base': 'b'*40,
                              'tree': 'c'*40, 'contract_revision': 'v1'}, 'checks': []}))
            result = exporter.export('task', [path], {'task_id': 'task', 'revision': 'v1', 'checks': []})
            attempt = result['attempts'][0]
            self.assertIsNone(attempt['started_at'])
            self.assertEqual(attempt['recorded_at'], '2026-11-08T19:00:00Z')
            self.assertEqual(attempt['revisions']['tree'], 'c'*40)
            self.assertNotIn('SECRET', json.dumps(result))
            self.assertNotIn('/private', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
