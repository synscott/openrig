"""One selected Forgejo delivery through the already established worker transport.

The installed server exposes draft on reads, but only title on writes. WIP title
transitions are accepted only when provider readback confirms actual draft state.
No merge, push, credential export, or alternate provider route is implemented.
"""
import base64
import json
import os
import re
import subprocess

from acceptance import Live, marker, repository_authorized, require


API = 'https://forgejo.svc.echoes/api/v1'
REMOTE = 'forgejo-echoes:lacuna/dione.git'
POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
SSH = ('/mnt/c/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes '
       '-o StrictHostKeyChecking=yes -o ConnectTimeout=10')
PREFIX = 'WIP: '

# Data travels via stdin; the token stays inside the existing Windows user env.
TRANSPORT = r"""
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
try {
 $q=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))|ConvertFrom-Json
 $v=[Environment]::GetEnvironmentVariable('FORGEJO_ECHOES_API','User')
 $h=@{Authorization=('token '+$v)};$root='https://forgejo.svc.echoes/api/v1'
 $u=Invoke-RestMethod -Uri ($root+'/user') -Headers $h -MaximumRedirection 0 -TimeoutSec 20
 $r=Invoke-RestMethod -Uri ($root+'/repos/lacuna/dione') -Headers $h -MaximumRedirection 0 -TimeoutSec 20
 if($u.login -cne 'synscott' -or $r.full_name -cne 'lacuna/dione' -or !$r.permissions.push){throw 'identity'}
 $requestArgs=@{Uri=($root+$q.path);Headers=$h;Method=$q.method;MaximumRedirection=0;TimeoutSec=20}
 if($q.method -ne 'GET'){$requestArgs.ContentType='application/json; charset=utf-8';$requestArgs.Body=[Text.Encoding]::UTF8.GetBytes(($q.fields|ConvertTo-Json -Depth 8 -Compress))}
 $result=Invoke-RestMethod @requestArgs
 if($q.list){ConvertTo-Json -InputObject @($result|ForEach-Object {$_}) -Depth 20 -Compress}
 else{$result|ConvertTo-Json -Depth 20 -Compress}
} catch { [Console]::Error.WriteLine('protected Forgejo request failed; reconcile any attempted mutation');exit 1 }
"""


class ForgejoLive(Live):
    def __init__(self, binding):
        super().__init__(binding)
        repository_authorized(binding)
        require(binding.get('api_base') == API and binding.get('git_remote') == REMOTE,
                'Forgejo transport binding mismatch')
        require(binding.get('base_ref') == 'refactor/discord-messaging-contracts-crate',
                'selected target mismatch')
        require(binding.get('head_ref') == 'refactor/discord-tool-contracts-crate',
                'selected source ref mismatch')
        require(binding.get('local_ref') == 'refactor/discord-tool-contracts',
                'selected local source mapping missing')
        require(binding.get('title') and not re.match(r'(?i)(?:wip|draft)\b', binding['title']),
                'ready title must not carry a draft prefix')

    def refs(self):
        require(self.git('symbolic-ref', '--short', 'HEAD') == self.b['local_ref'],
                'selected local branch changed')
        result = subprocess.run(
            ['git', 'ls-remote', REMOTE, 'refs/heads/' + self.b['head_ref'],
             'refs/heads/' + self.b['base_ref']], cwd=self.b['repository'],
            env={**os.environ, 'GIT_SSH_COMMAND': SSH}, check=True,
            capture_output=True, text=True, timeout=30)
        refs = dict((line.split()[1], line.split()[0]) for line in result.stdout.splitlines())
        return {'head': refs.get('refs/heads/' + self.b['head_ref']),
                'base': refs.get('refs/heads/' + self.b['base_ref']),
                'local_head': self.git('rev-parse', 'HEAD'),
                'tree': self.git('rev-parse', self.b['head'] + '^{tree}'),
                'merge_base': self.git('merge-base', self.b['head'], self.b['base']),
                'dirty': bool(self.git('status', '--porcelain'))}

    def api(self, endpoint, method='GET', fields=None):
        listing = bool(re.fullmatch(
            r'/repos/lacuna/dione/pulls\?state=all&limit=50&page=[1-9][0-9]*', endpoint))
        single = bool(re.fullmatch(r'/repos/lacuna/dione/pulls/[1-9][0-9]*', endpoint))
        require((method == 'GET' and (listing or single))
                or (method == 'POST' and endpoint == '/repos/lacuna/dione/pulls')
                or (method == 'PATCH' and single and set(fields or {}) == {'title'}),
                'unsupported Forgejo operation')
        payload = base64.b64encode(json.dumps(
            {'path': endpoint, 'method': method, 'fields': fields, 'list': listing}).encode()).decode()
        result = subprocess.run(
            [POWERSHELL, '-NoProfile', '-NonInteractive', '-EncodedCommand',
             base64.b64encode(TRANSPORT.encode('utf-16le')).decode()],
            input=payload, capture_output=True, text=True, timeout=45)
        if result.returncode != 0:
            raise RuntimeError('protected request failed; reconcile before retry')
        return json.loads(result.stdout)

    def checked(self, pr):
        require(isinstance(pr.get('draft'), bool), 'provider did not expose draft state')
        require(pr.get('title') == (PREFIX if pr['draft'] else '') + self.b['title'],
                'provider title/draft mismatch')
        require(pr.get('base', {}).get('repo', {}).get('full_name') == self.b['repo'],
                'wrong target repository')
        require(pr.get('head', {}).get('repo', {}).get('full_name') == self.b['repo'],
                'wrong source repository')
        return pr

    def prs(self):
        rows = []
        for page in range(1, 101):
            batch = self.api('/repos/lacuna/dione/pulls?state=all&limit=50&page=' + str(page))
            require(isinstance(batch, list), 'invalid PR listing')
            rows.extend(batch)
            if len(batch) < 50:
                return rows
        require(False, 'PR pagination incomplete')

    def create(self):
        return self.api('/repos/lacuna/dione/pulls', 'POST', {
            'title': PREFIX + self.b['title'], 'body': self.b['body'] + '\n\n' + marker(self.b),
            'head': self.b['head_ref'], 'base': self.b['base_ref']})

    def get(self, number):
        return self.checked(self.api('/repos/lacuna/dione/pulls/' + str(number)))

    def draft(self, pr, value):
        current = self.get(pr['number'])
        require(current['state'] == 'open' and not current.get('merged')
                and current['head']['ref'] == self.b['head_ref']
                and current['base']['ref'] == self.b['base_ref']
                and current.get('body') == self.b['body'] + '\n\n' + marker(self.b),
                'PR identity changed before title transition')
        if not value:
            require(current['head']['sha'] == pr['head']['sha']
                    and current['base']['sha'] == pr['base']['sha'], 'PR changed before ready')
        self.api('/repos/lacuna/dione/pulls/' + str(pr['number']), 'PATCH',
                 {'title': (PREFIX if value else '') + self.b['title']})
        require(self.get(pr['number'])['draft'] is value, 'draft transition unconfirmed')
