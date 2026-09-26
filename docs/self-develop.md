# Build Redline inside Redline

An approved plan becomes background agent work in an isolated copy of the
source, a complete replacement application, and — once that application has
been built, checked, signed and actually *started* — an offer to restart into
it. You keep using the installed version throughout.

The whole design is one separation: **preparing** a change is not
**activating** it. Preparation can take an hour, can touch Redline's own
startup code, and can fail; none of that disturbs the copy you are working in.
Activation is short, recoverable, and happens only when you say so.

Surface: Runs → Build Redline. Entry is the tab and the readiness indicator;
there is no new header button.

## Three responsibilities, three processes

**The running application** owns plans, progress, review and the decision to
restart. It never installs anything itself.

**Preparation workers** edit and build a candidate inside a confined
subprocess. They cannot write to the installed bundle, read the live database
or the real hook configuration, signal the running Redline, or reach its
daemon.

**The activation helper** (`redline-activate`) survives Redline exiting. It
installs an already-prepared artifact, watches the new process start, and puts
the previous release back if it does not. It runs no agents, compiles nothing,
and executes no command a plan could choose.

The process being replaced is never responsible for finishing its own
replacement.

## Modules

| Module | Owns |
|---|---|
| `runtime_profile.rs` | Which *instance* this process is. Resolved before the database, the plugins or the window. |
| `confine.rs` | The `sandbox-exec` adapter, and the qualification that proves it works on this machine. |
| `self_develop.rs` | Candidate capture, the release record, the trusted pipeline, the command surface. |
| `release_manifest.rs` | What a release is: source fingerprint, artifact hashes, signing, checks, data compatibility — sealed. |
| `probe.rs` | What a candidate managed to do when it was actually started. |
| `activation.rs` | The app's half of a restart: preflight, quiesce, staging, handoff, handshake, recovery. |
| `crates/redline-activation` | The protocol both processes speak: transaction, journal, atomic exchange, handshake, locks. |
| `crates/redline-activate` | The helper binary. Three dependencies, and none of them is Redline. |

## Isolation

A candidate is started for real before it is ever offered. That is only safe if
the second instance touches nothing the first one owns, and changing the
database path alone would not do it — four other things are shared:

- **The single-instance plugin** hands a second launch to the incumbent and
  exits, which would report a healthy boot the candidate never performed. A
  probe does not install it.
- **`127.0.0.1:7676`** is already bound. A probe binds a private high port,
  and a report claiming the production port is treated as a *failed* probe.
- **WebView storage** is keyed to the bundle identifier, not the data
  directory. A probe runs with `incognito`, set on the window config before the
  window exists.
- **Outward effects** — hook repairs, capture, background agents, update
  checks, extensions — all reach outside the process. A probe runs with none of
  them.

See [Tauri single-instance behaviour](https://v2.tauri.app/plugin/single-instance/)
and [window configuration](https://v2.tauri.app/reference/config/#windowconfig).

## Confinement is qualified, not assumed

`sandbox-exec`'s underlying interfaces are deprecated, and the profile language
does not behave the way its documentation suggests. Three rules that read as
though they should work are silent no-ops on macOS 14 — verified, not assumed:

- Policy paths must be **fully resolved**. `/var/folders/...` is a symlink to
  `/private/var/folders/...`, so a policy written in the unresolved form
  matches nothing: an allow fails closed into a denial, and — far worse — a
  *deny* fails open into permission.
- `(deny signal (target others))` is accepted and does nothing. A bare
  `(deny signal)` followed by `(allow signal (target same-sandbox))` is what
  holds, and it keeps build tools able to manage their own children.
- Neither `(deny appleevent-send)` nor a `mach-lookup` denial of the AppleEvents
  service stops `osascript`. Refusing to *execute* the automation binaries is
  the mechanism that actually works.

So availability of the binary proves nothing. `confine::qualify` demonstrates
seven boundaries against live files, a live listener and a live process before
any preparation starts, and the escape checks are paired with unconfined
controls so a machine missing `nc` cannot "pass". If a demonstration fails,
preparation stops with the reason. It never falls back to running unconfined.

Rule order matters: the candidate workspace lives *inside* the application data
directory the policy denies, so the narrow allows come last (the sandbox is
last-match-wins). `a_workspace_nested_inside_a_denied_directory_is_still_writable`
is the test that pins it.

## The candidate workspace

One per release, under `<app data>/self-develop/<release>/source`, with its
**own** git repository rather than a share of the live checkout's metadata.

Captured: every tracked file and every untracked-but-unignored one, as they are
on disk — so the local modifications sitting in the checkout come along, and
the release panel says which. Never captured: credentials by shape (`.env*`,
`*.token`, `*.pem`, `*.key`, `id_rsa*`), the hook configuration, dependency
directories and build output.

Agents leave their edits uncommitted against a baseline commit, so "what did
the agents change?" is a plain diff. The source and its patch are retained
after installation, and `self_develop_patch` reports whether that patch would
still apply to your own checkout — which has been moving the whole time.

## The pipeline

Not nodes in the editable task graph, and deliberately so: the graph can be
edited, and if packaging and verification lived there, deleting a check node
would turn an unverified candidate into an installable release.

1. Resolve dependencies from the lockfile (`npm ci`).
2. Frontend tests, Rust tests.
3. Build the activation helper.
4. Build and package the application.
5. Size budget.
6. **Trusted, outside the sandbox:** insert the helper and the identity stamp,
   sign with the configured local identity, verify strictly.
7. **Start it:** launch the packaged candidate under a probe profile against a
   snapshot of the real database, and read its report.
8. Seal the manifest.

Signing happens separately from repository-controlled commands, and after the
helper and stamp go in — both are inside what the signature covers, so adding
either afterwards would leave a bundle that does not verify.

## Data compatibility is executed, not inferred

The question is not "does the schema change". It is whether the release you
would roll back to can still read what this one writes — so the probe's
*migrated* database is opened with the current build. If it opens and passes
the current build's schema check, there is a way back. If it does not, no
restart is offered and the release is presented as **Requires maintenance**.

Both stores are covered, because they are versioned independently and always
have been: this app stamps `user_version`, and the memory store keeps its own
key.

## Restart

`Preparing → Verifying → Ready → Quiescing → Activating → Checking startup →
Active`, plus `Failed`, `Outdated`, `Cancelled` and `Rolled back`. The record
lives in `releases`; the *activation* state does not, because activating a
release is one of the few things that can leave that database unopenable. It
lives in an append-only, fsynced journal under `<app data>/activation/<txn>/`.

What happens when you choose **Restart to apply**:

1. Revalidate everything **now** — artifact hash, permissions, free space,
   helper, and a live probe that this filesystem can exchange the bundle.
2. Stop admitting new work. The daemon refuses every mutating request with a
   reason and a `Retry-After`; the overnight queue stops dequeuing.
3. Ask the frontend to flush, and take back the state it wants restored.
4. Drain. If something is still mid-turn after 20s, say what it is and leave
   the decision with you. Redline is never force-quit out from under you.
5. Save the workspace, and a consistent database snapshot via SQLite's
   [backup facility](https://www.sqlite.org/backup.html) — never a copy of a
   live file. The quit-time snapshot is skipped, so the same work never runs
   twice.
6. Copy the verified artifact to a staging directory beside the installed
   application, and re-verify the copy.
7. Take the exit lock, start the helper, wait for it to acknowledge that it can
   finish alone, and only then quit.

Nothing expensive is left for after the exit: no dependency resolution, no
compilation, no signing, no bulk copying. A refusal at any step leaves the
current version running.

## The exchange

`renamex_np` with `RENAME_SWAP` exchanges the two paths atomically, with no
window in which neither exists — and the previous bundle survives at the other
path, which is what makes rollback a second exchange rather than a restore.
Support is probed **before** anything quits; an unsupported filesystem is a
refusal, never a fallback to deleting the installed application. Apple's
[rename contract](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/man/man2/rename.2)
documents the semantics.

An atomic exchange does not make the update atomic: the process can die between
performing the exchange and recording it. So recovery reads the **identity
stamp inside the installed bundle** and lets the artifact settle the
disagreement. `recovery_is_defined_at_every_journal_boundary` covers all
thirteen.

The helper runs from a copy of the *incumbent's* helper, placed outside either
exchanged bundle. A candidate can never supply the recovery implementation
supervising its own installation.

## Accepting a release

A running pid is not evidence, and neither is a visible window. The new process
reports stages, and only the last one counts:

`Started → Database → Daemon → Frontend → Workspace → Healthy`

`Frontend` is reported from `show_main_window`, which is the one signal that is
simultaneously "the frontend rendered" and "it completed a round trip to the
backend" — neither is observable from the backend alone. `Healthy` follows a
short interval of beats, each one a real read through the database, so a
process wedged on its storage stops beating rather than staying technically
alive.

Throughout the interval, user mutations and background side effects stay
gated: the hook repairs, the crown-jewels snapshot and the update check are
deferred until acceptance, because a release that gets rolled back must not
have edited your global configuration on its way past. A handshake tied to a
different transaction or a different release never counts — the old copy being
double-clicked cannot get a candidate accepted.

On failure the helper terminates the candidate, exchanges the bundles back,
relaunches the previous release **without** a handshake (a relaunch that
re-entered activation is a boot loop with extra steps), and writes a readable
report.

## Bootstrapping

The feature needs one conventional installation to introduce these foundations:
a bundle built before it existed carries no helper, and a development run has
no installed application to replace. `self_develop_available` says exactly
which of those is missing.

`scripts/redline.sh` is now a split: `scripts/redline-build.sh` prepares a
complete, signed, verified application and stops, and the installation goes
through `redline-activate install`, which takes the same installation lock and
performs the same atomic exchange. The old path's window — installed bundle
deleted, new one not yet copied, no durable record — is gone.

The build script redirects its *whole* stdout to stderr and emits the bundle
path on fd 3. That is load-bearing rather than tidy: the caller reads the path
with `$(...)`, and npm, cargo and the bundler all print progress to stdout, so
without it the caller captures an entire build log as a filename and reports
"no application was produced" at the end of a build that succeeded.

The lock is a zero-byte `.redline-install.lock` beside the installed
application. It is left in place deliberately — deleting an `flock` file while
another process holds it lets the next acquirer create a fresh inode and both
"hold" the lock at once.

## Testing

`cargo test -p redline-activation` and `cargo test -p redline-activate` are the
important ones. The end-to-end suite runs the real helper against disposable
bundles, exchanges real directories, and launches real processes that report
real handshakes: accepted, crashed during startup, reported its own failure,
hung before finishing, a foreign handshake, the old process still alive, the
prepared application missing, and both install-mode shapes. Mocks cannot
establish any of those guarantees.

`confine::confinement_is_demonstrable_on_this_machine` is not `#[ignore]`d on
purpose: it runs in well under a second, and a macOS that stops honouring these
rules is something to hear about from a test run rather than from a damaged
installation.

Still owed: a native walkthrough of the whole loop on a signed install, and
measured downtime on the reference Mac. The target is **under 10 seconds from
process exit to an interactive workspace** for a prepared release with
unchanged persistent formats — a target to validate, not a guarantee. The
estimate the user is shown comes from the probe's measured time to interactive,
and says "not measured yet" when there is nothing to base it on.
