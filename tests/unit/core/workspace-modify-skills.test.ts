import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import {
  addDisabledSkill,
  removeDisabledSkill,
  getDisabledSkills,
} from '../../../src/core/workspace-modify.js';

describe('disabledSkills helpers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-test-'));
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('addDisabledSkill', () => {
    it('adds skill to empty disabledSkills', async () => {
      const config = { repositories: [], plugins: [], clients: ['claude'] };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await addDisabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(true);

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).toContain('superpowers:brainstorming');
    });

    it('returns error if skill already disabled', async () => {
      const config = {
        repositories: [],
        plugins: [],
        clients: ['claude'],
        disabledSkills: ['superpowers:brainstorming'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await addDisabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already disabled');
    });
  });

  describe('removeDisabledSkill', () => {
    it('removes skill from disabledSkills', async () => {
      const config = {
        repositories: [],
        plugins: [],
        clients: ['claude'],
        disabledSkills: ['superpowers:brainstorming', 'other:skill'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await removeDisabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(true);

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).not.toContain('superpowers:brainstorming');
      expect(skills).toContain('other:skill');
    });

    it('returns error if skill not in disabledSkills', async () => {
      const config = { repositories: [], plugins: [], clients: ['claude'] };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await removeDisabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already enabled');
    });
  });

  describe('getDisabledSkills', () => {
    it('returns empty array when no disabledSkills', async () => {
      const config = { repositories: [], plugins: [], clients: ['claude'] };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).toEqual([]);
    });
  });
});
