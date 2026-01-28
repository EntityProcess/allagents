import { describe, it, expect } from 'bun:test';
import {
  resolveSkillNames,
  getResolvedName,
  getSkillKey,
  getDisambiguatorPrefix,
  type SkillEntry,
} from '../../../src/utils/skill-name-resolver.js';

describe('getSkillKey', () => {
  it('should generate a unique key from skill entry', () => {
    const entry: SkillEntry = {
      folderName: 'my-skill',
      pluginName: 'my-plugin',
      pluginSource: 'github:org/repo',
    };
    const key = getSkillKey(entry);
    expect(key).toBe('github:org/repo::my-plugin::my-skill');
  });

  it('should generate different keys for different entries', () => {
    const entry1: SkillEntry = {
      folderName: 'skill',
      pluginName: 'plugin-a',
      pluginSource: 'github:org/repo-a',
    };
    const entry2: SkillEntry = {
      folderName: 'skill',
      pluginName: 'plugin-b',
      pluginSource: 'github:org/repo-b',
    };
    expect(getSkillKey(entry1)).not.toBe(getSkillKey(entry2));
  });
});

describe('getDisambiguatorPrefix', () => {
  it('should extract org from GitHub URL', () => {
    expect(getDisambiguatorPrefix('github:anthropic/plugins')).toBe(
      'anthropic',
    );
  });

  it('should extract org from GitHub shorthand', () => {
    expect(getDisambiguatorPrefix('my-org/my-repo')).toBe('my-org');
  });

  it('should extract org from full GitHub URL', () => {
    expect(
      getDisambiguatorPrefix('https://github.com/acme-corp/tools'),
    ).toBe('acme-corp');
  });

  it('should return hash for local path starting with /', () => {
    const prefix = getDisambiguatorPrefix('/home/user/plugins/my-plugin');
    expect(prefix).toMatch(/^[0-9a-f]{6}$/);
  });

  it('should return hash for local path starting with .', () => {
    const prefix = getDisambiguatorPrefix('./local/plugin');
    expect(prefix).toMatch(/^[0-9a-f]{6}$/);
  });

  it('should return hash for Windows path', () => {
    const prefix = getDisambiguatorPrefix('C:\\Users\\dev\\plugins');
    expect(prefix).toMatch(/^[0-9a-f]{6}$/);
  });

  it('should return deterministic hash for same local path', () => {
    const path = '/home/user/my-plugin';
    const prefix1 = getDisambiguatorPrefix(path);
    const prefix2 = getDisambiguatorPrefix(path);
    expect(prefix1).toBe(prefix2);
  });

  it('should return different hashes for different local paths', () => {
    const prefix1 = getDisambiguatorPrefix('/path/to/plugin-a');
    const prefix2 = getDisambiguatorPrefix('/path/to/plugin-b');
    expect(prefix1).not.toBe(prefix2);
  });
});

describe('resolveSkillNames', () => {
  describe('no conflicts', () => {
    it('should use folder names as-is when all unique', () => {
      const skills: SkillEntry[] = [
        {
          folderName: 'skill-a',
          pluginName: 'plugin-1',
          pluginSource: 'github:org/repo-1',
        },
        {
          folderName: 'skill-b',
          pluginName: 'plugin-2',
          pluginSource: 'github:org/repo-2',
        },
        {
          folderName: 'skill-c',
          pluginName: 'plugin-3',
          pluginSource: 'github:org/repo-3',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(3);
      expect(result.resolved[0]?.resolvedName).toBe('skill-a');
      expect(result.resolved[0]?.wasRenamed).toBe(false);
      expect(result.resolved[1]?.resolvedName).toBe('skill-b');
      expect(result.resolved[1]?.wasRenamed).toBe(false);
      expect(result.resolved[2]?.resolvedName).toBe('skill-c');
      expect(result.resolved[2]?.wasRenamed).toBe(false);
    });

    it('should handle single skill', () => {
      const skills: SkillEntry[] = [
        {
          folderName: 'only-skill',
          pluginName: 'single-plugin',
          pluginSource: 'github:solo/repo',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(1);
      expect(result.resolved[0]?.resolvedName).toBe('only-skill');
      expect(result.resolved[0]?.wasRenamed).toBe(false);
    });

    it('should handle empty array', () => {
      const skills: SkillEntry[] = [];
      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(0);
      expect(result.nameMap.size).toBe(0);
    });
  });

  describe('folder name conflicts with unique plugin names', () => {
    it('should qualify with plugin name when folder names conflict', () => {
      const skills: SkillEntry[] = [
        {
          folderName: 'commit',
          pluginName: 'git-tools',
          pluginSource: 'github:team-a/plugins',
        },
        {
          folderName: 'commit',
          pluginName: 'dev-utils',
          pluginSource: 'github:team-b/plugins',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(2);
      expect(result.resolved[0]?.resolvedName).toBe('git-tools_commit');
      expect(result.resolved[0]?.wasRenamed).toBe(true);
      expect(result.resolved[1]?.resolvedName).toBe('dev-utils_commit');
      expect(result.resolved[1]?.wasRenamed).toBe(true);
    });

    it('should handle multiple skills with same folder name', () => {
      const skills: SkillEntry[] = [
        {
          folderName: 'format',
          pluginName: 'prettier-plugin',
          pluginSource: 'github:formatter/prettier',
        },
        {
          folderName: 'format',
          pluginName: 'eslint-plugin',
          pluginSource: 'github:linter/eslint',
        },
        {
          folderName: 'format',
          pluginName: 'stylelint-plugin',
          pluginSource: 'github:linter/stylelint',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(3);
      expect(result.resolved[0]?.resolvedName).toBe('prettier-plugin_format');
      expect(result.resolved[1]?.resolvedName).toBe('eslint-plugin_format');
      expect(result.resolved[2]?.resolvedName).toBe('stylelint-plugin_format');
    });

    it('should mix renamed and non-renamed skills', () => {
      const skills: SkillEntry[] = [
        {
          folderName: 'unique-skill',
          pluginName: 'plugin-a',
          pluginSource: 'github:org/repo-a',
        },
        {
          folderName: 'duplicate',
          pluginName: 'plugin-b',
          pluginSource: 'github:org/repo-b',
        },
        {
          folderName: 'duplicate',
          pluginName: 'plugin-c',
          pluginSource: 'github:org/repo-c',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(3);

      const unique = result.resolved.find(
        (r) => r.original.folderName === 'unique-skill',
      );
      expect(unique?.resolvedName).toBe('unique-skill');
      expect(unique?.wasRenamed).toBe(false);

      const dup1 = result.resolved.find(
        (r) => r.original.pluginName === 'plugin-b',
      );
      expect(dup1?.resolvedName).toBe('plugin-b_duplicate');
      expect(dup1?.wasRenamed).toBe(true);

      const dup2 = result.resolved.find(
        (r) => r.original.pluginName === 'plugin-c',
      );
      expect(dup2?.resolvedName).toBe('plugin-c_duplicate');
      expect(dup2?.wasRenamed).toBe(true);
    });
  });

  describe('folder name AND plugin name conflicts', () => {
    it('should use org prefix for GitHub sources', () => {
      const skills: SkillEntry[] = [
        {
          folderName: 'test',
          pluginName: 'testing',
          pluginSource: 'github:company-a/plugins',
        },
        {
          folderName: 'test',
          pluginName: 'testing',
          pluginSource: 'github:company-b/plugins',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(2);
      expect(result.resolved[0]?.resolvedName).toBe('company-a_testing_test');
      expect(result.resolved[0]?.wasRenamed).toBe(true);
      expect(result.resolved[1]?.resolvedName).toBe('company-b_testing_test');
      expect(result.resolved[1]?.wasRenamed).toBe(true);
    });

    it('should use hash prefix for local paths', () => {
      const skills: SkillEntry[] = [
        {
          folderName: 'build',
          pluginName: 'builder',
          pluginSource: '/home/user/project-a/plugins',
        },
        {
          folderName: 'build',
          pluginName: 'builder',
          pluginSource: '/home/user/project-b/plugins',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(2);
      // Both should have 6-char hash prefix
      expect(result.resolved[0]?.resolvedName).toMatch(
        /^[0-9a-f]{6}_builder_build$/,
      );
      expect(result.resolved[1]?.resolvedName).toMatch(
        /^[0-9a-f]{6}_builder_build$/,
      );
      // And they should be different
      expect(result.resolved[0]?.resolvedName).not.toBe(
        result.resolved[1]?.resolvedName,
      );
    });

    it('should handle mixed GitHub and local sources with same names', () => {
      const skills: SkillEntry[] = [
        {
          folderName: 'deploy',
          pluginName: 'infra',
          pluginSource: 'github:acme-corp/tools',
        },
        {
          folderName: 'deploy',
          pluginName: 'infra',
          pluginSource: '/local/dev/plugins',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(2);
      expect(result.resolved[0]?.resolvedName).toBe('acme-corp_infra_deploy');
      expect(result.resolved[1]?.resolvedName).toMatch(
        /^[0-9a-f]{6}_infra_deploy$/,
      );
    });

    it('should handle three-way plugin name conflict', () => {
      const skills: SkillEntry[] = [
        {
          folderName: 'lint',
          pluginName: 'quality',
          pluginSource: 'github:org-1/repo',
        },
        {
          folderName: 'lint',
          pluginName: 'quality',
          pluginSource: 'github:org-2/repo',
        },
        {
          folderName: 'lint',
          pluginName: 'quality',
          pluginSource: 'github:org-3/repo',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(3);
      expect(result.resolved[0]?.resolvedName).toBe('org-1_quality_lint');
      expect(result.resolved[1]?.resolvedName).toBe('org-2_quality_lint');
      expect(result.resolved[2]?.resolvedName).toBe('org-3_quality_lint');
    });

    it('should handle partial plugin name conflicts', () => {
      // Two skills with same folder name, where two have same plugin name
      const skills: SkillEntry[] = [
        {
          folderName: 'check',
          pluginName: 'validator',
          pluginSource: 'github:alpha/tools',
        },
        {
          folderName: 'check',
          pluginName: 'validator',
          pluginSource: 'github:beta/tools',
        },
        {
          folderName: 'check',
          pluginName: 'verifier',
          pluginSource: 'github:gamma/tools',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.resolved).toHaveLength(3);
      // All should have org prefix because there's at least one plugin name conflict
      expect(result.resolved[0]?.resolvedName).toBe('alpha_validator_check');
      expect(result.resolved[1]?.resolvedName).toBe('beta_validator_check');
      expect(result.resolved[2]?.resolvedName).toBe('gamma_verifier_check');
    });
  });

  describe('nameMap', () => {
    it('should provide correct lookup via nameMap', () => {
      const skills: SkillEntry[] = [
        {
          folderName: 'skill-a',
          pluginName: 'plugin-1',
          pluginSource: 'github:org/repo-1',
        },
        {
          folderName: 'skill-b',
          pluginName: 'plugin-2',
          pluginSource: 'github:org/repo-2',
        },
      ];

      const result = resolveSkillNames(skills);

      expect(result.nameMap.get(getSkillKey(skills[0]!))).toBe('skill-a');
      expect(result.nameMap.get(getSkillKey(skills[1]!))).toBe('skill-b');
    });
  });
});

describe('getResolvedName', () => {
  it('should return resolved name for existing skill', () => {
    const skill: SkillEntry = {
      folderName: 'my-skill',
      pluginName: 'my-plugin',
      pluginSource: 'github:my-org/my-repo',
    };

    const result = resolveSkillNames([skill]);
    const name = getResolvedName(result, skill);

    expect(name).toBe('my-skill');
  });

  it('should return undefined for non-existing skill', () => {
    const skill1: SkillEntry = {
      folderName: 'skill-1',
      pluginName: 'plugin-1',
      pluginSource: 'github:org/repo',
    };
    const skill2: SkillEntry = {
      folderName: 'skill-2',
      pluginName: 'plugin-2',
      pluginSource: 'github:other/repo',
    };

    const result = resolveSkillNames([skill1]);
    const name = getResolvedName(result, skill2);

    expect(name).toBeUndefined();
  });

  it('should work with renamed skills', () => {
    const skills: SkillEntry[] = [
      {
        folderName: 'common',
        pluginName: 'alpha',
        pluginSource: 'github:org/alpha',
      },
      {
        folderName: 'common',
        pluginName: 'beta',
        pluginSource: 'github:org/beta',
      },
    ];

    const result = resolveSkillNames(skills);

    expect(getResolvedName(result, skills[0]!)).toBe('alpha_common');
    expect(getResolvedName(result, skills[1]!)).toBe('beta_common');
  });
});

describe('edge cases', () => {
  it('should handle skills with special characters in folder names', () => {
    const skills: SkillEntry[] = [
      {
        folderName: 'my-skill-v2',
        pluginName: 'plugin',
        pluginSource: 'github:org/repo',
      },
    ];

    const result = resolveSkillNames(skills);
    expect(result.resolved[0]?.resolvedName).toBe('my-skill-v2');
  });

  it('should handle GitHub URLs with branches', () => {
    const skills: SkillEntry[] = [
      {
        folderName: 'skill',
        pluginName: 'plugin',
        pluginSource: 'github:org/repo#feature-branch',
      },
      {
        folderName: 'skill',
        pluginName: 'plugin',
        pluginSource: 'github:other-org/repo#main',
      },
    ];

    const result = resolveSkillNames(skills);

    expect(result.resolved).toHaveLength(2);
    expect(result.resolved[0]?.resolvedName).toBe('org_plugin_skill');
    expect(result.resolved[1]?.resolvedName).toBe('other-org_plugin_skill');
  });

  it('should handle full GitHub URLs', () => {
    const skills: SkillEntry[] = [
      {
        folderName: 'utils',
        pluginName: 'helpers',
        pluginSource: 'https://github.com/enterprise/tools',
      },
      {
        folderName: 'utils',
        pluginName: 'helpers',
        pluginSource: 'https://github.com/community/tools',
      },
    ];

    const result = resolveSkillNames(skills);

    expect(result.resolved[0]?.resolvedName).toBe('enterprise_helpers_utils');
    expect(result.resolved[1]?.resolvedName).toBe('community_helpers_utils');
  });

  it('should preserve original entry in resolved result', () => {
    const skill: SkillEntry = {
      folderName: 'test-skill',
      pluginName: 'test-plugin',
      pluginSource: 'github:test-org/test-repo',
    };

    const result = resolveSkillNames([skill]);

    expect(result.resolved[0]?.original).toBe(skill);
    expect(result.resolved[0]?.original.folderName).toBe('test-skill');
    expect(result.resolved[0]?.original.pluginName).toBe('test-plugin');
    expect(result.resolved[0]?.original.pluginSource).toBe(
      'github:test-org/test-repo',
    );
  });
});
