import { describe, expect, it, mock } from 'bun:test';
import { installSkillFromSource } from '../../../src/cli/commands/plugin-skills.js';

describe('installSkillFromSource', () => {
  it('passes the resolved GitHub skill subpath to direct install without resolving it twice', async () => {
    const source = 'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/llm-wiki';
    const installSkillDirectMock = mock(async (_opts: {
      skill: string;
      from: string;
      isUser: boolean;
      workspacePath: string;
      sourcePath: string;
    }) => ({
      success: true as const,
      pluginName: 'llm-wiki',
      syncResult: { copied: 1, failed: 0 },
    }));

    const result = await installSkillFromSource(
      {
        skill: 'llm-wiki',
        from: source,
        isUser: false,
        workspacePath: '/tmp/workspace',
      },
      {
        fetchPlugin: async () => ({
          success: true as const,
          action: 'fetched' as const,
          cachePath: '/tmp/fetched-hermes-agent',
        }),
        parseMarketplaceManifest: async () => ({
          success: false as const,
          error: 'not a marketplace',
        }),
        installSkillViaMarketplace: async () => ({
          success: false as const,
          error: 'unexpected marketplace path',
        }),
        installSkillDirect: installSkillDirectMock,
      },
    );

    expect(result.success).toBe(true);
    expect(installSkillDirectMock).toHaveBeenCalledTimes(1);
    expect(installSkillDirectMock).toHaveBeenCalledWith({
      skill: 'llm-wiki',
      from: source,
      isUser: false,
      workspacePath: '/tmp/workspace',
      sourcePath: '/tmp/fetched-hermes-agent/skills/research/llm-wiki',
    });
  });
});
