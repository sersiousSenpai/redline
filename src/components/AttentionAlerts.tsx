// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
import { memo } from "react";

import { useAttentionAlerts, type AttentionAlertSources } from "../hooks/useAttentionAlerts";

/** The OS notifications and the Dock badge (`useAttentionAlerts`), as a
 *  component App mounts lazily: nothing here is on the boot path. Renders
 *  nothing. */
export const AttentionAlerts = memo(function AttentionAlerts(props: AttentionAlertSources) {
  useAttentionAlerts(props);
  return null;
});
