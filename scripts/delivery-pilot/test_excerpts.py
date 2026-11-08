import hashlib
import json
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

import excerpts


class ExcerptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root/'PRIVATE-native'
        self.rows = [b'prefix PRIVATE\n']
        for kind, stamp in [('function_call', '2026-11-08T20:00:00Z'),
                            ('function_call_output', '2026-11-08T20:00:01Z')]:
            self.rows.append((json.dumps({'timestamp': stamp, 'payload': {
                'type': kind, 'call_id': 'PRIVATE-call', 'arguments': 'PRIVATE'}})+'\n').encode())
        self.source.write_bytes(b''.join(self.rows))
        self.index = {'task_id': 'task', 'path': str(self.source), 'format': 'codex',
                      'links': [{'start': 2, 'end': 3, 'call_id': 'PRIVATE-call'}]}

    def test_exact_bytes_provenance_permissions_and_public_privacy(self):
        output = self.root/'output'
        summary = excerpts.extract(self.index, output)
        manifest = json.loads((output/'manifest.json').read_text())
        link = manifest['links'][0]
        self.assertEqual(link['original_range'], [2, 3])
        self.assertEqual(link['excerpt_range'], [1, 2])
        raw = (output/link['excerpt_file']).read_bytes()
        self.assertEqual(raw, b''.join(self.rows[1:]))
        self.assertEqual(link['selected_bytes_sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
        for path in output.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(summary['links'][0]['status'], 'joined')
        self.assertEqual(summary['linkage_scope'], 'wrapper-launch-first-receipt')
        self.assertNotIn('PRIVATE', json.dumps(summary))
        self.assertNotIn(str(self.root), json.dumps(summary))

    def test_invalid_overlapping_and_truncated_ranges_fail(self):
        for links in ([{'start': True, 'end': 3, 'call_id': 'x'}],
                      [{'start': 3, 'end': 2, 'call_id': 'x'}],
                      [self.index['links'][0], {'start': 4, 'end': 5, 'call_id': 'PRIVATE-call'}],
                      [self.index['links'][0], {'start': 3, 'end': 4, 'call_id': 'other'}],
                      [{'start': 2, 'end': 4, 'call_id': 'x'}]):
            with self.subTest(links=links), tempfile.TemporaryDirectory(dir=self.root) as parent:
                with self.assertRaises(ValueError):
                    excerpts.extract({**self.index, 'links': links}, pathlib.Path(parent)/'out')

    def test_read_line_and_output_bounds_fail(self):
        for limits in ({'scan_bytes': 8}, {'scan_lines': 2}, {'line_bytes': 4}, {'output_bytes': 8}):
            with self.subTest(limits=limits), tempfile.TemporaryDirectory(dir=self.root) as parent:
                with self.assertRaises(ValueError):
                    excerpts.extract(self.index, pathlib.Path(parent)/'out', limits=limits)

    def test_sequence_failure_is_reported_not_inferred(self):
        self.source.write_bytes(self.rows[0] + self.rows[2] + self.rows[1])
        summary = excerpts.extract(self.index, self.root/'out')
        self.assertEqual(summary['links'][0]['status'], 'join-unavailable')
        self.assertIsNone(summary['links'][0]['join'])

    def test_malformed_native_line_and_nonregular_source_fail_without_output(self):
        self.source.write_bytes(self.rows[0] + b'not JSON\n' + self.rows[2])
        with self.assertRaises(ValueError):
            excerpts.extract(self.index, self.root/'out')
        self.assertFalse((self.root/'out').exists())
        import os
        fifo = self.root/'fifo'
        os.mkfifo(fifo)
        with self.assertRaises(ValueError):
            excerpts.extract({**self.index, 'path': str(fifo)}, self.root/'out')

    def test_cli_never_prints_raw_native_content_or_overwrites_output(self):
        index = self.root/'index.json'
        index.write_text(json.dumps(self.index))
        command = [sys.executable, '-B', str(pathlib.Path(excerpts.__file__)),
                   '--index', str(index), '--output-dir', str(self.root/'out')]
        result = subprocess.run(command, capture_output=True, timeout=10, check=True)
        self.assertNotIn(b'PRIVATE', result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['links'][0]['status'], 'joined')
        again = subprocess.run(command, capture_output=True, timeout=10)
        self.assertNotEqual(again.returncode, 0)
        self.assertNotIn(str(self.root).encode(), again.stdout + again.stderr)


if __name__ == '__main__':
    unittest.main()
