[简体中文](README.zh-CN.md) / [English](README.md)

<h1 align="center">Line Last Modified</h1>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-7c3aed?style=flat-square" alt="version 1.0.0">
  <img src="https://img.shields.io/badge/Obsidian-%E2%89%A51.5.0-7c3aed?style=flat-square" alt="Obsidian 1.5.0 or later">
  <img src="https://img.shields.io/badge/platform-desktop%20%7C%20mobile-2563eb?style=flat-square" alt="desktop and mobile">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-16a34a?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <strong>Show when the line under your cursor was last changed, combining local, synchronized, and Git history.</strong>
  <br>
  <em>No timestamps or hidden markers are inserted into Markdown.</em>
</p>

---

## 🎯 Core features

- **🕒 Current-line timestamp**
  - Renders one non-editable timestamp on the cursor line.
  - Supports relative, absolute, or combined time.
  - Can switch old relative values to absolute time after a chosen number of hours or days.
  - Supports inline, editor gutter, and status-bar placement.
  - Ignores accidental edits until the configurable net-change threshold is reached (5 characters by default).

- **📓 Journal mode**
  - Detects Daily Notes, date-based filenames, and configured journal folders.
  - Distinguishes same-day entries, next-day additions, delayed additions, later revisions, and prewrites.
  - Provides GitHub-style 7-day and 30-day journal heatmaps.
  - Offers optional old-journal notices, edit confirmation, and device-local IndexedDB snapshots.

- **🧠 Knowledge-base mode**
  - Shows fresh, review-due, and possibly stale states from reliable modification evidence.
  - Provides a maintenance board, backlink sorting, and line-level heatmaps.
  - Supports impact analysis and separate review events that do not overwrite edit time.

- **🔄 Cross-device history**
  - Each device writes only its own JSONL shards to reduce synchronization conflicts.
  - Works with Obsidian Sync, Syncthing, Remotely Save, FastNoteSync, and comparable full-Vault sync tools.
  - Desktop devices can publish Git blame caches that mobile devices read without native Git.
  - A malformed JSONL line, interleaved sync, or Git failure does not interrupt editing.

- **🌳 Git history (optional)**
  - Uses `git blame --line-porcelain` on desktop.
  - Detects Vault, parent, configured, and missing repositories.
  - Repository initialization requires explicit confirmation and never runs add, commit, author, or remote setup.
  - Obsidian Git integration is limited to safe detection and guidance; private APIs are not imported.

- **🔐 Privacy and device verification (optional)**
  - Does not save note previews, diffs, summaries, sentiment, or person inference by default.
  - Supports author/device hiding and timestamp-only metadata modes.
  - Offers P-256 event signatures, fingerprint trust, local revocation, and key rotation.
  - Offers HMAC-SHA-256 content hashes with a device-local key.

- **📊 Local reviews (optional)**
  - Creates command-driven weekly and monthly local reports.
  - Uses headings, tags, links, visible character counts, journal themes, and knowledge risks.
  - Disabled by default; no model, network request, persisted result, or note modification is involved.

## 🚀 Quick installation

### Option 1: Install the ZIP (recommended)

1. Download the latest `line-last-modified-*.zip` from [GitHub Releases](https://github.com/wusak1/line-last-modified/releases).
2. Extract it and confirm the folder contains only:

   ```text
   manifest.json
   main.js
   styles.css
   ```

3. Copy that folder to:

   ```text
   <your Vault>/.obsidian/plugins/line-last-modified/
   ```

4. Reload Obsidian and enable **Line Last Modified** under Community plugins.

### Option 2: Build from source

```bash
npm install
npm run typecheck
npm test
npm run build
```

Copy the generated `manifest.json`, `main.js`, and `styles.css` into the plugin folder.

## 📖 First use

The settings page is organized for first-time users:

1. **Start here**
   - Enable the timestamp.
   - Choose the time style, location, and language.

2. **How do you use the plugin?**
   - Auto detect is recommended.
   - Journal-first, knowledge-first, and normal-timestamps-only presets are also available.
   - Journal and knowledge folder fields are optional in most Vaults.

3. **Move the cursor and edit**
   - Moving to a line resolves its latest known time.
   - Editing it immediately refreshes the display to a local edit.

4. **Open advanced settings only when needed**
   - Appearance, journal rules, knowledge maintenance, Git, synchronization, privacy, and performance are collapsed by default.
   - Controls irrelevant to the current preset are hidden automatically.

## 🔄 Cross-device synchronization

The default metadata directory is:

```text
line-last-modified/
├─ events/<deviceId>/*.jsonl
├─ devices/<deviceId>.json
├─ blame-cache/<deviceId>/*.json
└─ cache/<deviceId>/index.json
```

Your sync tool must include `.json` and `.jsonl` files in this directory. Markdown-only synchronization cannot carry line history.

### FastNoteSync

When using FastNoteSync, include ordinary files and the complete `line-last-modified/` directory in its synchronization scope. This plugin does not depend on a FastNoteSync-specific API; it reloads history from Vault file changes after synchronization.

### Multi-device recommendations

- Let every device keep its own identity; do not manually copy device localStorage.
- Synchronize notes and `line-last-modified/`, but not `.git`.
- For shared Git history, clone the same remote separately on desktop devices.
- HMAC mode requires the same local key to be configured through a separate secure channel on each device.

## 🧭 Evidence precedence

```text
current in-memory edit
> current-device event log
> synchronized event from another device
> desktop Git blame or synchronized blame cache
> filesystem modification time
> explicit no-history or error state
```

Click the timestamp or run **Explain current-line history** to inspect candidates, matching evidence, confidence, conflicts, signature status, and Git fallback reasons.

## ⌨️ Common commands

- Toggle current-line timestamp
- Explain current-line history
- Refresh synchronized line history and Git cache
- Save pending line history now
- Open journal review
- Open knowledge review list
- Open knowledge impact analysis
- Open cross-day journal migrations
- Open local weekly / monthly insights
- Mark current knowledge note as reviewed
- Audit synchronized metadata privacy

## 🔐 Data and privacy boundaries

### No silent Markdown writes

The plugin does not insert timestamps, hidden IDs, mode state, or migration markers. Markdown changes occur only after an explicit journal-review export or snapshot restore action.

### Device-local only

- Git executable and repository absolute paths
- Local device settings and sequence
- Trust and revocation decisions
- P-256 private keys and journal snapshots
- HMAC content-hash key

### Synchronizable metadata

- Vault-relative file path, line number, and timestamp
- Short content and context hashes by default
- Event device ID, sequence, and optional display name
- Optional signatures, public keys, and desktop Git blame caches

Device signatures authenticate source and integrity; they do not encrypt metadata. Use an audited encryption layer from your storage or sync provider when confidentiality is required.

## ⚙️ Compatibility

- Obsidian: `1.5.0` or later
- Desktop: Windows, macOS, Linux
- Mobile: Android and iOS (no Node `child_process`, no native Git dependency)
- Sync: Obsidian Sync, Syncthing, Remotely Save, FastNoteSync, and comparable full-Vault file synchronization

## 🧪 Development verification

```bash
npm run typecheck
npm test
npm run build
npm run verify-release
```

The automated suite covers features, malformed data, concurrent synchronization, mobile behavior, privacy, and 100,000-event query performance.

## ⏱️ Changelog and design documents

- [Changelog](CHANGELOG.md)
- [Device trust threat model](docs/DEVICE_TRUST_THREAT_MODEL.md)
- [Obsidian Git provider decision](docs/OBSIDIAN_GIT_PROVIDER_DECISION.md)

## 💬 Issues and suggestions

Open a [GitHub issue](https://github.com/wusak1/line-last-modified/issues) with:

- Obsidian and plugin versions
- Desktop or mobile platform
- Synchronization method
- Reproduction steps and redacted error details

## 📄 License

[MIT License](LICENSE)

Author: [@wusak1](https://github.com/wusak1)
