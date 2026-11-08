import copy
import json
import pathlib
import tempfile
import unittest

import acceptance as a
import exporter as e


class Provider:
    def __init__(self, binding, proof):
        self.b, self.p = binding, proof
        self.rows, self.effects = [], []
        self.uncertain = False
        self.drift = False

    def refs(self):
        return {**{k: self.b[k] for k in ('head', 'base', 'tree', 'merge_base')},
                'local_head': self.b['head'], 'dirty': False}

    def proof(self):
        return self.p

    def prs(self):
        return copy.deepcopy(self.rows)

    def create(self):
        self.effects.append('create')
        self.rows.append({'number': 7, 'html_url': 'https://github.com/synscott/openrig/pull/7',
                          'node_id': 'PR7', 'state': 'open', 'draft': True,
                          'body': a.marker(self.b),
                          'head': {'ref': self.b['head_ref'], 'sha': self.b['head'],
                                   'repo': {'full_name': self.b['repo']}},
                          'base': {'ref': self.b['base_ref'], 'sha': self.b['base']}})
        if self.uncertain:
            raise TimeoutError()

    def get(self, number):
        return copy.deepcopy(self.rows[0])

    def draft(self, pr, value):
        self.effects.append('draft' if value else 'ready')
        self.rows[0]['draft'] = value
        if self.drift and not value:
            self.rows[0]['head']['sha'] = 'changed'


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.b = {'task_id': 'task-one', 'repo': 'synscott/openrig',
                  'repository': str(root), 'contract': str(root / 'contract.json'),
                  'contract_revision': 'c1', 'head': 'a' * 40, 'base': 'b' * 40,
                  'merge_base': 'b' * 40, 'tree': 'c' * 40, 'head_ref': 'pilot/task',
                  'base_ref': 'main', 'policy_revision': 'p1',
                  'proof_workspace': str(root), 'proof_scope': 'missions/pilot/slices/one',
                  'scope': 'pilot/slices/one', 'item_revisions': {'verify': 'i1', 'review': 'i2'},
                  'checks_receipt': 'checks.json', 'review_receipt': 'review.json'}
        self.contract = {'task_id': 'task-one', 'revision': 'c1', 'implementer': 'builder',
                         'judges': ['validator', 'reviewer'], 'checks': ['unit'], 'checks_item': 'verify', 'review_item': 'review',
                         'items': {'verify': {'judge': 'validator'}, 'review': {'judge': 'reviewer'}}}
        pathlib.Path(self.b['contract']).write_text(json.dumps(self.contract))
        self.b['contract_sha256'] = a.digest(self.b['contract'])
        self.p = {'configured': True, 'state': 'ready', 'issues': [], 'revision': 'r1',
                  'policy': {'revision': 'p1', 'judges': self.contract['judges']}, 'items': []}
        for ident, actor, ref in [('verify', 'validator', 'checks.json'), ('review', 'reviewer', 'review.json')]:
            receipt = {k: self.b[k] for k in ('task_id', 'contract_revision', 'head', 'base', 'merge_base', 'tree')}
            receipt.update(judge=actor, checks={'unit': 'pass'}, verdict='accept')
            path = root / ref
            path.write_text(json.dumps(receipt))
            self.p['items'].append({'id': ident, 'revision': self.b['item_revisions'][ident],
                                    'state': 'accepted', 'judgment': {
                                        'actor': actor, 'verdict': 'accept', 'scope': self.b['proof_scope'],
                                        'itemRevision': self.b['item_revisions'][ident], 'policyRevision': 'p1',
                                        'subject': {'kind': 'commit', 'ref': self.b['head']},
                                        'evidence': [{'ref': ref, 'sha256': a.digest(path)}]}})
        self.live = Provider(self.b, self.p)
        self.state = str(root / 'state.json')

    def run_boundary(self, op='ready'):
        return a.boundary(self.b, self.live, op, self.state)

    def test_ready_real_boundary_and_uncertain_create_reconciles(self):
        self.live.uncertain = True
        self.run_boundary('create-draft')
        self.run_boundary('create-draft')
        self.assertEqual(self.live.effects, ['create'])
        self.assertEqual(self.run_boundary()['state'], 'ready')
        self.assertEqual(self.live.effects, ['create', 'ready'])

    def test_failed_then_repaired_same_task_and_pr(self):
        self.run_boundary('create-draft')
        self.p['state'] = 'not-ready'
        with self.assertRaises(a.Rejected):
            self.run_boundary()
        self.assertNotIn('ready', self.live.effects)
        self.p['state'] = 'ready'
        self.assertEqual(self.run_boundary()['number'], 7)

    def test_invalid_proof_variants_block_action(self):
        self.run_boundary('create-draft')
        mutations = [lambda p: p.update(configured=False), lambda p: p.update(state='not-ready'),
                     lambda p: p['items'].pop(), lambda p: p['policy'].update(revision='old'),
                     lambda p: p['items'][0].update(revision='old'),
                     lambda p: p['items'][0]['judgment'].update(actor='builder'),
                     lambda p: p['items'][0]['judgment'].update(subject={'kind': 'commit', 'ref': 'wrong'})]
        original = copy.deepcopy(self.p)
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.p.clear()
                self.p.update(copy.deepcopy(original))
                mutation(self.p)
                with self.assertRaises(a.Rejected):
                    self.run_boundary()
                self.assertNotIn('ready', self.live.effects)

    def test_changed_evidence_contract_wrong_receipt_and_skip(self):
        self.run_boundary('create-draft')
        checks = pathlib.Path(self.b['proof_workspace']) / 'checks.json'
        original = checks.read_text()
        checks.write_text(original + ' ')
        with self.assertRaises(a.Rejected):
            self.run_boundary()
        for key, value in [('checks', {'unit': 'skip'}), ('head', 'wrong'), ('task_id', 'other')]:
            payload = json.loads(original)
            payload[key] = value
            checks.write_text(json.dumps(payload))
            self.p['items'][0]['judgment']['evidence'][0]['sha256'] = a.digest(checks)
            with self.assertRaises(a.Rejected):
                self.run_boundary()
        pathlib.Path(self.b['contract']).write_text('{}')
        with self.assertRaises(a.Rejected):
            self.run_boundary()

    def test_ref_drift_after_ready_rolls_back(self):
        self.run_boundary('create-draft')
        self.live.drift = True
        with self.assertRaises(a.Rejected):
            self.run_boundary()
        self.assertTrue(self.live.rows[0]['draft'])
        self.assertEqual(a.load(self.state)['state'], 'rejected-draft')

    def test_closed_existing_pr_blocks_duplicate(self):
        self.run_boundary('create-draft')
        self.live.rows[0]['state'] = 'closed'
        with self.assertRaises(a.Rejected):
            self.run_boundary('create-draft')
        self.assertEqual(self.live.effects, ['create'])

    def test_exporter_independent_sanitized_idempotent_and_failed_attempts(self):
        root = pathlib.Path(self.temp.name)
        history = root / 'native.jsonl'
        secret = 'sk-private-test-value /private/person/token'
        history.write_text(json.dumps({'payload': {'type': 'function_call', 'arguments': secret + ' --skip-checks'}}) + '\n')
        record = {'task_id': 'task-one', 'event_id': 'event1', 'kind': 'attempt',
                  'attempt_id': 'attempt1', 'outcome': 'failed', 'raw_prompt': secret,
                  'histories': [{'path': str(history), 'start': 1, 'end': 1}]}
        records = root / 'attempts.jsonl'
        records.write_text(json.dumps(record) + '\n')
        before = records.read_bytes()
        result = e.export('task-one', [records, records])
        self.assertEqual(len(result['attempts']), 1)
        self.assertEqual(result['attempts'][0]['histories'][0]['workaround_indicators'], 1)
        self.assertNotIn(secret, json.dumps(result))
        self.assertNotIn(str(root), json.dumps(result))
        self.assertEqual(records.read_bytes(), before)
        self.assertIn('usage', result['attempts'][0]['coverage_gaps'])
        self.assertEqual(e.export('task-one', [records]), result)
        record['outcome'] = 'succeeded'
        records.write_text(records.read_text() + json.dumps(record) + '\n')
        with self.assertRaises(ValueError):
            e.export('task-one', [records])


if __name__ == '__main__':
    unittest.main()
