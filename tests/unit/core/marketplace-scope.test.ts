import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadRegistryFromPath,
  saveRegistryToPath,
  getProjectRegistryPath,
} from '../../../src/core/marketplace.js';
import type { MarketplaceRegistry } from '../../../src/core/marketplace.js';

describe('scope-aware registry loading and saving', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `marketplace-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getProjectRegistryPath', () => {
    it('returns correct path under .allagents', () => {
      const result = getProjectRegistryPath('/some/workspace');
      expect(result).toBe(join('/some/workspace', '.allagents', 'marketplaces.json'));
    });
  });

  describe('loadRegistryFromPath', () => {
    it('loads valid registry from file', async () => {
      const registryPath = join(tmpDir, 'marketplaces.json');
      const registry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'test-marketplace': {
            name: 'test-marketplace',
            source: { type: 'github', location: 'owner/repo' },
            path: '/some/path',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          },
        },
      };
      writeFileSync(registryPath, JSON.stringify(registry, null, 2));

      const loaded = await loadRegistryFromPath(registryPath);
      expect(loaded).toEqual(registry);
    });

    it('returns empty registry for nonexistent path', async () => {
      const loaded = await loadRegistryFromPath(join(tmpDir, 'nonexistent.json'));
      expect(loaded).toEqual({ version: 1, marketplaces: {} });
    });

    it('returns empty registry for invalid JSON', async () => {
      const registryPath = join(tmpDir, 'bad.json');
      writeFileSync(registryPath, 'not valid json {{{');

      const loaded = await loadRegistryFromPath(registryPath);
      expect(loaded).toEqual({ version: 1, marketplaces: {} });
    });
  });

  describe('saveRegistryToPath', () => {
    it('writes registry to specified path and creates parent dirs', async () => {
      const nestedPath = join(tmpDir, 'deep', 'nested', 'dir', 'marketplaces.json');
      const registry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'my-marketplace': {
            name: 'my-marketplace',
            source: { type: 'local', location: '/local/path' },
            path: '/local/path',
          },
        },
      };

      await saveRegistryToPath(registry, nestedPath);

      expect(existsSync(nestedPath)).toBe(true);
      const content = readFileSync(nestedPath, 'utf-8');
      expect(JSON.parse(content)).toEqual(registry);
      // Verify trailing newline
      expect(content.endsWith('\n')).toBe(true);
    });
  });
});
