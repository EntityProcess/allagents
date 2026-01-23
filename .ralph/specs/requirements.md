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
│   │   │   ├── workspace.ts      # workspace subcommands
│   │   │   └── plugin.ts         # plugin subcommands
│   │   └── index.ts              # CLI entry point
│   ├── core/
│   │   ├── workspace.ts          # Workspace operations
│   │   ├── plugin.ts             # Plugin fetching/caching
│   │   ├── sync.ts               # Sync logic
│   │   └── transform.ts          # File transformations
│   ├── models/
│   │   ├── workspace-config.ts   # workspace.yaml types
│   │   ├── plugin-config.ts      # plugin.json types
│   │   └── client-mapping.ts     # Client path mappings
│   ├── validators/
│   │   └── skill.ts              # Skill YAML validation
│   └── utils/
│       ├── file.ts               # File operations
│       ├── git.ts                # Git operations
│       └── github.ts             # GitHub fetching
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
  plugins: PluginSource[];
  clients: ClientType[];
}

interface Repository {
  path: string;           // Relative or absolute path
  owner: string;          // GitHub owner
  repo: string;           // GitHub repo name
  description: string;    // Description
}

type PluginSource = string;  // Local path or GitHub URL

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
2. For each plugin:
   - If GitHub URL → fetch to `~/.allagents/plugins/marketplaces/<repo>/`
   - If local path → resolve to absolute path
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
- 2: Plugin fetch failed
- 3: Validation failed
- 4: File operation failed
- 5: Git commit failed

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

### `allagents workspace add <plugin>`

**Purpose**: Add plugin to workspace.yaml

**Behavior**:
1. Validate plugin source (local path exists or valid GitHub URL)
2. Add to plugins list in workspace.yaml
3. Optionally run sync

### `allagents workspace remove <plugin>`

**Purpose**: Remove plugin from workspace.yaml

**Behavior**:
1. Remove from plugins list in workspace.yaml
2. Optionally clean up synced files

### `allagents plugin fetch <url>`

**Purpose**: Fetch remote plugin to cache

**Behavior**:
1. Validate GitHub URL
2. Use `gh repo clone` to cache at `~/.allagents/plugins/marketplaces/<repo>/`
3. Display success/failure message

### `allagents plugin list`

**Purpose**: List cached plugins

**Behavior**:
1. Read `~/.allagents/plugins/marketplaces/` directory
2. Display table with repo name, path, last updated

### `allagents plugin update [name]`

**Purpose**: Update cached plugins from remote

**Behavior**:
1. If name provided: update specific plugin
2. If no name: update all cached plugins
3. Use `gh repo sync` or `git pull`

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

- Cache remote plugin fetches in `~/.allagents/plugins/marketplaces/`
- Only fetch if not cached or --force flag used
- Use parallel operations where possible (file copying)
- Stream large files instead of loading into memory

## Testing Requirements

### Unit Tests (Bun test)

- workspace.yaml parsing and validation
- Skill YAML frontmatter validation
- File transformation logic
- Client mapping lookups
- Path resolution

### Integration Tests (BATS)

- Full workspace init flow
- Full workspace sync flow
- Plugin fetch and cache
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

1. Can create workspace from template
2. Can sync plugins from local paths
3. Can fetch and cache remote plugins from GitHub
4. All 8 clients receive correctly transformed files
5. Skills are validated before copying
6. Agent files created with workspace rules appended
7. Git commits created after each sync
8. 85%+ test coverage
9. All integration tests passing
