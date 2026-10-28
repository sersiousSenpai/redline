# Build Redline inside Redline (removed)

Build Redline left the product on 2026-10-28 (D16), with the orchestration-run
feature it was built on. It captured a candidate copy of Redline's own source,
had agents work in it as a native run graph, built and verified a replacement
application, and restarted into it through the activation helper.

What went: the Build Redline panel and its readiness bar, `self_develop.rs`
(capture, prepare, patch view, restart preflight), the OS confinement it ran
builds under (`confine.rs`), the release manifest, and the app side of the
in-place activation (quiesce, write gating, boot-stage handshake, rollback
reconciliation).

What stays: `redline-activate install`, the atomic bundle exchange that
`npm run redline` (`scripts/redline.sh`) installs through, and the
`redline-activation` crate it is built on. The git history before D16 holds
the full design if it comes back.
