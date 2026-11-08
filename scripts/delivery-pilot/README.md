# Opt-in delivery pilot

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
has `task_id`, stable `event_id`, `attempt_id`, and `kind`.

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
python3 scripts/delivery-pilot/exporter.py --task qitem-optin-delivery-pilot-20261108 --records /external/attempts.jsonl --output /external/retrospective.json
python3 -m unittest discover -s scripts/delivery-pilot -p test_pilot.py -v
```

Export retry is independent of ready/publication. Output is a sanitized allowlist;
metadata identifiers reject token-like patterns and timestamps are validated. Raw histories remain local.
Usage is supplied telemetry, never inferred cost. Scores and improvement proposals
remain asynchronous and do not alter acceptance rules.
