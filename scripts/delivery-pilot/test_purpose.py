"""Purpose is optional evidence metadata, never a replacement for outcome."""
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

import exporter


class PurposeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.records = self.root/'records.jsonl'
        self.contract = {'task_id': 'task', 'revision': 'v1', 'checks': []}

    def write(self, markers):
        events = []
        for index, marker in enumerate(markers):
            event = {'task_id': 'task', 'event_id': 'event-' + str(index),
                     'attempt_id': 'attempt-' + str(index), 'kind': 'attempt',
                     'outcome': 'failed', 'argv': ['expected_mutation_failure=true', 'PRIVATE'],
                     'cwd': '/PRIVATE/source'}
            if marker != 'absent':
                event['local_only'] = {'expected_mutation_failure': marker, 'path': '/PRIVATE/snapshot'}
            events.append(event)
        self.records.write_text('\n'.join(json.dumps(e) for e in events))

    def test_only_explicit_boolean_true_marks_negative_control(self):
        self.write([True, False, 'absent', 'true', 1, None])
        report = exporter.export('task', [self.records], self.contract, include_purpose=True)
        self.assertEqual([a['purpose']['kind'] for a in report['attempts']],
                         ['expected-negative-control'] + ['unknown'] * 5)
        self.assertEqual([a['outcome'] for a in report['attempts']], ['failed'] * 6)
        self.assertNotIn('PRIVATE', json.dumps(report))
        self.assertNotIn('expected_mutation_failure=true', json.dumps(report))

    def test_disabled_projection_is_exact_original_shape(self):
        self.write([True, False, 'absent'])
        original = exporter.export('task', [self.records], self.contract)
        disabled = exporter.export('task', [self.records], self.contract, include_purpose=False)
        enabled = exporter.export('task', [self.records], self.contract, include_purpose=True)
        self.assertEqual(disabled, original)
        self.assertTrue(all('purpose' not in attempt for attempt in disabled['attempts']))
        for attempt in enabled['attempts']:
            attempt.pop('purpose')
        self.assertEqual(enabled, original)

    def test_cli_opt_in_and_default_rollback(self):
        self.write([True])
        contract = self.root/'contract.json'
        contract.write_text(json.dumps(self.contract))
        output = self.root/'output.json'
        command = [sys.executable, '-B', str(pathlib.Path(exporter.__file__)), '--task', 'task',
                   '--contract', str(contract), '--records', str(self.records), '--output', str(output)]
        subprocess.run(command + ['--include-purpose'], check=True, capture_output=True, timeout=10)
        self.assertEqual(json.loads(output.read_text())['attempts'][0]['purpose']['kind'],
                         'expected-negative-control')
        subprocess.run(command, check=True, capture_output=True, timeout=10)
        self.assertNotIn('purpose', json.loads(output.read_text())['attempts'][0])


if __name__ == '__main__':
    unittest.main()
