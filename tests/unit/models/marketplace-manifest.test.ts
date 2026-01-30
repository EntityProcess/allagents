import { describe, it, expect } from 'bun:test';
import {
  MarketplaceManifestSchema,
  type MarketplaceManifest,
  type MarketplacePluginEntry,
} from '../../../src/models/marketplace-manifest.js';

describe('MarketplaceManifestSchema', () => {
  it('should validate a minimal manifest (WTG format)', () => {
    const manifest = {
      name: 'wtg-ai-prompts',
      description: 'WiseTech Global plugins',
      plugins: [
        {
          name: 'cargowise',
          description: 'CargoWise coding guidelines',
          source: './plugins/cargowise',
        },
      ],
    };
    const result = MarketplaceManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('wtg-ai-prompts');
      expect(result.data.plugins).toHaveLength(1);
      expect(result.data.plugins[0].name).toBe('cargowise');
    }
  });

  it('should validate a full manifest (Anthropic format)', () => {
    const manifest = {
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      name: 'claude-plugins-official',
      description: 'Directory of popular Claude Code extensions',
      owner: {
        name: 'Anthropic',
        email: 'support@anthropic.com',
      },
      plugins: [
        {
          name: 'typescript-lsp',
          description: 'TypeScript language server',
          version: '1.0.0',
          author: { name: 'Anthropic', email: 'support@anthropic.com' },
          source: './plugins/typescript-lsp',
          category: 'development',
          homepage: 'https://github.com/anthropics/claude-plugins-public',
          strict: false,
          tags: ['community-managed'],
          lspServers: {
            typescript: {
              command: 'typescript-language-server',
              args: ['--stdio'],
              extensionToLanguage: { '.ts': 'typescript' },
            },
          },
        },
      ],
    };
    const result = MarketplaceManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins[0].category).toBe('development');
      expect(result.data.plugins[0].homepage).toBe(
        'https://github.com/anthropics/claude-plugins-public',
      );
    }
  });

  it('should validate plugin with URL source object', () => {
    const manifest = {
      name: 'test',
      description: 'test',
      plugins: [
        {
          name: 'figma',
          description: 'Figma integration',
          source: { source: 'url', url: 'https://github.com/figma/mcp-server-guide.git' },
        },
      ],
    };
    const result = MarketplaceManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      const source = result.data.plugins[0].source;
      expect(typeof source).toBe('object');
      if (typeof source === 'object') {
        expect(source.url).toBe('https://github.com/figma/mcp-server-guide.git');
      }
    }
  });

  it('should validate manifest with owner', () => {
    const manifest = {
      name: 'test',
      description: 'test',
      owner: { name: 'Org', email: 'org@example.com' },
      plugins: [],
    };
    const result = MarketplaceManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.owner?.name).toBe('Org');
    }
  });

  it('should validate manifest with owner without email', () => {
    const manifest = {
      name: 'test',
      description: 'test',
      owner: { name: 'Org' },
      plugins: [],
    };
    const result = MarketplaceManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('should reject manifest without name', () => {
    const manifest = { description: 'test', plugins: [] };
    const result = MarketplaceManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('should reject manifest without plugins array', () => {
    const manifest = { name: 'test', description: 'test' };
    const result = MarketplaceManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('should reject plugin without name', () => {
    const manifest = {
      name: 'test',
      description: 'test',
      plugins: [{ description: 'no name', source: './plugins/foo' }],
    };
    const result = MarketplaceManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('should reject plugin without description', () => {
    const manifest = {
      name: 'test',
      description: 'test',
      plugins: [{ name: 'foo', source: './plugins/foo' }],
    };
    const result = MarketplaceManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('should reject plugin without source', () => {
    const manifest = {
      name: 'test',
      description: 'test',
      plugins: [{ name: 'foo', description: 'desc' }],
    };
    const result = MarketplaceManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });
});
