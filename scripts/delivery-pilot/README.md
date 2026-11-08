# Opt-in delivery pilot

## Selected Forgejo episode

The additional `forgejo` adapter is restricted to existing task
`qitem-20261108185151-c6251a05` in `lacuna/dione`. This is a late prospective
completion contract: implementation had already started when the task was selected
at 19:05 UTC on 2026-11-08. It does not retroactively govern earlier work.

Add these fields to the external binding alongside the existing fixed contract,
daemon policy/item revisions, evidence references and exact H/B/M/tree:

```json
{
  "provider": "forgejo",
  "repo": "lacuna/dione",
  "api_base": "https://forgejo.svc.echoes/api/v1",
  "git_remote": "forgejo-echoes:lacuna/dione.git",
  "local_ref": "refactor/discord-tool-contracts",
  "head_ref": "refactor/discord-tool-contracts-crate",
  "base_ref": "refactor/discord-messaging-contracts-crate"
}
```

Record this local/remote branch mapping before the existing authorized publisher
pushes the selected candidate. The local origin is a retained filesystem clone;
the adapter checks the explicit established SSH remote, not that origin. It does
not push, merge, dispatch CI, change protections or publish to GitHub. Its protected
API calls use the existing Windows worker environment privately; no token belongs
in the binding or evidence. Only the named `acceptance.py` invocation is guarded:
other clients, direct API calls and source branch pushes remain outside it.

The observed installed Forgejo schema exposes `draft` on reads, but has no
writable draft field or ready endpoint. Creation uses a `WIP: ` title; ready removes
that prefix and rollback restores it. Every transition must read back the actual
boolean draft state and exact title. Unsupported behavior is rejected, not treated
as readiness. Provider reads also guard authenticated repository/account custody.
This is a checked title transition, not an atomic server compare-and-swap. A failed
rollback is unknown and needs reconciliation.

Run this adapter only after independent exact-tooling-head QA and review. Draft
creation may precede delivery proof acceptance for ordinary CI. Ready consumes the
same installed daemon judgments as the original pilot; JSON fixtures are not live
judgments. Required checks and approved skips come from the fixed contract, not
from the exporter or a successful wrapper exit.

```sh
python3 -B scripts/delivery-pilot/acceptance.py create-draft --binding /external/binding.json --state /external/publication.json --records /external/attempts.jsonl --attempt-id draft-1
python3 -B scripts/delivery-pilot/acceptance.py ready --binding /external/binding.json --state /external/publication.json --records /external/attempts.jsonl --attempt-id ready-1
```

Each selected invocation appends an `attempt-start` before calling the boundary,
then a terminal `attempt` with the same attempt ID and distinct deterministic event
IDs. Times describe this actual invocation; `recorded_at` is separate. A start-only
record remains unknown if execution is interrupted. An already recorded attempt ID
cannot rerun effects. Reconcile existing operation state using a new invocation
identity, keeping uncertain-create state and the same PR; the adapter never retries
an uncertain create POST automatically. Writer records do not assert individual
check results and do not trigger Research. The owner separately records the final
logical task handoff for the independent outer intake. Export retry never calls
this publisher. Records/state stay outside candidate source.

Offline adapter fixtures: `python3 -B -m unittest discover -s scripts/delivery-pilot -p 'test_*.py' -v`.
They prove deterministic rejection/repair, title/readback, uncertain creation and
drift recovery in disposable fixtures. They do not prove a live Forgejo transition,
current daemon readiness, provider health or the selected delivery's acceptance.

These two Python 3.9+ standard-library tools serve task
`qitem-optin-delivery-pilot-20261108`. They do not register a global gate or change
OpenRig itself. The parent owns the fixed external contract, binding, proof
judgments and publication. The implementer never judges its own work.

## Protected route

Only `acceptance.py ready --binding FILE --state FILE` is protected. Other GitHub
clients, direct APIs and repository settings are outside this pilot. Draft
creation is allowed before proof readiness for CI. No merge or deployment path
exists in this adapter.

The adapter calls installed `rig proof show SCOPE --json` and consumes the actual
slice readiness shape. `configured`, `state`, `issues`, `policy.judges`,
`policy.revision`, item revisions and retained `judgment` fields are checked.
Every contract item must be present. The live daemon-attributed actor must be the
contract-selected judge and differ from the implementer. Check and review judges
must differ. Whole-file JSON evidence must retain its judgment SHA256. Addressed
Markdown evidence is deliberately unsupported and fails closed.

`head` is the exact candidate commit H. `base` is the current target branch tip
B, not a merge base. `merge_base` is Git's separately computed M for B...H review.
The checker requires local HEAD H, actual origin head H, actual origin base B,
Git tree and M. Base churn makes acceptance stale even when M is unchanged.
Evidence and refs are checked before and after the ready mutation. Drift after
mutation triggers conversion back to draft. A failed rollback remains unknown.
Same-user processes and the installed daemon are trusted. This is not isolation
against a malicious privileged actor or an atomic GitHub compare-and-swap.

GitHub is fixed to `synscott/openrig`, using authenticated `gh api`. Local git
origin must match that repository. The parent selects title/body and task marker.
All PR states are read with pagination before creation. Exact branch/base matches
must have the task marker; closed/merged or duplicate matches block. A timed-out
create is reconciled before any retry. A found PR is reused. After a recorded uncertain create, even a currently empty list remains reconcile-only.
A delayed matching PR is adopted. The tool never automatically retries that POST.
Operation state pins task, repository, head branch, target branch and target SHA;
a mismatched state file fails closed. Failed or ambiguous reads also block. Operation state belongs
outside source and records unknown outcomes, PR number and URL. One parent owns
this route at a time; concurrent publishers are unsupported.

## External binding and contract

Binding keys are shown with illustrative values. Use actual SHA values and paths.
Do not commit receipts, histories or credentials.

```json
{
  "task_id": "qitem-optin-delivery-pilot-20261108",
  "repo": "synscott/openrig",
  "repository": "/path/to/isolated/repository",
  "scope": "project:pilot/slices/one",
  "proof_scope": "missions/pilot/slices/one",
  "proof_workspace": "/path/to/proof/workspace",
  "contract": "/path/to/fixed-contract.json",
  "contract_sha256": "SHA256",
  "contract_revision": "c1",
  "policy_revision": "INSTALLED_POLICY_REVISION",
  "item_revisions": {"verify": "INSTALLED_ITEM_REVISION", "review": "INSTALLED_ITEM_REVISION"},
  "checks_receipt": "proof/checks.json",
  "review_receipt": "proof/review.json",
  "head": "H", "base": "B", "merge_base": "M", "tree": "TREE",
  "head_ref": "pilot/evidence-delivery-20261108", "base_ref": "main",
  "title": "Opt-in delivery proof pilot",
  "body": "Scope, validation and limits supplied by the authorized parent"
}
```

Fixed contract shape:

```json
{
  "task_id": "qitem-optin-delivery-pilot-20261108", "revision": "c1",
  "implementer": "IMPLEMENTER_ID",
  "judges": ["VALIDATOR_SEAT", "REVIEWER_SEAT"],
  "items": {"verify": {"judge": "VALIDATOR_SEAT"}, "review": {"judge": "REVIEWER_SEAT"}},
  "checks_item": "verify", "review_item": "review",
  "checks": ["boundary-fixtures", "bounded-independent-validation"],
  "approved_skips": []
}
```

Both receipts contain `task_id`, `contract_revision`, `head`, `base`, `merge_base`,
`tree` and `judge`. Checks receipt adds `checks` mapping exact required check names
to `pass`. Review receipt adds `verdict: accept`. The implementer and selected judges must exist in the live daemon registry
(`rig ps --nodes -A --json`). Delegates retain their registered owning actor.
The authoritative actor is the live proof judgment, not the receipt's asserted name. The corresponding judgment
subject must be exactly `{"kind":"commit","ref":"H"}`. Capture and queue closure
alone never count as acceptance.

```sh
python3 scripts/delivery-pilot/acceptance.py create-draft --binding /external/binding.json --state /external/publication.json
python3 scripts/delivery-pilot/acceptance.py check --binding /external/binding.json --state /external/publication.json
python3 scripts/delivery-pilot/acceptance.py ready --binding /external/binding.json --state /external/publication.json
```

## Independent retrospective export

The exporter reads immutable writer-produced JSONL records. It does not write
attempt truth, invoke implementation, publish, or emit acceptance. Each record
has `task_id`, stable `event_id`, `attempt_id`, and `kind`. Export requires the fixed
contract. The task must match it. Exported contract revisions must match it, and check
names must belong to its check list. Unrecognized prior contract revisions or
check names are omitted with explicit gaps while their terminal attempts remain.
Raw historical metadata stays local. Check outcomes use a finite enum. Event and attempt identifiers
are consistently SHA256-hashed, including handoffs; their raw values remain local.

An `attempt` supplies terminal `outcome` from `failed`, `abandoned`, `repaired`,
`succeeded`, `rejected`, or `infrastructure-failed`; missing terminal outcome is
explicitly unknown. Optional fields are `started_at`, `ended_at`, numeric `usage`,
`revisions`, `checks`, and explicit native `histories` ranges. A `handoff` supplies
`owner` and `time`. Repeated identical event IDs deduplicate; conflicting event or
attempt identities fail. Earlier terminal attempts must be retained by the writer.
The exporter cannot infer attempts the writer omitted.

A history range is `{ "path": "/local/native.jsonl", "start": 1, "end": 15 }`.
Only supplied ranges are read. Native Codex function calls/results and Claude
message tool-use/results produce counts. Raw prompts, messages, tool arguments,
results and source paths stay local. Opaque history path hashes and range-content hashes
support local joins. A disposable `--skip-checks` fixture produces a workaround
indicator, not a conclusion of misconduct. It must never be seeded in live work.
Missing or malformed optional history, usage or timing becomes a coverage gap.
Handoff owner identities stay local; exported owner references are null with an
explicit gap, rather than guessable hashes of names.

```sh
python3 scripts/delivery-pilot/exporter.py --task qitem-optin-delivery-pilot-20261108 --contract /external/fixed-contract.json --records /external/attempts.jsonl --output /external/retrospective.json
python3 -m unittest discover -s scripts/delivery-pilot -p test_pilot.py -v
```

Export retry is independent of ready/publication. Output is a sanitized allowlist;
contract-controlled metadata is allowlisted and timestamps are validated. Raw histories remain local.
Usage is supplied telemetry, never inferred cost. Scores and improvement proposals
remain asynchronous and do not alter acceptance rules.
