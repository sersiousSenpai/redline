// SPDX-License-Identifier: Apache-2.0
import type { DiffFile } from "../types";
import { displayPath } from "./flattenDiff";
export interface ChangeRisk {
  kind: string;
  file: string;
  message: string;
}
/** Deterministic signals, never an AI safety verdict. */
export function changeRisks(files: DiffFile[]): ChangeRisk[] {
  const risks: ChangeRisk[] = [];
  for (const file of files) {
    const path = displayPath(file),
      lower = path.toLowerCase();
    const add = (kind: string, message: string) =>
      risks.push({ kind, file: path, message });
    if (file.status === "deleted")
      add(
        "deleted",
        "This file will be removed. Check that nobody still needs it.",
      );
    if (
      /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.(toml|lock)|go\.(mod|sum)|requirements[^/]*\.txt|poetry\.lock|gemfile(\.lock)?)$/.test(
        lower,
      )
    )
      add(
        "dependency",
        "This changes software the project depends on. Check that the project still builds and runs.",
      );
    const sensitivePath =
      /(^|\/)(\.env($|\.)|credentials?([./_-]|$)|id_(rsa|ed25519)|[^/]+\.(pem|p12|key)$)/.test(
        lower,
      );
    const sensitiveContent = file.hunks.some((h) =>
      h.lines.some(
        (l) =>
          l.kind === "add" &&
          /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{30,})\b|(?:api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{8,}["']/i.test(
            l.text,
          ),
      ),
    );
    if (sensitivePath || sensitiveContent)
      add(
        "secret",
        "This may contain private settings or credentials. Check carefully before sharing with your team.",
      );
    if (/(^|\/)(migrations?|schema)(\/|\.)/.test(lower))
      add(
        "migration",
        "This can change stored data. Check the migration and recovery steps before using it.",
      );
    if (
      /(^|\/)(\.github\/workflows|\.circleci|\.gitlab-ci|jenkinsfile|azure-pipelines)/.test(
        lower,
      )
    )
      add(
        "automation",
        "This changes how builds or deployments run. Check the automation before sharing.",
      );
    const lines = file.hunks.reduce(
      (n, h) => n + h.lines.filter((l) => l.kind !== "context").length,
      0,
    );
    if (lines > 1000)
      add(
        "large",
        "This is a large change. Give it extra review before saving and sharing.",
      );
  }
  if (files.length > 50)
    risks.push({
      kind: "large",
      file: "",
      message:
        "Many files changed at once. Review each group before saving and sharing.",
    });
  return risks;
}
