# Ralph Fix Plan

## Phase 1: Project Foundation (High Priority) ✅ COMPLETED
- [x] Initialize TypeScript/Bun project structure
  - [x] Create package.json with dependencies (commander, js-yaml, simple-git, zod)
  - [x] Set up tsconfig.json with strict mode
  - [x] Configure Bun test framework
  - [ ] Set up BATS for integration tests (deferred to Phase 2)
- [x] Define core type definitions
  - [x] WorkspaceConfig interface (workspace.yaml)
  - [x] PluginManifest interface (plugin.json)
  - [x] SkillMetadata interface (SKILL.md frontmatter)
  - [x] ClientMapping type and CLIENT_MAPPINGS constant
- [x] Create workspace template in src/templates/default/
  - [x] AGENTS.md with workspace rules
  - [x] workspace.yaml example

## Phase 2: Core Commands (High Priority) ✅ COMPLETED
- [x] Implement `allagents workspace init <path>`
  - [x] Validate path doesn't exist
  - [x] Copy template files
  - [x] Convert relative plugin paths to absolute
  - [x] Initialize git repository
  - [x] Create initial commit
  - [x] Add unit tests (5 tests for parser)
  - [ ] Add BATS integration test (deferred to later)
- [x] Implement workspace.yaml parser
  - [x] YAML parsing with validation
  - [x] Zod schema validation
  - [x] Error handling with clear messages
  - [x] Add unit tests
- [x] Implement plugin path resolution
  - [x] Detect GitHub URLs vs local paths
  - [x] Resolve relative to absolute paths
  - [x] Parse GitHub URLs (owner/repo extraction)
  - [x] Generate cache paths for remote plugins
  - [x] Validate plugin sources
  - [x] Add unit tests (25 comprehensive tests)

## Phase 3: Plugin Fetching (High Priority) ✅ COMPLETED
- [x] Implement `allagents plugin fetch <url>`
  - [x] GitHub URL validation
  - [x] Cache directory setup (~/.allagents/plugins/marketplaces/)
  - [x] Integration with gh CLI via execa
  - [x] --force flag for updates
  - [x] Error handling for auth failures, 404, network errors
  - [x] Add unit tests (8 comprehensive tests)
  - [ ] Add integration tests (deferred)
- [x] Implement `allagents plugin list`
  - [x] Read cache directory
  - [x] Display name, path, last modified
  - [x] Helpful message when empty
- [x] Implement `allagents plugin update [name]`
  - [x] Update single plugin by name
  - [x] Update all cached plugins if no name
  - [x] Uses git pull in cache directory

## Phase 4: Sync Implementation (High Priority) ✅ COMPLETED
- [x] Implement skill validation
  - [x] YAML frontmatter parser (gray-matter)
  - [x] Validate required fields (name, description)
  - [x] Validate name format (lowercase, alphanumeric + hyphens, max 64)
  - [x] Add comprehensive unit tests (9 tests)
- [x] Implement file transformation logic
  - [x] Command file extensions (.md → .prompt.md for Copilot)
  - [x] Path transformations based on CLIENT_MAPPINGS
  - [x] Skills/hooks/commands copy operations
- [x] Implement agent file handling
  - [x] Source precedence logic (CLAUDE.md → AGENTS.md)
  - [x] Workspace rules appending
  - [x] Multiple client file creation
- [x] Implement `allagents workspace sync`
  - [x] Read workspace.yaml
  - [x] Fetch/resolve all plugins (GitHub + local)
  - [x] Copy commands with transforms
  - [x] Copy skills with validation
  - [x] Copy hooks (Claude/Factory only)
  - [x] Create/update agent files
  - [x] Create git commit with metadata
  - [ ] Add comprehensive integration tests (deferred)

## Phase 5: Additional Commands (Medium Priority)
- [x] Implement `allagents workspace status`
  - [x] Check cache status for remote plugins
  - [x] Check path existence for local plugins
  - [x] Display formatted list with status icons
  - [ ] Add integration test (deferred)
- [x] Implement `allagents workspace add <plugin>`
  - [x] Validate plugin source
  - [x] Update workspace.yaml
  - [x] Helpful message to run sync
  - [ ] Add integration test (deferred)
- [x] Implement `allagents workspace remove <plugin>`
  - [x] Remove from workspace.yaml
  - [ ] Add integration test (deferred)

## Phase 6: Polish (Medium Priority)
- [ ] Add --force flag support to workspace sync
- [ ] Add --dry-run flag support to workspace sync
- [ ] Improve error messages with actionable guidance
- [ ] Add comprehensive documentation
  - [ ] README with examples
  - [ ] CLI help text
  - [ ] Error message catalog
- [ ] Performance optimization
  - [ ] Parallel file copying
  - [ ] Efficient git operations

## Phase 7: Advanced Features (Low Priority)
- [ ] Frontmatter transformation for tool-specific fields
- [ ] Plugin validation (plugin.json parsing)
- [ ] Workspace templates management
- [ ] Plugin marketplace browsing
- [ ] Watch mode for auto-sync

## Completed
- [x] Project initialization
- [x] Ralph configuration created
- [x] Technical requirements specification written
- [x] Phase 1: Project Foundation
  - [x] TypeScript/Bun project setup with all dependencies
  - [x] All core type definitions with Zod validation
  - [x] Workspace template created
  - [x] Basic CLI structure with Commander.js
  - [x] 12 unit tests passing (100% pass rate)
  - [x] Build and typecheck working
- [x] Phase 2: Core Commands
  - [x] workspace init command fully implemented
  - [x] workspace.yaml parser with full validation
  - [x] Template-based workspace creation
  - [x] Automatic plugin path conversion (relative → absolute)
  - [x] Git initialization with commit
  - [x] Plugin path resolution utilities
    - [x] GitHub URL detection and parsing
    - [x] Path normalization (relative → absolute)
    - [x] Plugin source validation
    - [x] Cache path generation
  - [x] 42 unit tests passing (100% pass rate)
  - [x] End-to-end CLI command working
- [x] Phase 3: plugin commands
  - [x] plugin fetch with execa/gh CLI integration
  - [x] plugin list with cache directory reading
  - [x] plugin update with git pull support
  - [x] All commands with user-friendly output
  - [x] 8 unit tests for plugin fetch
- [x] Phase 4: workspace sync command
  - [x] Skill validation with gray-matter YAML parser
  - [x] File transformation logic for all 8 clients
  - [x] Agent file handling with source precedence
  - [x] Workspace rules auto-appending
  - [x] Git commit after sync
  - [x] 9 unit tests for skill validation
  - [x] 54 total tests (all passing sequentially)

## Notes
- Focus on getting workspace init and sync working first
- Each command should have both unit tests and BATS integration tests
- Maintain 85%+ test coverage
- Test with dotagents plugin structure for compatibility
- Git operations should be tested but can use temporary test repos
