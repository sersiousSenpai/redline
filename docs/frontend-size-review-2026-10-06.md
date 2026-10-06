# October 6 frontend size review

Independent comparison against baseline `9032117657897911a44f43367edc7e3dc43bd0fe`.
Both artifacts used the production Vite configuration and the same installed dependencies.
The feature audit ran `ANALYZE=1 npx vite build --outDir /tmp/redline-feature-audit-dist`;
analysis was written outside the shipped directory, to `build-analysis/`.

| Metric | Baseline | Feature audit | Change |
| --- | ---: | ---: | ---: |
| Boot JS: entry plus modulepreloads | 651,451 B | 658,220 B | +6,769 B (+1.04%) |
| Entire shipped dist | 9,080,628 B | 9,345,051 B | +264,423 B (+2.91%) |

The proposed 9,450,000 B dist ceiling leaves 104,949 B (1.12%) headroom on this
artifact. The unchanged 660,000 B boot ceiling leaves 1,780 B. These measurements
precede any subsequent integration edits; the final production build still needs
the strict checker. This review does not change either budget.

## Attribution

| Emitted asset or family | Change from baseline |
| --- | ---: |
| BrowserPane | +106,722 B |
| GuidedReview JS and CSS | +33,335 B |
| xterm addon-serialize | +25,602 B |
| AgentShellView | +17,687 B |
| ShellBlocksView JS and CSS | +10,944 B |
| ChatRoom JS and CSS | +9,865 B |
| TerminalTabs | +6,297 B |
| BrowserTabRail | +5,583 B |
| BrowserHomePage JS and CSS | +5,325 B |
| FloatingBrowserIsland JS and CSS | +4,825 B |
| DiffView extraction, net of ReviewPanel reduction | +2,651 B |

The BrowserPane increase is primarily the full public-suffix list needed for
correct domain grouping, including private domains and PSL exceptions. The
Rollup module graph attributes 146,873 **unminified rendered** bytes to its trie;
this is not an extra 146,873 shipped bytes on top of the BrowserPane row.
Only the domain-extraction path is retained; unused subdomain helpers are removed.
The package and its core helpers occur in one lazy BrowserPane chunk.

Guided review, hosted agent shell, plain-shell blocks, browser rail/home and the
floating composer each retain their lazy boundaries. Serialization is the new
25.6 KB dependency required by plain-terminal block snapshots. DiffView's new
28,938 B shared chunk accompanies a 26,287 B reduction in ReviewPanel; that is
code moved to a shared chunk, not a second copy.

## Duplication and avoidable assets

The raw Rollup graph reports zero source modules with nonzero rendered content
in more than one emitted chunk. It contains no fixtures, tests, development
scripts or bundle-analysis assets. The dist directory contains neither source
maps nor analysis reports. None of tldts, Guided review or the hosted-shell
components appears in the entry's static boot closure.

The 2.91% dist increase is proportional to the requested browser, shell, Guided
Git and other UI work. No substantial, safe reduction was found that preserves
the requested behavior. Loading the PSL only when grouping would shift browser
activation cost but would not reduce shipped dist, and replacing it with a
short suffix table would break the grouping contract. The remaining boot
headroom is small and should continue to be enforced without increasing its
ceiling.
