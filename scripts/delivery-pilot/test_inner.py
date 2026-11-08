"""Disposable Forgejo boundary fixtures. No service calls or daemon judgments."""
import copy
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import acceptance as a
import forgejo as f
import test_pilot as pilot


class ForgejoProvider(pilot.Provider):
    def create(self):
        super().create()
        row = self.rows[-1]
        row.update(title=f.PREFIX + self.b['title'], body=self.b['body'] + '\n\n' + a.marker(self.b))
        row['base']['repo'] = {'full_name': self.b['repo']}
        row['html_url'] = 'https://forgejo.svc.echoes/lacuna/dione/pulls/123'

    def draft(self, pr, value):
        super().draft(pr, value)
        self.rows[0]['title'] = (f.PREFIX if value else '') + self.b['title']


class InnerTests(unittest.TestCase):
    def setUp(self):
        pilot.PilotTests.setUp(self)
        self.b.update(provider='forgejo', repo='lacuna/dione',
                      task_id='qitem-20261108185151-c6251a05', api_base=f.API,
                      git_remote=f.REMOTE, base_ref='refactor/discord-messaging-contracts-crate',
                      head_ref='refactor/discord-tool-contracts-crate',
                      local_ref='refactor/discord-tool-contracts',
                      title='Extract Discord tool contracts', body='Selected delivery')
        self.contract['task_id'] = self.b['task_id']
        pathlib.Path(self.b['contract']).write_text(json.dumps(self.contract))
        self.b['contract_sha256'] = a.digest(self.b['contract'])
        for item in self.p['items']:
            path = pathlib.Path(self.b['proof_workspace']) / item['judgment']['evidence'][0]['ref']
            payload = a.load(path)
            payload['task_id'] = self.b['task_id']
            path.write_text(json.dumps(payload))
            item['judgment']['evidence'][0]['sha256'] = a.digest(path)
        self.live = ForgejoProvider(self.b, self.p)

    def run_boundary(self, op='ready'):
        return a.boundary(self.b, self.live, op, self.state)

    def test_rejected_repaired_same_selected_task_and_pr(self):
        self.run_boundary('create-draft')
        self.p['state'] = 'not-ready'
        with self.assertRaises(a.Rejected):
            self.run_boundary()
        self.assertEqual(self.live.effects, ['create'])
        self.p['state'] = 'ready'
        result = self.run_boundary()
        self.assertEqual(result['number'], 7)
        self.assertEqual(result['task_id'], self.b['task_id'])
        self.assertFalse(self.live.rows[0]['draft'])

    def test_invalid_proof_never_makes_ready(self):
        self.run_boundary('create-draft')
        original = copy.deepcopy(self.p)
        mutations = [lambda p: p.update(configured=False), lambda p: p.update(state='not-ready'),
                     lambda p: p['items'].pop(), lambda p: p['policy'].update(revision='wrong'),
                     lambda p: p['items'][0].update(revision='wrong'),
                     lambda p: p['items'][0]['judgment'].update(actor=self.contract['implementer']),
                     lambda p: p['items'][0]['judgment'].update(subject={'kind': 'commit', 'ref': 'wrong'})]
        for mutation in mutations:
            self.p.clear()
            self.p.update(copy.deepcopy(original))
            mutation(self.p)
            with self.assertRaises(a.Rejected):
                self.run_boundary()
            self.assertNotIn('ready', self.live.effects)

    def test_evidence_contract_and_unapproved_skip_rejected(self):
        pilot.PilotTests.test_changed_evidence_contract_wrong_receipt_and_skip(self)

    def test_unknown_create_is_reconcile_only(self):
        pilot.PilotTests.test_unknown_create_persists_and_later_adopts_same_pr(self)

    def test_ref_drift_after_ready_rolls_back(self):
        pilot.PilotTests.test_ref_drift_after_ready_rolls_back(self)

    def test_wrong_binding_provider_and_state_rejected(self):
        self.run_boundary('create-draft')
        self.b['api_base'] = 'https://example.invalid'
        with self.assertRaises(a.Rejected):
            self.run_boundary()
        with self.assertRaises(a.Rejected):
            f.ForgejoLive(self.b)
        self.b['task_id'] = 'other'
        with self.assertRaises(a.Rejected):
            self.run_boundary()

    def test_all_states_duplicates_and_wrong_title_block(self):
        self.run_boundary('create-draft')
        self.live.rows[0]['title'] = 'unexpected'
        with self.assertRaises(a.Rejected):
            self.run_boundary()
        self.live.rows[0]['title'] = f.PREFIX + self.b['title']
        self.live.rows.append(copy.deepcopy(self.live.rows[0]))
        with self.assertRaises(a.Rejected):
            self.run_boundary('create-draft')
        self.assertEqual(self.live.effects, ['create'])

    def test_real_adapter_title_transition_requires_readback(self):
        self.run_boundary('create-draft')
        live = f.ForgejoLive(self.b)
        row = self.live.rows[0]
        def api(path, method='GET', fields=None):
            if method == 'PATCH':
                self.assertEqual(fields, {'title': self.b['title']})
                row.update(title=fields['title'], draft=False)
            return copy.deepcopy(row)
        with patch.object(live, 'api', side_effect=api):
            live.draft(copy.deepcopy(row), False)
        self.assertFalse(row['draft'])
        row.update(title=f.PREFIX + self.b['title'], draft=True)
        with patch.object(live, 'api', return_value=copy.deepcopy(row)):
            with self.assertRaises(a.Rejected):
                live.draft(copy.deepcopy(row), False)

    def test_real_adapter_create_pagination_and_transport_shapes(self):
        live = f.ForgejoLive(self.b)
        calls = []
        def api(path, method='GET', fields=None):
            calls.append((path, method, fields))
            return [{}] * 50 if path.endswith('page=1') else []
        with patch.object(live, 'api', side_effect=api):
            self.assertEqual(len(live.prs()), 50)
            live.create()
        self.assertEqual(calls[-1][2]['title'], f.PREFIX + self.b['title'])
        self.assertNotIn('draft', calls[-1][2])  # Installed schema has no writable draft.
        with patch.object(f.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '[]')) as run:
            live.api('/repos/lacuna/dione/pulls?state=all&limit=50&page=1')
            args = run.call_args
            self.assertEqual(args.args[0][0], f.POWERSHELL)
            self.assertNotIn('FORGEJO_ECHOES_API', args.kwargs['input'])
        with self.assertRaises(a.Rejected):
            live.api('/repos/other/repo/pulls', 'POST', {})

    def test_actual_adapter_drift_is_reverted_to_draft(self):
        self.run_boundary('create-draft')
        live = f.ForgejoLive(self.b)
        row = self.live.rows[0]
        def api(path, method='GET', fields=None):
            if '?' in path:
                return [copy.deepcopy(row)]
            if method == 'PATCH':
                row.update(title=fields['title'], draft=fields['title'].startswith(f.PREFIX))
                if not row['draft']:
                    row['head']['sha'] = 'changed'
            return copy.deepcopy(row)
        with patch.object(live, 'api', side_effect=api), \
                patch.object(live, 'refs', side_effect=self.live.refs), \
                patch.object(live, 'actors', side_effect=self.live.actors), \
                patch.object(live, 'proof', side_effect=self.live.proof):
            with self.assertRaises(a.Rejected):
                a.boundary(self.b, live, 'ready', self.state)
        self.assertTrue(row['draft'])
        self.assertEqual(a.load(self.state)['state'], 'rejected-draft')

    def test_writer_records_rejection_repair_and_no_replay(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        records = str(pathlib.Path(outside.name) / 'attempts.jsonl')
        self.state = str(pathlib.Path(outside.name) / 'publication.json')
        a.invocation(self.b, self.live, 'create-draft', self.state, records, 'create1')
        self.p['state'] = 'not-ready'
        with self.assertRaises(a.Rejected):
            a.invocation(self.b, self.live, 'ready', self.state, records, 'ready1')
        self.p['state'] = 'ready'
        a.invocation(self.b, self.live, 'ready', self.state, records, 'ready2')
        rows = [json.loads(z) for z in pathlib.Path(records).read_text().splitlines()]
        self.assertEqual([z['kind'] for z in rows], ['attempt-start', 'attempt'] * 3)
        self.assertEqual([z['outcome'] for z in rows if z['kind'] == 'attempt'],
                         ['succeeded', 'rejected', 'succeeded'])
        self.assertEqual(len({z['event_id'] for z in rows}), 6)
        self.assertTrue(all(z['checks'] == [] for z in rows))
        self.assertFalse(rows[-1]['publication']['draft'])
        self.assertNotIn('url', rows[-1]['publication'])
        effects = list(self.live.effects)
        with self.assertRaises(a.Rejected):
            a.invocation(self.b, self.live, 'ready', self.state, records, 'ready2')
        self.assertEqual(self.live.effects, effects)


if __name__ == '__main__':
    unittest.main()
