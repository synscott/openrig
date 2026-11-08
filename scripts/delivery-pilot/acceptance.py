#!/usr/bin/env python3
"""Opt-in proof-consuming draft/ready boundary. Never merges or deploys."""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys


class Rejected(Exception):
    pass


def require(ok, reason):
    if not ok:
        raise Rejected(reason)


def load(path):
    return json.loads(pathlib.Path(path).read_text())


def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def command(args, cwd=None):
    return subprocess.run(args, cwd=cwd, check=True, capture_output=True,
                          text=True, timeout=45).stdout.strip()


class Live:
    def __init__(self, binding):
        self.b = binding

    def git(self, *args):
        return command(['git', *args], self.b['repository'])

    def refs(self):
        remote = self.git('remote', 'get-url', 'origin')
        require(remote in ('https://github.com/synscott/openrig.git',
                           'https://github.com/synscott/openrig',
                           'git@github.com:synscott/openrig.git'), 'repository mismatch')
        refs = dict((line.split()[1], line.split()[0]) for line in
                    self.git('ls-remote', 'origin', 'refs/heads/' + self.b['head_ref'],
                             'refs/heads/' + self.b['base_ref']).splitlines())
        return {'head': refs.get('refs/heads/' + self.b['head_ref']),
                'base': refs.get('refs/heads/' + self.b['base_ref']),
                'local_head': self.git('rev-parse', 'HEAD'),
                'tree': self.git('rev-parse', self.b['head'] + '^{tree}'),
                'merge_base': self.git('merge-base', self.b['head'], self.b['base']),
                'dirty': bool(self.git('status', '--porcelain'))}

    def actors(self):
        rows = json.loads(command(['rig', 'ps', '--nodes', '-A', '--json']))
        return {row['canonicalSessionName'] for row in rows
                if row.get('runtime') != 'terminal'}

    def proof(self):
        return json.loads(command(['rig', 'proof', 'show', self.b['scope'], '--json']))

    def api(self, endpoint, method='GET', fields=None):
        args = ['gh', 'api', endpoint, '--method', method]
        for key, value in (fields or {}).items():
            args.extend(['-F' if isinstance(value, bool) else '-f',
                         key + '=' + (json.dumps(value) if isinstance(value, bool) else str(value))])
        return json.loads(command(args))

    def prs(self):
        rows, page = [], 1
        while True:
            batch = self.api('repos/synscott/openrig/pulls?state=all&per_page=100&page=' + str(page))
            rows.extend(batch)
            if len(batch) < 100:
                return rows
            page += 1
            require(page <= 100, 'PR pagination incomplete')

    def create(self):
        return self.api('repos/synscott/openrig/pulls', 'POST', {
            'title': self.b['title'], 'body': self.b['body'] + '\n\n' + marker(self.b),
            'head': self.b['head_ref'], 'base': self.b['base_ref'], 'draft': True})

    def get(self, number):
        return self.api('repos/synscott/openrig/pulls/' + str(number))

    def draft(self, pr, value):
        mutation = ('mutation($id:ID!){' +
                    ('convertPullRequestToDraft' if value else 'markPullRequestReadyForReview') +
                    '(input:{pullRequestId:$id}){pullRequest{id}}}')
        command(['gh', 'api', 'graphql', '-f', 'query=' + mutation,
                 '-f', 'id=' + pr['node_id']])


def marker(b):
    return '<!-- delivery-task:' + b['task_id'] + ' -->'


def repository_authorized(b):
    if b.get('provider', 'github') == 'github':
        require(b['repo'] == 'synscott/openrig', 'publisher repository not authorized')
    else:
        require(b.get('provider') == 'forgejo' and b['repo'] == 'lacuna/dione'
                and b['task_id'] == 'qitem-20261108185151-c6251a05',
                'publisher repository/task not authorized')


def refs_valid(b, live):
    for key in ('head', 'base', 'merge_base', 'tree'):
        require(bool(re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', b[key])), 'invalid Git identity')
    refs = live.refs()
    require(refs.get('dirty') is False, 'dirty candidate checkout')
    require(refs['base'] == b['base'], 'stale base tip')
    require(refs['head'] == refs['local_head'] == b['head'], 'stale candidate head')
    require(refs['tree'] == b['tree'], 'wrong candidate tree')
    require(refs['merge_base'] == b['merge_base'], 'wrong merge base')
    return refs


def acceptance(b, live):
    repository_authorized(b)
    refs_valid(b, live)
    require(digest(b['contract']) == b['contract_sha256'], 'contract changed')
    contract = load(b['contract'])
    require(contract['task_id'] == b['task_id'], 'wrong task')
    require(contract['revision'] == b['contract_revision'], 'wrong contract revision')
    actors_registered = live.actors()
    require(contract['implementer'] in actors_registered, 'implementer is not a registered actor')
    require(set(contract['judges']).issubset(actors_registered), 'judge is not a registered actor')
    proof = live.proof()
    require(proof.get('configured') is True and proof.get('state') == 'ready'
            and not proof.get('issues'), 'proof not ready')
    policy = proof['policy']
    require(policy['revision'] == b['policy_revision'], 'policy changed')
    require(set(policy['judges']) == set(contract['judges']), 'wrong judge policy')
    items = {item['id']: item for item in proof['items']}
    require(len(items) == len(proof['items']), 'duplicate proof item')
    require(set(items) == set(contract['items']), 'required proof items mismatch')
    evidence = {}
    actors = {}
    evidence_items = {}
    root = pathlib.Path(b['proof_workspace']).resolve()
    for ident, expected in contract['items'].items():
        item = items[ident]
        judgment = item['judgment']
        actor = judgment['actor']
        require(item['state'] == 'accepted' and judgment['verdict'] == 'accept', 'item not accepted')
        require(item['revision'] == judgment['itemRevision'] == b['item_revisions'][ident],
                'item revision changed')
        require(judgment['policyRevision'] == policy['revision'] and
                judgment['scope'] == b['proof_scope'], 'judgment scope/policy mismatch')
        require(actor in policy['judges'] and actor == expected['judge'] and
                actor != contract['implementer'], 'unauthorized or nonindependent judge')
        require(judgment['subject'] == {'kind': 'commit', 'ref': b['head']}, 'wrong proof subject')
        require(bool(judgment['evidence']), 'missing evidence')
        for entry in judgment['evidence']:
            require('#' not in entry['ref'], 'pilot requires whole-file evidence')
            path = (root / entry['ref']).resolve()
            require(path.is_relative_to(root), 'evidence outside workspace')
            require(digest(path) == entry['sha256'], 'evidence bytes changed')
            evidence[entry['ref']] = load(path)
            require(entry['ref'] not in evidence_items, 'ambiguous evidence ownership')
            actors[entry['ref']] = actor
            evidence_items[entry['ref']] = ident
    require(b['checks_receipt'] != b['review_receipt'], 'separate check and review receipts required')
    require(actors.get(b['checks_receipt']) != actors.get(b['review_receipt']),
            'check and review judges must be independent')
    for ref, role in ((b['checks_receipt'], 'checks'), (b['review_receipt'], 'review')):
        require(ref in evidence, 'missing ' + role + ' evidence')
        require(evidence_items[ref] == contract['checks_item' if role == 'checks' else 'review_item'],
                'receipt bound to wrong proof role')
        receipt = evidence[ref]
        for key in ('task_id', 'contract_revision', 'head', 'base', 'merge_base', 'tree'):
            require(receipt[key] == b[key], 'wrong receipt ' + key)
        require(receipt['judge'] == actors[ref], 'receipt actor mismatch')
        if role == 'checks':
            results = receipt['checks']
            require(set(results) == set(contract['checks']), 'required checks mismatch')
            for name, result in results.items():
                require(result == 'pass' or
                        (result == 'skip' and name in contract.get('approved_skips', [])),
                        'check not passed: ' + name)
        else:
            require(receipt['verdict'] == 'accept', 'review not accepted')
    return {'accepted': True, 'head': b['head'], 'base': b['base'],
            'merge_base': b['merge_base'], 'proof_revision': proof['revision']}


def pr_valid(b, pr):
    require(pr['head']['ref'] == b['head_ref'] and pr['base']['ref'] == b['base_ref'],
            'wrong PR branch')
    require(pr['head']['repo']['full_name'] == b['repo'], 'wrong PR repository')
    require(pr['head']['sha'] == b['head'] and pr['base']['sha'] == b['base'], 'PR refs changed')
    require(marker(b) in (pr.get('body') or ''), 'missing task marker')
    require(pr['state'] == 'open' and not pr.get('merged_at') and not pr.get('merged'),
            'PR already closed or merged')
    if b.get('provider') == 'forgejo':
        require(isinstance(pr.get('draft'), bool), 'provider did not expose draft state')
        require(pr.get('title') == ('WIP: ' if pr['draft'] else '') + b['title'],
                'provider title/draft mismatch')
        require(pr['base'].get('repo', {}).get('full_name') == b['repo'],
                'wrong target repository')
        require(pr.get('body') == b['body'] + '\n\n' + marker(b), 'PR body changed')


def reconcile(b, live):
    matches = [p for p in live.prs() if p['head']['ref'] == b['head_ref']
               and p['base']['ref'] == b['base_ref'] and
               p['head'].get('repo', {}).get('full_name') == b['repo']]
    require(len(matches) <= 1, 'ambiguous PR identity')
    if matches:
        pr_valid(b, matches[0])
        return matches[0]
    return None


def save_state(path, value):
    target = pathlib.Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.replace(target)


def invocation(b, live, operation, state_path, records_path, attempt_id):
    """Writer occurrence records; the independent exporter never calls this."""
    require(bool(re.fullmatch(r'[A-Za-z0-9_.:-]{1,160}', attempt_id)), 'invalid attempt ID')
    path = pathlib.Path(records_path)
    require(path.resolve() != pathlib.Path(state_path).resolve(), 'records and operation state must differ')
    root = pathlib.Path(b['repository']).resolve()
    require(not path.resolve().is_relative_to(root)
            and not pathlib.Path(state_path).resolve().is_relative_to(root),
            'operation records/state must stay outside candidate source')
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
    require(not any(row.get('attempt_id') == attempt_id for row in existing),
            'attempt already recorded; reconcile state, do not repeat invocation')
    identity = {key: b[key] for key in ('task_id', 'contract_revision', 'head', 'base',
                                      'merge_base', 'tree')}
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()

    def append(kind, **extra):
        suffix = 'start' if kind == 'attempt-start' else 'terminal'
        event_id = hashlib.sha256((b['task_id'] + ':' + attempt_id + ':' + suffix).encode()).hexdigest()
        row = {'task_id': b['task_id'], 'event_id': event_id, 'attempt_id': attempt_id,
               'kind': kind, 'operation': operation, 'started_at': started,
               'recorded_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'revisions': identity, 'checks': [], **extra}
        with path.open('a') as stream:
            stream.write(json.dumps(row, sort_keys=True) + '\n')
            stream.flush()
            os.fsync(stream.fileno())

    append('attempt-start')
    try:
        result = boundary(b, live, operation, state_path)
    except Exception as error:
        append('attempt', outcome='rejected' if isinstance(error, Rejected) else 'infrastructure-failed',
               ended_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
               error_kind=type(error).__name__)
        raise
    append('attempt', outcome='succeeded', ended_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
           publication={'provider': b.get('provider', 'github'), 'repo': b['repo'],
                        **{key: b[key] for key in ('head', 'base', 'merge_base', 'tree')},
                        **({'number': result['number']} if 'number' in result else {}),
                        **({'state': 'open'} if result.get('state') in ('draft', 'ready') else {}),
                        'draft': result.get('state') == 'draft' if 'state' in result else None})
    return result


def boundary(b, live, operation, state_path):
    repository_authorized(b)
    refs_valid(b, live)
    if operation == 'check':
        return acceptance(b, live)
    identity = {key: b[key] for key in ('task_id', 'repo', 'head_ref', 'base_ref', 'base')}
    if b.get('provider') == 'forgejo':
        identity.update(provider='forgejo', api_base=b['api_base'], git_remote=b['git_remote'])
    previous = load(state_path) if pathlib.Path(state_path).exists() else None
    if previous is not None:
        require(previous.get('operation_identity') == identity, 'publication state identity mismatch')
    pr = reconcile(b, live)
    if operation == 'create-draft':
        if pr is None:
            require(previous is None or previous.get('state') != 'create-unknown',
                    'create outcome unknown; reconcile-only until existing PR is found')
            save_state(state_path, {'operation_identity': identity,
                                    'task_id': b['task_id'], 'state': 'create-unknown'})
            try:
                live.create()
            except Exception:
                pass
            pr = reconcile(b, live)
            require(pr is not None, 'create outcome unknown; reconcile before retry')
        require(pr['draft'], 'existing PR is already ready')
        result = {'state': 'draft', 'number': pr['number'], 'url': pr['html_url']}
    else:
        require(pr is not None, 'no existing draft PR')
        acceptance(b, live)
        pr = live.get(pr['number'])
        pr_valid(b, pr)
        acceptance(b, live)
        try:
            if pr['draft']:
                live.draft(pr, False)
            current = live.get(pr['number'])
            pr_valid(b, current)
            acceptance(b, live)
            require(current['draft'] is False, 'ready outcome unconfirmed')
        except Exception:
            try:
                live.draft(pr, True)
                require(live.get(pr['number'])['draft'] is True, 'draft rollback unconfirmed')
                status = 'rejected-draft'
            except Exception:
                status = 'unknown-rollback'
            save_state(state_path, {'operation_identity': identity,
                                    'task_id': b['task_id'], 'state': status,
                                    'number': pr['number']})
            raise
        result = {'state': 'ready', 'number': current['number'], 'url': current['html_url']}
    result['task_id'] = b['task_id']
    result['operation_identity'] = identity
    save_state(state_path, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['check', 'create-draft', 'ready'])
    parser.add_argument('--binding', required=True)
    parser.add_argument('--state', required=True)
    parser.add_argument('--records', help='External append-only writer records, required for selected Forgejo task')
    parser.add_argument('--attempt-id', help='Fresh stable invocation identity; never reused to rerun effects')
    args = parser.parse_args()
    try:
        b = load(args.binding)
        if b.get('provider') == 'forgejo':
            from forgejo import ForgejoLive
            live = ForgejoLive(b)
            require(args.records and args.attempt_id, 'Forgejo invocation requires writer record identity')
        else:
            live = Live(b)
        result = (invocation(b, live, args.operation, args.state, args.records, args.attempt_id)
                  if args.records and args.attempt_id else boundary(b, live, args.operation, args.state))
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'accepted': False, 'error': str(error)}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
