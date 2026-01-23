# Ralph Fix Plan

## Architecture Fix: Align with Claude Plugin Convention (HIGH PRIORITY)

Based on `claude plugin --help`, the industry standard architecture is:

### Claude's Architecture (Reference)
```
~/.claude/plugins/
├── known_marketplaces.json      # Registered marketplaces
├── installed_plugins.json       # Installed plugins with versions
├── marketplaces/                # Cloned marketplace repos
│   └── <marketplace-name>/
└── cache/                       # Installed plugin copies
    └── <marketplace>/<plugin>/<version>/
```

**Key Concepts:**
- **Marketplace**: A source repo containing multiple plugins (GitHub or local directory)
- **Plugin**: Identified as `plugin@marketplace` (e.g., `context7@claude-plugins-official`)
- **Scope**: `user` (global), `project` (per-project), or `local`

### Our Target Architecture
```
~/.allagents/
├── marketplaces.json            # Registered marketplaces
├── marketplaces/                # Cloned marketplace repos
│   └── <marketplace-name>/
└── installed/                   # Installed plugin copies (optional, for version tracking)
```

**For workspace.yaml:**
```yaml
plugins:
  - context7@claude-plugins-official       # plugin@marketplace format
  - code-review@claude-plugins-official
  - my-plugin@my-local-marketplace
```

---

## Phase A: Refactor CLI Commands to Match Claude Convention
- [x] Create `plugin marketplace` subcommand group
  - [x] `allagents plugin marketplace list` - list registered marketplaces
  - [x] `allagents plugin marketplace add <source>` - add from URL/path/GitHub
  - [x] `allagents plugin marketplace remove <name>` - remove a marketplace
  - [x] `allagents plugin marketplace update [name]` - update marketplace(s)
- [x] Refactor plugin commands
  - [x] `allagents plugin list [marketplace]` - list available plugins
  - [ ] `allagents plugin validate <path>` - validate plugin/marketplace (stub created)
- [x] Refactor workspace plugin commands (was `workspace add/remove`)
  - [x] `allagents workspace plugin add <plugin@marketplace>` - add plugin to workspace.yaml
  - [x] `allagents workspace plugin remove <plugin>` - remove plugin from workspace.yaml
- [x] Remove deprecated commands
  - [x] Remove `plugin fetch` (replaced by `plugin marketplace add`)
  - [x] Remove old `plugin update` (now `plugin marketplace update`)
  - [x] Remove `workspace add` (now `workspace plugin add`)
  - [x] Remove `workspace remove` (now `workspace plugin remove`)

## Phase B: Update Data Model
- [x] Create `~/.allagents/marketplaces.json` for registry
  ```json
  {
    "claude-plugins-official": {
      "source": { "type": "github", "repo": "anthropics/claude-plugins-official" },
      "installLocation": "~/.allagents/marketplaces/claude-plugins-official",
      "lastUpdated": "2026-01-23T..."
    }
  }
  ```
- [ ] Update `src/utils/plugin-path.ts`
  - [ ] Parse `plugin@marketplace` format
  - [ ] Resolve marketplace by name from registry
  - [ ] Find plugin within marketplace directory
- [x] Create marketplace registry functions in `src/core/marketplace.ts`
  - [x] `addMarketplace(source)` - add to registry and clone/link
  - [x] `removeMarketplace(name)` - remove from registry
  - [x] `listMarketplaces()` - list from registry
  - [x] `updateMarketplace(name?)` - git pull or re-sync
  - [x] `getMarketplacePath(name)` - get local path

## Phase C: Update Plugin Resolution
- [x] Create `src/core/marketplace.ts` functions (in marketplace.ts, not plugin.ts)
  - [x] `listMarketplacePlugins(marketplace)` - enumerate plugins from marketplace
  - [x] `resolvePluginSpec(spec)` - resolve `plugin@marketplace` to local path
  - [ ] `validatePlugin(path)` - validate plugin structure
- [x] Update workspace.yaml format
  - [x] Support `plugin@marketplace` syntax
  - [x] Support shorthand (assumes default marketplace if unambiguous) - N/A, use full spec

## Phase D: Update Workspace Sync & Auto-Registration
- [x] Modify `src/core/sync.ts`
  - [x] Parse plugin specs as `plugin@marketplace`
  - [x] Ensure marketplace is registered/cloned
  - [x] Resolve plugin path within marketplace
  - [x] Copy plugin content to workspace
- [x] Implement auto-registration in workspace sync
  - [x] Accept `plugin@marketplace` format
  - [x] If marketplace unknown:
    - [x] Known names (e.g., `claude-plugins-official`) → auto-register from well-known GitHub
    - [x] Full spec (`plugin@owner/repo`) → auto-register GitHub marketplace
    - [x] Otherwise → error with helpful message
  - [x] Add marketplace to registry, then resolve plugin
- [x] Create well-known marketplaces config
  - [x] `claude-plugins-official` → `anthropics/claude-plugins-official`
  - [x] Extensible for future additions (WELL_KNOWN_MARKETPLACES constant)

## Phase E: Update Tests
- [ ] Update unit tests for new plugin path format
- [ ] Add tests for marketplace registry functions
- [ ] Add tests for `plugin@marketplace` resolution

## Phase F: Update Documentation
- [x] Update README.md with new CLI structure
- [x] Update example workspace.yaml files with new format
- [x] Update `.ralph/PROMPT.md` with new architecture
- [x] Update `.ralph/specs/requirements.md` with new architecture
- [x] Add attribution to dotagents

---

## Notes
- Follow `claude plugin marketplace list` subcommand convention exactly
- Use `plugin@marketplace` naming convention for plugins
- Marketplaces are registered sources, not just cached repos
- Local directory marketplaces don't need cloning, just registry entry
- GitHub marketplaces get cloned to `~/.allagents/marketplaces/<name>/`

### Auto-Registration Behavior
When adding a plugin with unknown marketplace:
```
# Known marketplace name → auto-registers from well-known GitHub repo
workspace plugin add code-review@claude-plugins-official
→ Auto-registers anthropics/claude-plugins-official

# Fully qualified name → auto-registers the GitHub repo
workspace plugin add my-plugin@someuser/their-repo
→ Auto-registers someuser/their-repo as "their-repo"

# Unknown short name → error
workspace plugin add my-plugin@unknown-marketplace
→ Error: Marketplace 'unknown-marketplace' not found.
   Use fully qualified name: my-plugin@owner/repo
   Or register first: allagents plugin marketplace add <source>
```
