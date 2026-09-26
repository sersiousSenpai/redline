# Hook-conflict modal repair — 2026-09-13

The initial hook warning was mounted in the header's normal layout, before
`Header`, and its saved/restart notice remained there after removal. This
pushed content into the macOS window-control area. The same component was
also duplicated in Settings and setup.

The warning and removal result now share one centered Redline modal. It uses
the existing overlay, elevated-card styling and shared buttons, with bounded
scrolling and a footer that contains dismissal. A body portal keeps it outside
the animated header layout. Native browser views are hidden while the modal
is open, including while its lazy chunk loads.

Settings → Integration hooks → Review opens that same modal and closes the
Settings menu. Setup offers the same action and yields to the hook modal
while it is open. Automatic notifications wait for existing overlays.
Dismissed findings stay dismissed across focus and watcher refreshes until
the inspected configuration changes; Settings can reopen them at any time.
Removal errors and the saved/restart confirmation remain inside the modal.
Escape, backdrop dismissal, focus containment and focus restoration are
handled; dismissal is disabled while a removal is pending.

## Verification

- `npx tsc --noEmit` passed.
- All **2,008 frontend tests across 176 files** passed. The hook suite's 11
  cases include portal placement outside the header, one persistent dialog
  through removal/success, dismissal and manual reopening, refresh behavior,
  keyboard focus, pending-removal protection and native-overlay registration.
- `APPLE_SIGNING_IDENTITY=- npx tauri build --bundles app --ci` passed,
  including TypeScript and the production frontend build.
- `codesign --verify --deep --strict` passed on the resulting local app.
- `node scripts/check-size.mjs --strict` passed with the existing ceilings.
  The release executable is 37,467,840 bytes, boot JavaScript 588,842 bytes,
  and frontend dist 8,342,324 bytes. The signed app contains 37,607,943 file
  bytes. No further budget increase was needed.
- `git diff --check` passed.

The new embedded release executable SHA-256 is
`7656ae529393967958a830a0abd43568a2ba10f0a6c4203e9ee718f392e4c62c`.
Build/test/size logs are preserved at `/tmp/redline-hook-modal-app-build.log`,
`/tmp/redline-hook-modal-vitest.log` and `/tmp/redline-hook-modal-size.log`.
The [rebuilt app](../src-tauri/target/release/bundle/macos/Redline.app) was
not installed or launched.

Computer Use again failed to start, so the native window walkthrough remains
unverified. The user's screenshot establishes the original visual defect;
the regression tests establish the new DOM placement and interaction behavior.
