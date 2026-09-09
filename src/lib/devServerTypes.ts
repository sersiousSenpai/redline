// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
/** Mirrors the Localhost stop/probe command responses in devmap.rs. */
export interface StopPlan {
  root: number;
  rootLabel: string;
  pids: number[];
  collateralPorts: number[];
}

export interface ProbeView {
  projectName: string;
  stack: string;
  runCommand: string;
  scripts: string[];
  exists: boolean;
  packageManager: string;
}

/** Script names are manifest data, not shell fragments. */
export function scriptCommand(packageManager: string, script: string): string {
  const manager = ["npm", "pnpm", "yarn", "bun"].includes(packageManager)
    ? packageManager : "npm";
  const name = /^[a-zA-Z0-9_:@./-]+$/.test(script)
    ? script : `'${script.replace(/'/g, `'\\''`)}'`;
  return `${manager} run ${name}`;
}
