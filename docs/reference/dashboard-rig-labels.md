# Dashboard rig display labels

A dashboard label changes how a rig is shown, without changing its identity.
The TUI shows `Label (canonical-name)` in the rig sidebar, table and headers.
In constrained table/list cells, the canonical name comes first when the full
label and name would be clipped. Two rigs may share a label; their canonical
identity takes priority over cosmetic text. Commands,
filters, links, queue addresses, history and health scope still use canonical
names and IDs. A label is not a command alias.

Use the stable `rigId` from `rig ps --json`, not a rig's name. Replace `RIG_ID`
below with that ID:

```sh
rig config set dashboard.rig_labels.RIG_ID "Build team"
rig config get dashboard.rig_labels.RIG_ID --json
rig config reset dashboard.rig_labels.RIG_ID
```

Labels accept 1–64 Unicode characters after trimming surrounding whitespace.
Newlines, terminal control sequences and directional override controls are
rejected. Reset removes the override and restores the canonical name. Only
stable ULID rig IDs are accepted as key segments; a renamed/recreated rig with
a different ID does not inherit another rig's label.

The setting persists in the current instance's `config.json`, under
`dashboard.rigLabels`, as a map from stable rig IDs to strings. It has no
environment-variable override. Configure the daemon's instance home, not a
different local or remote instance. No database migration is needed.

The existing config API supports the same key:

- `POST /api/config/dashboard.rig_labels.RIG_ID` with `{"value":"Build team"}`.
- `GET /api/config/dashboard.rig_labels.RIG_ID` returns its value and source.
- `DELETE /api/config/dashboard.rig_labels.RIG_ID` clears the override.

`GET /api/rigs/summary` adds `displayLabel` to configured rigs. Its `id` and
`name` remain canonical. Invalid stored entries are ignored independently;
valid siblings still load. An unreadable or malformed configuration falls
back to canonical names. The summary marks label-read problems with
`displayLabelError: true`, and the TUI names that read problem without changing
health or lifecycle results.

Once code supporting labels is installed, the daemon rereads label settings on
each summary request. An ordinary TUI refresh shows updates; no rig relaunch
or agent restart is needed for a configuration change. Installing the new
daemon and TUI code is a separate deployment operation. Preserve local source
customizations and live agent state when preparing that update.
