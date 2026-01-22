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
- [x] Create workspace template in templates/workspace-1/
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

## Phase 3: Plugin Fetching (High Priority)
- [ ] Implement `allagents plugin fetch <url>`
  - [ ] GitHub URL validation
  - [ ] Cache directory setup (~/.allagents/plugins/marketplaces/)
  - [ ] Integration with gh CLI
  - [ ] Error handling for auth failures
  - [ ] Add unit and integration tests
- [ ] Implement `allagents plugin list`
  - [ ] Read cache directory
  - [ ] Display formatted table
  - [ ] Add integration test
- [ ] Implement `allagents plugin update [name]`
  - [ ] Update single or all cached plugins
  - [ ] Use git pull in cache directory
  - [ ] Add integration test

## Phase 4: Sync Implementation (High Priority)
- [ ] Implement skill validation
  - [ ] YAML frontmatter parser
  - [ ] Validate required fields (name, description)
  - [ ] Validate name format (lowercase, alphanumeric + hyphens, max 64)
  - [ ] Add comprehensive unit tests
- [ ] Implement file transformation logic
  - [ ] Command file extensions (.md → .prompt.md for Copilot)
  - [ ] Path transformations based on CLIENT_MAPPINGS
  - [ ] Add unit tests for each client type
- [ ] Implement agent file handling
  - [ ] Source precedence logic (CLAUDE.md → AGENTS.md)
  - [ ] Workspace rules appending
  - [ ] Multiple client file creation
  - [ ] Add unit tests
- [ ] Implement `allagents workspace sync`
  - [ ] Read workspace.yaml
  - [ ] Fetch/resolve all plugins
  - [ ] Copy commands with transforms
  - [ ] Copy skills with validation
  - [ ] Copy hooks (Claude/Factory only)
  - [ ] Create/update agent files
  - [ ] Create git commit with metadata
  - [ ] Add comprehensive integration tests

## Phase 5: Additional Commands (Medium Priority)
- [ ] Implement `allagents workspace status`
  - [ ] Check cache status for remote plugins
  - [ ] Check timestamps for local plugins
  - [ ] Display formatted table
  - [ ] Add integration test
- [ ] Implement `allagents workspace add <plugin>`
  - [ ] Validate plugin source
  - [ ] Update workspace.yaml
  - [ ] Optional sync trigger
  - [ ] Add integration test
- [ ] Implement `allagents workspace remove <plugin>`
  - [ ] Remove from workspace.yaml
  - [ ] Optional cleanup
  - [ ] Add integration test

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

## Notes
- Focus on getting workspace init and sync working first
- Each command should have both unit tests and BATS integration tests
- Maintain 85%+ test coverage
- Test with dotagents plugin structure for compatibility
- Git operations should be tested but can use temporary test repos
