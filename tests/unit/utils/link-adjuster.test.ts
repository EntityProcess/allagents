import { describe, it, expect } from 'bun:test';
import { adjustRelativePath, adjustLinksInContent } from '../../../src/utils/link-adjuster.js';

describe('adjustRelativePath', () => {
  const defaultOptions = {
    workspaceSkillsPath: '.agents/skills/',
  };

  it('adjusts skills path from .github root to workspace path', () => {
    // File at .github/copilot-instructions.md linking to ../skills/foo/SKILL.md
    // One ../ from .github/ goes to plugin root
    // After copy to workspace, skills are at .agents/skills/
    const result = adjustRelativePath('../skills/foo/SKILL.md', 'copilot-instructions.md', defaultOptions);
    expect(result).toBe('../.agents/skills/foo/SKILL.md');
  });

  it('adjusts skills path from nested .github folder', () => {
    // File at .github/instructions/cargowise.instructions.md
    // ../../ goes: first ../ to .github/, second ../ to plugin root
    // Then skills/cw-coding/SKILL.md from plugin root
    const result = adjustRelativePath(
      '../../skills/cw-coding/SKILL.md',
      'instructions/cargowise.instructions.md',
      defaultOptions,
    );
    expect(result).toBe('../../.agents/skills/cw-coding/SKILL.md');
  });

  it('resolves renamed skills using skillNameMap', () => {
    const options = {
      workspaceSkillsPath: '.agents/skills/',
      skillNameMap: new Map([['my-skill', 'plugin-name:my-skill']]),
    };
    // File at .github/instructions/file.md, link needs ../../ to reach plugin root
    const result = adjustRelativePath('../../skills/my-skill/SKILL.md', 'instructions/file.md', options);
    expect(result).toBe('../../.agents/skills/plugin-name:my-skill/SKILL.md');
  });

  it('leaves URLs unchanged', () => {
    const result = adjustRelativePath('https://example.com/docs', 'file.md', defaultOptions);
    expect(result).toBe('https://example.com/docs');
  });

  it('leaves absolute paths unchanged', () => {
    const result = adjustRelativePath('/absolute/path/to/file.md', 'file.md', defaultOptions);
    expect(result).toBe('/absolute/path/to/file.md');
  });

  it('leaves paths within .github unchanged', () => {
    // Link to another file in .github/prompts/ - doesn't exit .github
    const result = adjustRelativePath('../prompts/other.md', 'instructions/file.md', defaultOptions);
    expect(result).toBe('../prompts/other.md');
  });

  it('leaves paths that do not match mappings unchanged', () => {
    // Link to commands/ - no mapping for this
    const result = adjustRelativePath('../../commands/foo.md', 'instructions/file.md', defaultOptions);
    expect(result).toBe('../../commands/foo.md');
  });

  it('handles deeply nested file paths', () => {
    // File at .github/deep/nested/path/file.md (depth 3)
    // Need 4 ../ to exit .github and reach plugin root
    const result = adjustRelativePath(
      '../../../../skills/foo/SKILL.md',
      'deep/nested/path/file.md',
      defaultOptions,
    );
    expect(result).toBe('../../../../.agents/skills/foo/SKILL.md');
  });
});

describe('adjustLinksInContent', () => {
  const defaultOptions = {
    workspaceSkillsPath: '.agents/skills/',
  };

  it('adjusts #file: references', () => {
    // File at .github/instructions/file.md, ../../ exits .github
    const content = 'See #file:../../skills/foo/SKILL.md for details';
    const result = adjustLinksInContent(content, 'instructions/file.md', defaultOptions);
    expect(result).toBe('See #file:../../.agents/skills/foo/SKILL.md for details');
  });

  it('adjusts markdown links', () => {
    // File at .github/instructions/file.md
    const content = 'See [Skill Guide](../../skills/foo/SKILL.md) for details';
    const result = adjustLinksInContent(content, 'instructions/file.md', defaultOptions);
    expect(result).toBe('See [Skill Guide](../../.agents/skills/foo/SKILL.md) for details');
  });

  it('adjusts multiple links in content', () => {
    const content = `
# Instructions

See #file:../../skills/skill1/SKILL.md for skill 1.

And [Skill 2](../../skills/skill2/README.md) for skill 2.
`;
    const result = adjustLinksInContent(content, 'instructions/file.md', defaultOptions);
    expect(result).toContain('#file:../../.agents/skills/skill1/SKILL.md');
    expect(result).toContain('[Skill 2](../../.agents/skills/skill2/README.md)');
  });

  it('preserves anchor links', () => {
    const content = 'See [Section](#section) for more info';
    const result = adjustLinksInContent(content, 'file.md', defaultOptions);
    expect(result).toBe('See [Section](#section) for more info');
  });

  it('preserves external URLs in markdown links', () => {
    const content = 'See [Docs](https://example.com/docs) for info';
    const result = adjustLinksInContent(content, 'file.md', defaultOptions);
    expect(result).toBe('See [Docs](https://example.com/docs) for info');
  });

  it('handles complex content with mixed link types', () => {
    // File at .github/instructions/copilot.md
    const content = `
# Copilot Instructions

Reference the [Skill Guide](../../skills/my-skill/SKILL.md) or use #file:../../skills/other-skill/index.ts.

For external docs, see [GitHub](https://github.com) and [internal section](#setup).

Local files stay: [Local](./local.md)
`;
    const result = adjustLinksInContent(content, 'instructions/copilot.md', defaultOptions);

    // Skills paths adjusted (../../ to reach plugin root)
    expect(result).toContain('[Skill Guide](../../.agents/skills/my-skill/SKILL.md)');
    expect(result).toContain('#file:../../.agents/skills/other-skill/index.ts');

    // External URLs unchanged
    expect(result).toContain('[GitHub](https://github.com)');

    // Anchor unchanged
    expect(result).toContain('[internal section](#setup)');

    // Local relative path unchanged (stays within .github)
    expect(result).toContain('[Local](./local.md)');
  });
});
