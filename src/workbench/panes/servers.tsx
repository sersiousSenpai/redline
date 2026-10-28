// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The Localhost pane (W6): the dashboard of local dev servers, a pure
// function of one scan (App's `useDevServers`, which runs only while this
// pane is on screen). Off the boot path: about 10 kB opened on demand.

import { lazy, Suspense, type ComponentProps } from "react";

export const loadServersPane = () => import("../../components/ServersPane");
const ServersPaneBody = lazy(() => loadServersPane().then((m) => ({ default: m.ServersPane })));

export type ServersPaneProps = ComponentProps<typeof ServersPaneBody>;

export function ServersPane(props: ServersPaneProps) {
  return (
    <Suspense fallback={null}>
      <ServersPaneBody {...props} />
    </Suspense>
  );
}
