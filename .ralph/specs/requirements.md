# Technical Requirements Specification

## Tech Stack

- **Runtime**: Bun (latest stable)
- **Language**: TypeScript (strict mode)
- **CLI Framework**: Commander.js or similar
- **Testing**: Bun test + BATS for integration tests
- **YAML Parser**: js-yaml
- **Git Operations**: simple-git or direct shell commands
- **GitHub API**: Octokit or gh CLI wrapper

## Project Structure

```
allagents/
├── src/
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── workspace.ts      # workspace subcommands (init, sync, status, plugin)
│   │   │   └── plugin.ts         # plugin subcommands (marketplace, list, validate)
│   │   └── index.ts              # CLI entry point
│   ├── core/
│   │   ├── workspace.ts          # Workspace operations
│   │   ├── marketplace.ts        # Marketplace registry operations
│   │   ├── plugin.ts             # Plugin resolution and listing
│   │   ├── sync.ts               # Sync logic
│   │   └── transform.ts          # File transformations
│   ├── models/
│   │   ├── workspace-config.ts   # workspace.yaml types
│   │   ├── marketplace.ts        # Marketplace registry types
│   │   ├── plugin-config.ts      # plugin.json types
│   │   └── client-mapping.ts     # Client path mappings
│   ├── validators/
│   │   └── skill.ts              # Skill YAML validation
│   └── utils/
│       ├── file.ts               # File operations
│       ├── git.ts                # Git operations
│       ├── github.ts             # GitHub fetching
│       └── plugin-spec.ts        # Parse plugin@marketplace specs
│   └── templates/
│       └── default/
│           ├── AGENTS.md
│           └── workspace.yaml
├── examples/
│   └── workspaces/
│       └── multi-repo/
│           └── workspace.yaml
├── tests/
│   ├── unit/
│   └── integration/              # BATS tests
├── package.json
├── tsconfig.json
└── bun.lockb
```

## Core Data Structures

### WorkspaceConfig (workspace.yaml)

```typescript
interface WorkspaceConfig {
  repositories: Repository[];
  plugins: PluginSpec[];      // plugin@marketplace format
  clients: ClientType[];
}

interface Repository {
  path: string;           // Relative or absolute path
  owner: string;          // GitHub owner
  repo: string;           // GitHub repo name
  description: string;    // Description
}

// Plugin spec format: "plugin-name@marketplace-name"
// Examples:
//   - "code-review@claude-plugins-official"
//   - "my-plugin@someuser/their-repo" (fully qualified for unknown marketplaces)
type PluginSpec = string;

type ClientType =
  | 'claude'
  | 'copilot'
  | 'codex'
  | 'cursor'
  | 'opencode'
  | 'gemini'
  | 'factory'
  | 'ampcode';
```

### MarketplaceRegistry (~/.allagents/marketplaces.json)

```typescript
interface MarketplaceRegistry {
  [name: string]: MarketplaceEntry;
}

interface MarketplaceEntry {
  source: MarketplaceSource;
  installLocation: string;    // Absolute path to marketplace
  lastUpdated: string;        // ISO timestamp
}

type MarketplaceSource =
  | { type: 'github'; repo: string }      // e.g., "anthropics/claude-plugins-official"
  | { type: 'directory'; path: string };  // Local directory path

// Well-known marketplaces (auto-resolve by name)
const WELL_KNOWN_MARKETPLACES: Record<string, string> = {
  'claude-plugins-official': 'anthropics/claude-plugins-official',
};
```

### PluginManifest (plugin.json)

```typescript
interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
}
```

### SkillMetadata (SKILL.md frontmatter)

```typescript
interface SkillMetadata {
  name: string;              // Required: lowercase, alphanumeric + hyphens, max 64 chars
  description: string;       // Required: non-empty string
  'allowed-tools'?: string[]; // Optional: array of tool names
  model?: string;            // Optional: model identifier
}
```

### ClientMapping

```typescript
interface ClientMapping {
  commandsPath: string;      // e.g., '.claude/commands/'
  commandsExt: string;       // e.g., '.md' or '.prompt.md'
  skillsPath: string;        // e.g., '.claude/skills/'
  agentFile: string;         // e.g., 'CLAUDE.md' or 'AGENTS.md'
  agentFileFallback?: string; // e.g., 'AGENTS.md' for CLAUDE.md
  hooksPath?: string;        // Optional: e.g., '.claude/hooks/'
}

const CLIENT_MAPPINGS: Record<ClientType, ClientMapping> = {
  claude: {
    commandsPath: '.claude/commands/',
    commandsExt: '.md',
    skillsPath: '.claude/skills/',
    agentFile: 'CLAUDE.md',
    agentFileFallback: 'AGENTS.md',
    hooksPath: '.claude/hooks/',
  },
  copilot: {
    commandsPath: '.github/prompts/',
    commandsExt: '.prompt.md',
    skillsPath: '.github/skills/',
    agentFile: 'AGENTS.md',
  },
  // ... other clients
};
```

## Command Specifications

### `allagents workspace init <path>`

**Purpose**: Create new workspace from template

**Behavior**:
1. Validate path doesn't already exist
2. Create directory structure
3. Copy template files from `src/templates/default/`
4. Convert relative plugin paths to absolute paths in workspace.yaml
5. Initialize git repository
6. Create initial commit

**Exit codes**:
- 0: Success
- 1: Path already exists
- 2: Template not found
- 3: Git initialization failed

### `allagents workspace sync`

**Purpose**: Sync plugins to workspace

**Behavior**:
1. Read workspace.yaml from current directory
2. For each plugin spec (`plugin@marketplace`):
   - Parse plugin name and marketplace name
   - Look up marketplace in `~/.allagents/marketplaces.json`
   - If marketplace not found → error (user must add it first or use auto-registration via `workspace plugin add`)
   - Resolve plugin path: `<marketplace-path>/plugins/<plugin-name>/`
3. For each client in workspace.yaml:
   - Determine target paths from CLIENT_MAPPINGS
   - Copy commands with extension transform
   - Copy skills with validation
   - Copy hooks (if client supports)
   - Create/update agent file with workspace rules appended
4. Create git commit with sync metadata

**Exit codes**:
- 0: Success
- 1: workspace.yaml not found
- 2: Marketplace not found
- 3: Plugin not found in marketplace
- 4: Validation failed
- 5: File operation failed
- 6: Git commit failed

**Flags**:
- `--force`: Overwrite local changes
- `--dry-run`: Preview changes without applying

### `allagents workspace status`

**Purpose**: Show sync status of plugins

**Behavior**:
1. Read workspace.yaml
2. Check cache status for remote plugins
3. Check file timestamps for local plugins
4. Display table with plugin name, source, last synced, status

### `allagents workspace plugin add <plugin@marketplace>`

**Purpose**: Add plugin to workspace.yaml with auto-registration

**Behavior**:
1. Parse `plugin@marketplace` format
2. Check if marketplace is registered in `~/.allagents/marketplaces.json`
3. If not registered, attempt auto-registration:
   - Known name (e.g., `claude-plugins-official`) → fetch from well-known GitHub repo
   - Full spec (e.g., `plugin@owner/repo`) → fetch from GitHub `owner/repo`
   - Unknown short name → error with helpful message
4. Verify plugin exists in marketplace: `<marketplace-path>/plugins/<plugin-name>/`
5. Add to plugins list in workspace.yaml
6. Optionally run sync

**Exit codes**:
- 0: Success
- 1: Invalid plugin spec format
- 2: Marketplace not found and cannot auto-register
- 3: Plugin not found in marketplace
- 4: workspace.yaml not found

### `allagents workspace plugin remove <plugin>`

**Purpose**: Remove plugin from workspace.yaml

**Behavior**:
1. Remove plugin from plugins list in workspace.yaml
2. Optionally clean up synced files

### `allagents plugin marketplace list`

**Purpose**: List registered marketplaces

**Behavior**:
1. Read `~/.allagents/marketplaces.json`
2. Display table with marketplace name, source type, path, last updated

### `allagents plugin marketplace add <source>`

**Purpose**: Add marketplace from URL, path, or GitHub repo

**Behavior**:
1. Determine source type:
   - Local path → register as directory source
   - GitHub repo (owner/repo) → clone to `~/.allagents/marketplaces/<name>/`
2. Validate marketplace structure (must contain `plugins/` directory)
3. Add entry to `~/.allagents/marketplaces.json`

**Exit codes**:
- 0: Success
- 1: Invalid source
- 2: Clone/fetch failed
- 3: Invalid marketplace structure

### `allagents plugin marketplace remove <name>`

**Purpose**: Remove a registered marketplace

**Behavior**:
1. Remove entry from `~/.allagents/marketplaces.json`
2. Optionally delete cloned directory (with confirmation)

### `allagents plugin marketplace update [name]`

**Purpose**: Update marketplace(s) from remote

**Behavior**:
1. If name provided: update specific marketplace
2. If no name: update all GitHub-sourced marketplaces
3. Use `git pull` for GitHub sources
4. Update `lastUpdated` timestamp in registry

### `allagents plugin list [marketplace]`

**Purpose**: List available plugins from marketplaces

**Behavior**:
1. If marketplace provided: list plugins from that marketplace
2. If no marketplace: list plugins from all registered marketplaces
3. Enumerate `plugins/*/` directories in each marketplace
4. Display table with plugin name, marketplace, description (from plugin.json)

### `allagents plugin validate <path>`

**Purpose**: Validate plugin or marketplace structure

**Behavior**:
1. If path contains `plugins/`: validate as marketplace
2. Otherwise: validate as single plugin
3. Check required files (plugin.json, SKILL.md in skills)
4. Validate YAML frontmatter in skills
5. Report validation errors

## File Transformation Rules

### Command Files

**Source**: `plugin/commands/*.md`

**Transformations**:
- Claude: Copy as-is to `.claude/commands/*.md`
- Copilot: Rename to `.github/prompts/*.prompt.md`
- Codex: Copy to `.codex/prompts/*.md`
- Others: Copy to client-specific path with `.md` extension

### Skill Directories

**Source**: `plugin/skills/<skill-name>/`

**Transformations**:
1. Validate SKILL.md has valid YAML frontmatter
2. Validate required fields (name, description)
3. Copy entire skill directory to client-specific skills path
4. Preserve directory structure (references/, scripts/, assets/)

**Validation Rules**:
- Name: lowercase, alphanumeric + hyphens, max 64 chars
- Description: non-empty string
- allowed-tools: array of strings (if present)
- model: string (if present)

### Hooks

**Source**: `plugin/hooks/*.md`

**Transformations**:
- Only copy for Claude and Factory clients
- Copy to `.claude/hooks/` or `.factory/hooks/`

### Agent Files

**Source**: `plugin/CLAUDE.md`, `plugin/GEMINI.md`, `plugin/AGENTS.md`

**Transformations**:
1. Determine which agent files to create based on clients list
2. Use source precedence:
   - CLAUDE.md → CLAUDE.md (if exists), fallback to AGENTS.md
   - GEMINI.md → GEMINI.md (if exists), fallback to AGENTS.md
   - AGENTS.md → AGENTS.md
3. Append workspace rules section from template

**Workspace Rules Template**:
```markdown
<!-- WORKSPACE-RULES:START -->
# Workspace Rules

## Rule: Workspace Discovery
TRIGGER: Any task
ACTION: Read `workspace.yaml` to get repository paths and project domains

## Rule: Correct Repository Paths
TRIGGER: File operations (read, search, modify)
ACTION: Use repository paths from `workspace.yaml`, not assumptions
<!-- WORKSPACE-RULES:END -->
```

## Validation Requirements

### workspace.yaml Validation

- Must be valid YAML
- repositories: array of Repository objects
- plugins: array of strings
- clients: array of valid ClientType strings

### Skill Validation

- SKILL.md must exist
- Must have YAML frontmatter (--- delimited)
- name field: required, lowercase, alphanumeric + hyphens, max 64 chars
- description field: required, non-empty string
- allowed-tools: optional array of strings
- model: optional string

### Plugin Structure Validation

- commands/ directory (optional)
- skills/ directory (optional)
- hooks/ directory (optional)
- At least one of commands/, skills/, or hooks/ must exist
- plugin.json must exist and be valid JSON

## Error Handling

### User-Facing Errors

- Clear error messages with actionable guidance
- Exit codes that indicate error category
- Suggest fixes when possible

### Examples

```
Error: workspace.yaml not found in current directory
  Run 'allagents workspace init <path>' to create a new workspace

Error: Invalid skill name 'MySkill' in plugin 'my-plugin'
  Skill names must be lowercase with hyphens only (e.g., 'my-skill')

Error: Failed to fetch plugin from GitHub
  Check that you have 'gh' CLI installed and authenticated
  Run: gh auth login
```

## Git Operations

### Sync Commit Message Format

```
sync: Update workspace from plugins

Synced plugins:
- plugin-name-1 (local)
- plugin-name-2 (github.com/owner/repo)

Timestamp: 2026-01-22T10:30:00Z
```

### Initial Workspace Commit

```
init: Create workspace from template

Created workspace at: /path/to/workspace
Template: default
```

## Performance Considerations

- Marketplaces cached at `~/.allagents/marketplaces/<name>/`
- Registry stored at `~/.allagents/marketplaces.json`
- Only clone marketplace if not already registered
- Use `git pull` for updates (incremental)
- Use parallel operations where possible (file copying)
- Stream large files instead of loading into memory

## Testing Requirements

### Unit Tests (Bun test)

- workspace.yaml parsing and validation
- Plugin spec parsing (`plugin@marketplace` format)
- Marketplace registry operations
- Skill YAML frontmatter validation
- File transformation logic
- Client mapping lookups
- Path resolution

### Integration Tests (BATS)

- Full workspace init flow
- Full workspace sync flow with `plugin@marketplace` specs
- Marketplace add/list/remove/update commands
- Auto-registration of unknown marketplaces
- Plugin list from marketplaces
- File transformations end-to-end
- Git commit creation
- Error handling scenarios

### Test Coverage Target

- Minimum 85% code coverage
- 100% test pass rate required
- Critical paths require integration tests

## Dependencies

```json
{
  "dependencies": {
    "commander": "^11.x",
    "js-yaml": "^4.x",
    "simple-git": "^3.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/js-yaml": "^4.x",
    "bats": "^1.x",
    "typescript": "^5.x"
  }
}
```

## Success Metrics

1. `plugin marketplace add/list/remove/update` manage marketplace registry
2. `plugin list` shows available plugins from registered marketplaces
3. `workspace plugin add` supports auto-registration of unknown marketplaces
4. `workspace plugin add/remove` manage workspace.yaml plugins
5. Can create workspace from template
6. Can sync plugins using `plugin@marketplace` format
7. All 8 clients receive correctly transformed files
8. Skills are validated before copying
9. Agent files created with workspace rules appended
10. Git commits created after each sync
11. 85%+ test coverage
12. All integration tests passing
