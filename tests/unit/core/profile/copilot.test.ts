import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { CopilotProfileAdapter } from '../../../../src/core/profile/adapters/copilot.js';

describe('Copilot profile adapter', () => {
  it('selects an isolated configuration and cache root while preserving cwd', () => {
    const adapter = new CopilotProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
      environment: {
        COPILOT_HOME: '/ambient/copilot',
        COPILOT_CACHE_HOME: '/ambient/cache',
        COPILOT_PROVIDERS_CONFIG: '/ambient/providers.json',
        SENTINEL: 'preserved',
      },
    });
    const clientRoot = join(
      '/home/test',
      '.allagents',
      'profiles',
      'review',
      'clients',
      'copilot',
    );
    const root = join(clientRoot, 'home');
    const cache = join(clientRoot, 'cache');

    expect(context).toMatchObject({
      client: 'copilot',
      mechanism: 'configuration-root',
      root,
      operationContext: {
        root,
        cwd: '/work/project',
        nativeScope: 'profile:review',
        roots: { config: clientRoot, agent: root, cache },
        env: {
          COPILOT_HOME: root,
          COPILOT_CACHE_HOME: cache,
          COPILOT_PROVIDERS_CONFIG: undefined,
          SENTINEL: 'preserved',
        },
      },
      fileMapping: {
        skillsPath: 'skills/',
        agentsPath: 'agents/',
        hooksPath: 'hooks/',
        agentFile: 'copilot-instructions.md',
      },
      launcher: {
        command: 'copilot',
        args: [],
        env: {
          COPILOT_HOME: root,
          COPILOT_CACHE_HOME: cache,
          COPILOT_PROVIDERS_CONFIG: undefined,
        },
      },
    });
    expect(adapter.capabilities).toMatchObject({
      nativeInstall: true,
      fileInstall: true,
      skillFilters: true,
      mcp: true,
      settings: true,
      recursiveRootCleanup: true,
    });
  });

  it('requires authoritative marketplace metadata for native installation', () => {
    const adapter = new CopilotProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
    });

    expect(
      adapter.resolveNativeSource(
        {
          declarationIndex: 0,
          source: 'EveryInc/compound-engineering-plugin',
          install: 'native',
        },
        context,
      ).error,
    ).toContain('authoritative marketplace');
    expect(
      adapter.resolveNativeSource(
        {
          declarationIndex: 0,
          source: 'EveryInc/compound-engineering-plugin',
          marketplace: 'compound-engineering-plugin',
          pluginName: 'compound-engineering',
          marketplaceSource: '/cache/compound-engineering-plugin',
          marketplaceRegistrationManaged: true,
          install: 'native',
        },
        context,
      ).resource,
    ).toMatchObject({
      requestedIdentity: 'EveryInc/compound-engineering-plugin',
      resolvedIdentity: 'compound-engineering@compound-engineering-plugin',
      provenance: {
        marketplaceName: 'compound-engineering-plugin',
        marketplaceSource: '/cache/compound-engineering-plugin',
        managedMarketplaceRegistration: 'true',
      },
    });
    expect(
      adapter.resolveNativeSource(
        {
          declarationIndex: 0,
          source: 'plugin@marketplace',
          marketplace: 'marketplace',
          pluginName: 'plugin',
          requestedRef: 'main',
          install: 'native',
        },
        context,
      ).error,
    ).toContain('cannot enforce ref');
    expect(
      adapter.resolveNativeSource(
        {
          declarationIndex: 0,
          source: 'plugin@marketplace',
          marketplace: 'marketplace',
          pluginName: 'plugin',
          install: 'native',
          skills: ['one-skill'],
        },
        context,
      ).error,
    ).toContain('skill filtering');
  });

  it('serializes documented settings and selected MCP servers without resolving secrets', () => {
    const adapter = new CopilotProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
    });
    const settings = adapter.serializeSettings(context, {
      plugins: [],
      settings: {
        autoUpdate: false,
        remote: 'off',
        remoteExport: false,
        'ide.autoConnect': false,
        disableAllHooks: true,
      },
    });
    expect(JSON.parse(settings?.content ?? '{}')).toEqual({
      autoUpdate: false,
      disableAllHooks: true,
      remote: 'off',
      remoteExport: false,
      'ide.autoConnect': false,
    });
    expect(settings).toMatchObject({
      key: 'copilot:settings',
      client: 'copilot',
      kind: 'settings',
      path: join(context.root, 'settings.json'),
      mode: 0o600,
    });
    const mcp = adapter.serializeMcp(context, {
      plugins: [],
      mcpServers: {
        local: {
          command: 'local-mcp',
          args: ['--token', '${LOCAL_TOKEN}'],
          env: { LOCAL_TOKEN: '${LOCAL_TOKEN}' },
          clients: ['copilot'],
        },
        remote: {
          type: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: '${REMOTE_TOKEN}' },
        },
        ignored: { command: 'ignored', clients: ['pi'] },
      },
    });
    expect(JSON.parse(mcp?.content ?? '{}')).toEqual({
      mcpServers: {
        local: {
          type: 'stdio',
          command: 'local-mcp',
          args: ['--token', '${LOCAL_TOKEN}'],
          env: { LOCAL_TOKEN: '${LOCAL_TOKEN}' },
          tools: ['*'],
        },
        remote: {
          type: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: '${REMOTE_TOKEN}' },
          tools: ['*'],
        },
      },
    });
    expect(mcp?.path).toBe(join(context.root, 'mcp-config.json'));
    expect(adapter.serializeSettings(context, { plugins: [] })).toBeNull();
    expect(adapter.serializeMcp(context, { plugins: [] })).toBeNull();
    const nativeSettings = adapter.serializeSettings(context, {
      plugins: [
        {
          declarationIndex: 0,
          source: 'EveryInc/compound-engineering-plugin',
          marketplace: 'compound-engineering-plugin',
          pluginName: 'compound-engineering',
          marketplaceSource: 'EveryInc/compound-engineering-plugin',
          install: 'native',
        },
      ],
    });
    expect(JSON.parse(nativeSettings?.content ?? '{}')).toEqual({
      extraKnownMarketplaces: {
        'compound-engineering-plugin': {
          source: {
            source: 'github',
            repo: 'EveryInc/compound-engineering-plugin',
          },
        },
      },
      enabledPlugins: {
        'compound-engineering@compound-engineering-plugin': true,
      },
    });
    const marketplaceSettings = JSON.parse(
      adapter.serializeSettings(context, {
        plugins: [
          {
            declarationIndex: 0,
            source: 'nested',
            marketplace: 'nested',
            pluginName: 'nested-plugin',
            marketplaceSource: 'EveryInc/plugins/catalog',
            install: 'native',
          },
          {
            declarationIndex: 1,
            source: 'git',
            marketplace: 'git',
            pluginName: 'git-plugin',
            marketplaceSource: 'https://git.example.test/plugins.git',
            install: 'native',
          },
          {
            declarationIndex: 2,
            source: 'local',
            marketplace: 'local',
            pluginName: 'local-plugin',
            marketplaceSource: '/work/marketplace',
            install: 'native',
          },
        ],
      })?.content ?? '{}',
    ).extraKnownMarketplaces;
    expect(marketplaceSettings).toEqual({
      nested: {
        source: {
          source: 'github',
          repo: 'EveryInc/plugins',
          path: 'catalog',
        },
      },
      git: {
        source: {
          source: 'git',
          url: 'https://git.example.test/plugins.git',
        },
      },
      local: {
        source: {
          source: 'directory',
          path: '/work/marketplace',
        },
      },
    });
  });
});
