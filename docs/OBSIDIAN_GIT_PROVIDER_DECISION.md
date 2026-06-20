# Obsidian Git provider decision for 2.0

Line Last Modified 2.0 does not instantiate an `ObsidianGitProvider` because the installed Obsidian Git integration does not expose a stable, documented public line-blame API that this plugin can depend on.

The plugin therefore keeps the existing supported paths:

- native desktop Git through the public executable boundary;
- synchronized blame caches for mobile;
- installed/enabled detection and user-facing Init/Clone guidance;
- local and synchronized edit events when Git is unavailable.

It does not import Obsidian Git modules, inspect its internal store, call undocumented methods, or bundle `isomorphic-git`. A future provider may be added only after a versioned public API exposes capability detection and line blame.
