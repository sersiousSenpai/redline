// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
// Startup reconciliation between the DB-stored appearance prefs
// (`app_settings`, the durable copy that travels with a fork or a second
// machine) and the local localStorage values (the pre-paint cache). Pure —
// App executes the returned actions. The rules:
//   - a DB value that resolves wins (and is applied + cached locally);
//   - otherwise a real local pick migrates INTO the DB (one-time, idempotent:
//     once the DB row exists it simply wins on the next launch);
//   - a name that no longer resolves anywhere snaps to the fallback.

export interface PrefDecision {
  /** Set state + apply + cache this value locally (undefined = leave as-is). */
  apply?: string;
  /** Persist this value to the DB (undefined = no write). */
  writeDb?: string;
}

/** Theme reconciliation. `appliedAtBoot` is false when the stored name was
 *  not a built-in — the pre-paint bootstrap skipped it (user themes are
 *  unregistered that early), so it must be applied now even if unchanged. */
export function reconcileTheme(opts: {
  db: string | null | undefined;
  local: string;
  resolves: (name: string) => boolean;
  appliedAtBoot: boolean;
  fallback: string;
}): PrefDecision {
  const desired =
    opts.db && opts.resolves(opts.db)
      ? opts.db
      : opts.resolves(opts.local)
        ? opts.local
        : opts.fallback;
  return {
    apply:
      desired !== opts.local || !opts.appliedAtBoot ? desired : undefined,
    writeDb: desired !== opts.db ? desired : undefined,
  };
}

/** Font / lint reconciliation. Gated on `hasExplicitLocal` so only a real
 *  pick migrates into the DB — an untouched default stays untouched, keeping
 *  the suggested-companion rules (SUGGESTED_FONT_FOR_THEME) meaningful. */
export function reconcilePick(opts: {
  db: string | null | undefined;
  local: string;
  hasExplicitLocal: boolean;
  isValid: (name: string) => boolean;
}): PrefDecision {
  if (opts.db && opts.isValid(opts.db)) {
    return {
      apply:
        opts.db !== opts.local || !opts.hasExplicitLocal ? opts.db : undefined,
    };
  }
  return opts.hasExplicitLocal ? { writeDb: opts.local } : {};
}
