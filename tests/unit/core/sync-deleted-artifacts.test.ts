import { describe, it, expect } from 'bun:test';
import { computeDeletedArtifacts } from '../../../src/core/sync.js';
import { CLIENT_MAPPINGS } from '../../../src/models/client-mapping.js';
import type { SyncState } from '../../../src/models/sync-state.js';

function makeState(files: Partial<SyncState['files']>): SyncState {
  return {
    version: 1,
    lastSync: new Date().toISOString(),
    files: files as SyncState['files'],
  };
}

describe('computeDeletedArtifacts', () => {
  it('returns empty array when there is no previous state', () => {
    const result = computeDeletedArtifacts(null, {}, ['claude'], CLIENT_MAPPINGS);
    expect(result).toEqual([]);
  });

  it('returns empty array when no artifacts were deleted', () => {
    const previousState = makeState({
      claude: ['.claude/skills/my-skill/'],
    });
    const newStatePaths = { claude: ['.claude/skills/my-skill/'] };
    const result = computeDeletedArtifacts(previousState, newStatePaths, ['claude'], CLIENT_MAPPINGS);
    expect(result).toEqual([]);
  });

  it('detects a deleted skill', () => {
    const previousState = makeState({
      claude: ['.claude/skills/old-skill/', '.claude/skills/old-skill/skill.md'],
    });
    const newStatePaths = { claude: [] };
    const result = computeDeletedArtifacts(previousState, newStatePaths, ['claude'], CLIENT_MAPPINGS);
    expect(result).toEqual([{ client: 'claude', type: 'skill', name: 'old-skill' }]);
  });

  it('deduplicates: only one deleted artifact per skill (directory + files inside)', () => {
    const previousState = makeState({
      claude: [
        '.claude/skills/my-skill/',
        '.claude/skills/my-skill/README.md',
        '.claude/skills/my-skill/script.js',
      ],
    });
    const newStatePaths = { claude: [] };
    const result = computeDeletedArtifacts(previousState, newStatePaths, ['claude'], CLIENT_MAPPINGS);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ client: 'claude', type: 'skill', name: 'my-skill' });
  });

  it('detects a deleted command', () => {
    const previousState = makeState({
      claude: ['.claude/commands/old-cmd.md'],
    });
    const newStatePaths = { claude: [] };
    const result = computeDeletedArtifacts(previousState, newStatePaths, ['claude'], CLIENT_MAPPINGS);
    expect(result).toEqual([{ client: 'claude', type: 'command', name: 'old-cmd' }]);
  });

  it('detects a deleted hook', () => {
    const previousState = makeState({
      claude: ['.claude/hooks/my-hook/hook.json'],
    });
    const newStatePaths = { claude: [] };
    const result = computeDeletedArtifacts(previousState, newStatePaths, ['claude'], CLIENT_MAPPINGS);
    expect(result).toEqual([{ client: 'claude', type: 'hook', name: 'my-hook' }]);
  });

  it('detects a deleted agent', () => {
    const previousState = makeState({
      copilot: ['.github/agents/reviewer.md'],
    });
    const newStatePaths = { copilot: [] };
    const result = computeDeletedArtifacts(previousState, newStatePaths, ['copilot'], CLIENT_MAPPINGS);
    expect(result).toEqual([{ client: 'copilot', type: 'agent', name: 'reviewer' }]);
  });

  it('only reports artifacts not re-provided by new sync', () => {
    const previousState = makeState({
      claude: [
        '.claude/skills/kept-skill/',
        '.claude/skills/removed-skill/',
        '.claude/commands/old-cmd.md',
      ],
    });
    const newStatePaths = {
      claude: ['.claude/skills/kept-skill/'],
    };
    const result = computeDeletedArtifacts(previousState, newStatePaths, ['claude'], CLIENT_MAPPINGS);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ client: 'claude', type: 'skill', name: 'removed-skill' });
    expect(result).toContainEqual({ client: 'claude', type: 'command', name: 'old-cmd' });
  });

  it('handles multiple clients independently', () => {
    const previousState = makeState({
      claude: ['.claude/skills/old-claude-skill/'],
      copilot: ['.github/skills/old-copilot-skill/'],
    });
    const newStatePaths = {
      claude: [],
      copilot: ['.github/skills/old-copilot-skill/'],
    };
    const result = computeDeletedArtifacts(
      previousState, newStatePaths, ['claude', 'copilot'], CLIENT_MAPPINGS,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ client: 'claude', type: 'skill', name: 'old-claude-skill' });
  });

  it('ignores agentFile paths (CLAUDE.md, AGENTS.md) as they are generated files', () => {
    const previousState = makeState({
      claude: ['CLAUDE.md'],
    });
    const newStatePaths = { claude: [] };
    const result = computeDeletedArtifacts(previousState, newStatePaths, ['claude'], CLIENT_MAPPINGS);
    expect(result).toEqual([]);
  });

  it('excludes skills that are available in installed plugins but just disabled', () => {
    const previousState = makeState({
      claude: [
        '.claude/skills/enabled-skill/',
        '.claude/skills/disabled-skill/',
        '.claude/commands/old-cmd.md',
      ],
    });
    const newStatePaths = {
      claude: ['.claude/skills/enabled-skill/'],
    };
    // 'disabled-skill' still exists in the plugin, just not synced
    const availableSkillNames = new Set(['enabled-skill', 'disabled-skill']);
    const result = computeDeletedArtifacts(
      previousState, newStatePaths, ['claude'], CLIENT_MAPPINGS, availableSkillNames,
    );
    // disabled-skill should NOT appear as deleted, but old-cmd should
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ client: 'claude', type: 'command', name: 'old-cmd' });
  });

  it('reports skills as deleted when they are not in availableSkillNames (plugin uninstalled)', () => {
    const previousState = makeState({
      claude: ['.claude/skills/removed-skill/'],
    });
    const newStatePaths = { claude: [] };
    // Empty set = no plugins provide this skill anymore
    const availableSkillNames = new Set<string>();
    const result = computeDeletedArtifacts(
      previousState, newStatePaths, ['claude'], CLIENT_MAPPINGS, availableSkillNames,
    );
    expect(result).toEqual([{ client: 'claude', type: 'skill', name: 'removed-skill' }]);
  });
});
