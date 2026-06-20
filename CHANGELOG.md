# Changelog

All notable public changes to Line Last Modified are documented here.

## 1.0.0 - 2026-06-20

- Initial public release.
- Added current-line timestamps backed by local edit history, synchronized metadata, filesystem time, and optional Git blame.
- Added a configurable meaningful-edit threshold. The default records a line only after five net changed characters; reverting to the original text counts as zero, while line breaks and structural moves are always recorded.
- Added Auto, Journal, Knowledge, and Off document modes with first-use presets and progressive settings disclosure.
- Added journal review heatmaps, delayed-entry classification, old-journal protection, migration suggestions, and explicit Markdown export.
- Added knowledge freshness, review queues, backlinks-based impact analysis, and local-only weekly or monthly insights.
- Added cross-device JSONL metadata, device identity, conflict history, privacy controls, optional signatures, and optional HMAC content hashes.
- Added responsive English and Simplified Chinese settings, timestamp language selection, searchable local-font selection, and inline, gutter, or status-bar placement.
- Added bilingual documentation, automated verification, and a minimal three-file installation package.
