import json
import pathlib
import tempfile
import unittest
import subprocess
import sys

import excerpts


class ExcerptTaskTests(unittest.TestCase):
    def test_cli_mismatch_is_private_and_creates_no_output(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            index = root/'index.json'
            index.write_text(json.dumps({'task_id': 'task-two', 'path': '/PRIVATE/source'}))
            result = subprocess.run([sys.executable, '-B', str(pathlib.Path(excerpts.__file__)),
                '--index', str(index), '--output-dir', str(root/'output'), '--task', 'task-one'],
                capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'PRIVATE', result.stdout + result.stderr)
            self.assertFalse((root/'output').exists())

    def test_explicit_task_identity_is_validated_and_expected_task_is_not_inferred(self):
        self.assertEqual(excerpts.task_binding({'task_id': 'task-one'}, expected_task='task-one'),
                         {'task_id': 'task-one', 'task_binding': 'explicit-index'})
        self.assertEqual(excerpts.task_binding({'path': '/task-one/PRIVATE'}, expected_task='task-one'),
                         {'task_id': None, 'task_binding': 'unknown'})
        for value in ('task-two', 'SECRET /private/path', 'ghp_PRIVATE', 1, {}, ''):
            with self.subTest(value=value), self.assertRaises(ValueError):
                excerpts.task_binding({'task_id': value}, expected_task='task-one')

    def test_summary_and_private_manifest_use_same_explicit_binding(self):
        with tempfile.TemporaryDirectory() as root:
            root = pathlib.Path(root)
            source = root/'PRIVATE-task-other'
            source.write_text('\n'.join(json.dumps({'timestamp': stamp, 'payload': {
                'type': kind, 'call_id': 'PRIVATE-call', 'arguments': 'PRIVATE'}})
                for kind, stamp in [('function_call', '2026-11-08T20:00:00Z'),
                                    ('function_call_output', '2026-11-08T20:00:01Z')])+'\n')
            index = {'path': str(source), 'format': 'codex', 'task_id': 'task-one',
                     'links': [{'start': 1, 'end': 2, 'call_id': 'PRIVATE-call'}]}
            summary = excerpts.extract(index, root/'output', expected_task='task-one')
            manifest = json.loads((root/'output'/'manifest.json').read_text())
            for value in (summary, manifest):
                self.assertEqual(value['task_id'], 'task-one')
                self.assertEqual(value['task_binding'], 'explicit-index')
            self.assertNotIn('PRIVATE', json.dumps(summary))
            with self.assertRaises(ValueError):
                excerpts.extract(index, root/'mismatched', expected_task='task-two')
            self.assertFalse((root/'mismatched').exists())


if __name__ == '__main__':
    unittest.main()
