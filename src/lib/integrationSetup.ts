// SPDX-License-Identifier: Apache-2.0
import type { Backend } from "./backendChoice";
import type { PreflightStatus } from "./readiness";

/** The same component requirements drive proactive setup and repair verification. */
export function integrationNeedsRepair(backend: Backend, health: PreflightStatus | null): boolean {
  if (!health) return false;
  if (backend === "codex") {
    if (!health.codex) return false;
    if (!health.codex.usable || health.codex.authState === "signed-out") return true;
    return health.codexHook?.installed === false || !!health.codexHook?.trust && health.codexHook.trust !== "trusted" ||
      !!health.codexSkill && (!health.codexSkill.installed || health.codexSkill.outdated) ||
      !!health.codex.profile && (!health.codex.profile.installed || health.codex.profile.outdated);
  }
  if (backend === "claude-code") return !health.hook.installed || !health.skill.installed || health.skill.outdated;
  const provider = health.providers?.[backend];
  return !!provider?.usable && (!provider.hook.installed || !provider.skill.installed || provider.skill.outdated);
}

export function integrationVerified(backend: Backend, health: PreflightStatus): boolean {
  if (backend === "codex") return !!health.codex?.usable && health.codex.authState !== "signed-out" && !!health.codex.profile?.installed &&
    !health.codex.profile.outdated && !!health.codexHook?.installed && (!health.codexHook.trust || health.codexHook.trust === "trusted") &&
    !!health.codexSkill?.installed && !health.codexSkill.outdated;
  if (backend === "claude-code") return health.hook.installed && health.skill.installed && !health.skill.outdated;
  const provider = health.providers?.[backend];
  return !!provider?.usable && provider.hook.installed && provider.skill.installed && !provider.skill.outdated;
}

export interface InstallStep { command: string; label: string; args?: Record<string, unknown> }
export function integrationInstallSteps(backend: Backend): InstallStep[] {
  if (backend === "codex") return [
    { command: "install_codex_hook", label: "Installing plan and prompt hooks" },
    { command: "install_codex_profile", label: "Updating planning instructions and launcher" },
    { command: "install_codex_skill", label: "Updating review and collaboration skills" },
  ];
  if (backend === "claude-code") return [
    { command: "install_hook", label: "Installing plan and prompt hooks" },
    { command: "install_skill", label: "Updating review and collaboration skills" },
  ];
  return [{ command: "install_provider_integration", label: "Installing review integration", args: { backend } }];
}

/** Independent components can succeed after another fails; verification always runs. */
export async function repairIntegration<T extends PreflightStatus>(
  backend: Backend,
  install: (step: InstallStep) => Promise<unknown>,
  verify: () => Promise<T>,
  progress: (label: string) => void,
): Promise<{ health: T | null; errors: string[]; verified: boolean }> {
  const errors: string[] = [];
  for (const step of integrationInstallSteps(backend)) {
    progress(step.label);
    try { await install(step); } catch (error) { errors.push(`${step.label}: ${String(error)}`); }
  }
  progress("Verifying the integration");
  let health: T | null = null;
  try { health = await verify(); } catch (error) { errors.push(`Verification failed: ${String(error)}`); }
  const verified = health !== null && integrationVerified(backend, health);
  if (!verified && errors.length === 0) errors.push(backend === "codex" && health?.codex?.authState === "signed-out" ? "Sign in to Codex, review Redline's hooks in /hooks, then verify again." : backend === "codex" && health?.codexHook?.trust && health.codexHook.trust !== "trusted" ? health.codexHook.trustDetail ?? "Review Redline's hooks in Codex /hooks, then verify again." : "Some integration components still need attention. Retry or inspect the integration settings.");
  return { health, errors, verified: verified && errors.length === 0 };
}
