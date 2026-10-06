// SPDX-License-Identifier: Apache-2.0
import type { GitStatus } from "../types";
import type { GitAction } from "./gitWords";
export interface GitStory {
  headline: string;
  detail: string;
  primary: GitAction;
  secondary: GitAction[];
}
export function gitStory(
  status: GitStatus | null,
  summary: { files: number; overlaps?: number },
  hold: boolean,
): GitStory {
  const story = (
    headline: string,
    detail: string,
    primary: GitAction,
    secondary: GitAction[] = ["timeline", "workspace"],
  ): GitStory => ({
    headline,
    detail,
    primary,
    secondary: secondary.filter((a) => a !== primary),
  });
  if (!status)
    return story(
      "Getting your project ready",
      "You can read the changes while Redline checks your saved versions.",
      "check",
    );
  if (status.inProgress)
    return story(
      "A combine was left half-finished",
      "Finish it in your editor, or cancel it to return to where it started.",
      "recover",
    );
  if (hold)
    return story(
      "Claude is waiting for your review",
      "Read the changes below, then send your notes or let Claude keep going.",
      "notes",
      ["timeline"],
    );
  if (!status.branch && status.headShort)
    return story(
      "You're looking at an earlier version",
      "Create a workspace to keep new ideas safely.",
      "workspace",
    );
  const unsaved =
    summary.files > 0 || status.staged + status.unstaged + status.untracked > 0;
  if (unsaved)
    return story(
      `${summary.files || "Some"} ${summary.files === 1 ? "file has" : "files have"} unsaved changes`,
      summary.overlaps
        ? "Your team's updates touch these files. Save your work first."
        : "Review what changed below, then describe and save a version.",
      "save",
      ["check", "workspace", "timeline"],
    );
  if (status.behind > 0 && status.ahead > 0)
    return story(
      "You and your team both saved new versions",
      `${status.ahead} not shared yet · ${status.behind} new from your team. Bring them together before sharing.`,
      "updates",
    );
  if (status.behind > 0)
    return story(
      `${status.behind} new from your team`,
      "Bring in their saved versions to get up to date.",
      "updates",
    );
  if (status.remotes.length === 0)
    return story(
      "Your work is saved on this computer",
      "This project has no connected team copy yet.",
      "timeline",
      ["workspace", "connect"],
    );
  if (status.ahead > 0 || !status.upstream)
    return story(
      "Your work is ready to share",
      status.ahead
        ? `${status.ahead} saved versions not shared yet.`
        : "Share from a workspace so your team's main version stays safe.",
      "share",
      ["timeline", "workspace", "check"],
    );
  if (!status.ghAvailable || !status.ghAuthed)
    return story(
      "Your saved versions are up to date",
      "Connect GitHub to ask your team for a review here.",
      "connect",
      ["check", "timeline", "workspace"],
    );
  return story(
    "You're all caught up",
    "Everything is saved and shared with your team.",
    "workspace",
    ["check", "timeline"],
  );
}
