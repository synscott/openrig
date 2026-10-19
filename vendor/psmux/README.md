# Patched psmux source recipe

This Windows experiment needs the server-epoch formats and checked-stop protocol
plus checked-input-v1 and checked-create-v1 protocols in this patch. Stock psmux 3.3.8 is **not** a substitute, and a `3.4.0` version
string alone does not identify the patched build.

Upstream: [psmux/psmux](https://github.com/psmux/psmux), commit
`20aa1d7254ee93f64dafa059ef89341d9767470a`, by its original authors.
The upstream code and our derivative patch are distributed under the accompanying
[MIT license](LICENSE), copyright 2025 Godwin Sam Josh. Preserve that notice with
the source and portable binaries. This does not relicense OpenRig itself.

`provenance.json` pins the upstream revision, exact `upstream.patch`, lockfile,
license and full 1,613-file patched-source manifest. No executable, private archive,
raw log, credentials or developer tool paths are shipped here. **No current
binary has been independently accepted:** `acceptedArtifact` is `null`.
The historical B compiler artifact lacks the current checked-input/create source
and must not be selected by digest, version string or PE shape.

From the OpenRig repository root, inspect the recipe without effects:

```powershell
node scripts/build-windows-psmux.mjs --plan
```

Prepare a new source directory by cloning the public upstream, checking out the
exact commit, applying the pinned patch and verifying every file:

```powershell
# The parent must already exist. Source/output destinations must not exist.
node scripts/build-windows-psmux.mjs --prepare-only --source-dir C:\Temp\psmux-source
node scripts/verify-windows-psmux.mjs --source C:\Temp\psmux-source
```

For offline source preparation, add `--upstream-local C:\path\to\psmux-git-clone`.
That clone must contain the exact upstream commit. Its dirty working files are
not copied. Source verification rejects missing, altered, extra or symlinked
inputs; build output belongs in a separate directory. Git metadata is excluded.

For a native build, open an **x64 Native Tools Command Prompt for VS 2022**, then
PowerShell inside it. Install Git for Windows, Node 22/24, Visual Studio's C++
Build Tools and Windows SDK, and Rust 1.98.0 MSVC using your normal installation
process. The helper does not install tools or update global configuration. The
previous artifact used MSVC 14.44 and SDK 10.0.22621; different tools may produce
different binary bytes even from identical source.

```powershell
# Fresh destinations; --fetch explicitly allows locked Cargo dependency downloads.
node scripts/build-windows-psmux.mjs --build --fetch --source-dir C:\Temp\psmux-build-source --output-dir C:\Temp\psmux-portable
node scripts/verify-windows-psmux.mjs --binary C:\Temp\psmux-portable\psmux.exe --receipt C:\Temp\psmux-portable\build-receipt.json
```

Without `--fetch`, Cargo runs frozen/offline. Supply `--cargo-home` with an
existing, separately prepared Cargo cache if building offline. Otherwise the
helper uses `output-dir/cargo-home`. Target files stay in `output-dir/target`.
The build uses jobs=1 and a single 90-minute command budget including preparation;
it never runs the resulting executable or any psmux session test. A command
timeout is a failure, **not** proof that all native descendants exited. Retain
failed directories and inspect owned processes before another attempt.

The helper verifies source before and after compilation and copies the resulting
binary to `psmux.exe` and the byte-identical `tmux.exe` alias in the fresh portable
directory. It includes `LICENSE.psmux` and a local build receipt. The receipt
binds source-manifest and binary hashes but is unsigned bookkeeping, not an
independent attestation. Source reproducibility does not promise byte-identical
binaries. Native compilation of this repository helper must be qualified in the
allocated Windows build environment; source reconstruction alone does not do so.

Binary-only `--binary FILE` verification and `--from-binary FILE` setup currently
refuse with an actionable missing-current-artifact error. Do not substitute an
old artifact or invent a pending digest. Once a current artifact is independently
accepted, its exact metadata can be bound in `provenance.json`. Until then, the
source/build route above produces an explicitly unsigned local build receipt;
that receipt verifies source and byte identity only and does not confer native
user-path acceptance. The helper never downloads a binary, starts a daemon,
changes persistent PATH or replaces an installed tool.
See [Windows setup](../../docs/reference/windows-support-experiment.md#current-patched-psmux-setup)
for selection, isolation and rollback. Keep local receipts outside public reports
unless reviewed and redacted; no environment or provider data belongs in them.
