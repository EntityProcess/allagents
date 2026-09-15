import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeProfileAdapter } from '../../../../src/core/profile/adapters/claude.js';
import { CopilotProfileAdapter } from '../../../../src/core/profile/adapters/copilot.js';
import { CodexProfileAdapter } from '../../../../src/core/profile/adapters/codex.js';
import { OmpProfileAdapter } from '../../../../src/core/profile/adapters/omp.js';
import { OpenCodeProfileAdapter } from '../../../../src/core/profile/adapters/opencode.js';
import { PiProfileAdapter } from '../../../../src/core/profile/adapters/pi.js';
import { getProfileAdapter } from '../../../../src/core/profile/adapters/registry.js';
import type {
  ProfileClientContext,
  ProfileResolvedPlugin,
} from '../../../../src/core/profile/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): { home: string; workspace: string } {
  const home = mkdtempSync(join(tmpdir(), 'allagents-profile-adapter-'));
  temporaryDirectories.push(home);
  const workspace = join(home, 'workspace');
  mkdirSync(workspace, { recursive: true });
  return { home, workspace };
}

function nativePlugin(
  overrides: Partial<ProfileResolvedPlugin> = {},
): ProfileResolvedPlugin {
  return {
    declarationIndex: 0,
    source: 'npm:example',
    install: 'native',
    ...overrides,
  };
}

function expectFrozenContext(context: ProfileClientContext): void {
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.operationContext)).toBe(true);
  expect(Object.isFrozen(context.operationContext.env)).toBe(true);
  expect(Object.isFrozen(context.fileMapping)).toBe(true);
  expect(Object.isFrozen(context.launcher)).toBe(true);
  expect(Object.isFrozen(context.launcher.args)).toBe(true);
  expect(Object.isFrozen(context.launcher.env)).toBe(true);
}

describe('Pi profile adapter', () => {
  test('freezes one selected root and resolves relative native sources from the workspace', () => {
    const paths = fixture();
    const environment = {
      PI_CODING_AGENT_DIR: '/ambient/pi',
      SENTINEL: 'preserved',
    };
    const adapter = new PiProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: paths.home,
      workspaceDirectory: paths.workspace,
      environment,
    });
    environment.PI_CODING_AGENT_DIR = '/changed/after-resolution';

    const root = join(
      paths.home,
      '.allagents',
      'profiles',
      'review',
      'clients',
      'pi',
      'agent',
    );
    expect(context).toMatchObject({
      profileName: 'review',
      client: 'pi',
      mechanism: 'agent-directory',
      root,
      fileMapping: { skillsPath: 'skills/', agentFile: 'AGENTS.md' },
      launcher: {
        command: 'pi',
        args: [],
        env: { PI_CODING_AGENT_DIR: root },
      },
      operationContext: {
        client: 'pi',
        scope: 'user',
        nativeScope: 'profile:review',
        root,
        cwd: paths.workspace,
      },
    });
    expect(context.operationContext.env).toMatchObject({
      PI_CODING_AGENT_DIR: root,
      SENTINEL: 'preserved',
    });
    expectFrozenContext(context);

    const source = adapter.resolveNativeSource(
      nativePlugin({ source: './packages/local' }),
      context,
    );
    expect(source.success).toBe(true);
    expect(source.resource?.resolvedIdentity).toBe(
      `local:${join(paths.workspace, 'packages', 'local')}`,
    );
  });

  test('rejects credential-bearing sources and unsupported native skill filters', () => {
    const paths = fixture();
    const adapter = new PiProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: paths.home,
      workspaceDirectory: paths.workspace,
    });

    expect(
      adapter.resolveNativeSource(
        nativePlugin({
          source: 'https://token:secret@github.com/acme/private.git',
        }),
        context,
      ).error,
    ).toContain('credential');
    expect(
      adapter.resolveNativeSource(
        nativePlugin({ skills: ['one-skill'] }),
        context,
      ).error,
    ).toContain('skill filtering');
  });

  test('emits no settings file and serializes strict MCP only under the selected root', () => {
    const paths = fixture();
    const adapter = new PiProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: paths.home,
      workspaceDirectory: paths.workspace,
    });

    expect(adapter.serializeSettings(context, { plugins: [] })).toBeNull();
    expect(() =>
      adapter.serializeSettings(context, {
        plugins: [],
        settings: { unexpected: true },
      }),
    ).toThrow('does not support settings');

    const planned = adapter.serializeMcp(context, {
      plugins: [],
      mcpServers: {
        zeta: {
          command: 'server',
          env: { TOKEN: '${TOKEN}' },
          clients: ['pi'],
        },
        ignored: { command: 'other', clients: ['omp'] },
        alpha: { type: 'http', url: 'https://example.com/mcp' },
      },
    });
    expect(planned).toEqual({
      key: 'pi:mcp',
      client: 'pi',
      kind: 'mcp',
      path: join(context.root, 'mcp.json'),
      content:
        '{\n  "mcpServers": {\n    "alpha": {\n      "type": "http",\n      "url": "https://example.com/mcp"\n    },\n    "zeta": {\n      "command": "server",\n      "env": {\n        "TOKEN": "${TOKEN}"\n      }\n    }\n  }\n}\n',
      mode: 0o600,
    });
    expect(() =>
      adapter.serializeMcp(context, {
        plugins: [],
        mcpServers: {
          secret: { command: 'server', env: { TOKEN: 'resolved-secret' } },
        },
      }),
    ).toThrow('exact ${ENV_VAR} reference');
  });
});

describe('OMP profile adapter', () => {
  test('rejects the reserved ordinary-state profile before resolving roots', () => {
    const paths = fixture();
    expect(() =>
      new OmpProfileAdapter().resolveContext('default', {
        homeDir: paths.home,
        workspaceDirectory: paths.workspace,
      }),
    ).toThrow("Invalid OMP profile name 'default'");
  });

  test('resolves named profile roots with independent XDG existence gates', () => {
    const paths = fixture();
    const xdgData = join(paths.home, 'xdg-data');
    const xdgState = join(paths.home, 'xdg-state');
    const xdgCache = join(paths.home, 'xdg-cache');
    const dataProfile = join(xdgData, 'omp', 'profiles', 'review');
    const cacheProfile = join(xdgCache, 'omp', 'profiles', 'review');
    mkdirSync(dataProfile, { recursive: true });
    mkdirSync(cacheProfile, { recursive: true });
    const environment = {
      HOME: '/ambient/home',
      USERPROFILE: '/ambient/user-profile',
      PI_CONFIG_DIR: '.config/omp',
      OMP_PROFILE: 'ambient',
      PI_PROFILE: 'legacy',
      PI_CODING_AGENT_DIR: '/ambient/agent',
      PI_CONFIG_FILES: '/ambient/config.yml',
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      XDG_CACHE_HOME: xdgCache,
      SENTINEL: 'preserved',
    };
    const adapter = new OmpProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: paths.home,
      workspaceDirectory: paths.workspace,
      environment,
      platform: 'linux',
    });
    environment.OMP_PROFILE = 'changed';

    const profileRoot = join(paths.home, '.config', 'omp', 'profiles', 'review');
    expect(context).toMatchObject({
      client: 'omp',
      mechanism: 'named-profile',
      root: join(profileRoot, 'agent'),
      fileMapping: {
        skillsPath: 'skills/',
        hooksPath: 'hooks/',
        agentFile: 'AGENTS.md',
      },
      launcher: {
        command: 'omp',
        args: ['--profile', 'review'],
      },
      operationContext: {
        client: 'omp',
        scope: 'user',
        nativeScope: 'profile:review',
        cwd: paths.workspace,
        roots: {
          config: profileRoot,
          agent: join(profileRoot, 'agent'),
          data: dataProfile,
          state: profileRoot,
          cache: cacheProfile,
          dataAgent: dataProfile,
          stateAgent: join(profileRoot, 'agent'),
          cacheAgent: cacheProfile,
        },
      },
    });

    expect(context.operationContext.env).toMatchObject({
      HOME: paths.home,
      USERPROFILE: paths.home,
      PI_CONFIG_DIR: '.config/omp',
      OMP_PROFILE: undefined,
      PI_PROFILE: undefined,
      PI_CODING_AGENT_DIR: undefined,
      PI_CONFIG_FILES: undefined,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: undefined,
      XDG_CACHE_HOME: xdgCache,
      SENTINEL: 'preserved',
    });
    expect(context.launcher.env).toEqual({
      HOME: paths.home,
      USERPROFILE: paths.home,
      PI_CONFIG_DIR: '.config/omp',
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: undefined,
      XDG_CACHE_HOME: xdgCache,
      OMP_PROFILE: undefined,
      PI_PROFILE: undefined,
      PI_CODING_AGENT_DIR: undefined,
      PI_CONFIG_FILES: undefined,
    });
    expectFrozenContext(context);
  });

  test('does not activate XDG on unsupported platforms', () => {
    const paths = fixture();
    const xdg = join(paths.home, 'xdg');
    mkdirSync(join(xdg, 'omp', 'profiles', 'review'), { recursive: true });
    const context = new OmpProfileAdapter().resolveContext('review', {
      homeDir: paths.home,
      workspaceDirectory: paths.workspace,
      environment: {
        XDG_DATA_HOME: xdg,
        XDG_STATE_HOME: xdg,
        XDG_CACHE_HOME: xdg,
      },
      platform: 'win32',
    });
    const profileRoot = join(paths.home, '.omp', 'profiles', 'review');

    expect(context.operationContext.roots).toMatchObject({
      data: profileRoot,
      state: profileRoot,
      cache: profileRoot,
    });
  });

  test('requires authoritative plugin metadata for marketplace sources and rejects filters', () => {
    const paths = fixture();
    const adapter = new OmpProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: paths.home,
      workspaceDirectory: paths.workspace,
    });

    const resolved = adapter.resolveNativeSource(
      nativePlugin({
        source: 'acme/tools',
        marketplace: 'tools',
        pluginName: 'reviewer',
      }),
      context,
    );
    expect(resolved.resource).toMatchObject({
      resolvedIdentity: 'reviewer@tools',
      provenance: { marketplaceSource: 'acme/tools' },
    });
    expect(
      adapter.resolveNativeSource(
        nativePlugin({ source: 'acme/tools' }),
        context,
      ).error,
    ).toContain('authoritative marketplace');
    expect(
      adapter.resolveNativeSource(
        nativePlugin({
          source: 'reviewer@tools',
          skills: { exclude: ['unsafe'] },
        }),
        context,
      ).error,
    ).toContain('skill filtering');
  });
  test('accepts canonical main refs and rejects unenforceable OMP refs', () => {
    const paths = fixture();
    const adapter = new OmpProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: paths.home,
      workspaceDirectory: paths.workspace,
    });
    const resolvedSha = 'a'.repeat(40);

    const main = adapter.resolveNativeSource(
      nativePlugin({
        source: 'acme/tools',
        requestedRef: 'main',
        resolvedRef: 'main',
        resolvedSha,
        marketplace: 'tools',
        pluginName: 'reviewer',
      }),
      context,
    );
    expect(main).toMatchObject({
      success: true,
      resource: {
        resolvedIdentity: 'reviewer@tools',
        provenance: {
          marketplaceSource: 'acme/tools',
          requestedRef: 'main',
          resolvedRef: 'main',
          resolvedSha,
        },
      },
    });
    const cachedMarketplace = join(
      paths.home,
      '.allagents',
      'plugins',
      'marketplaces',
      'acme-tools-main',
    );
    mkdirSync(cachedMarketplace, { recursive: true });
    expect(
      adapter.resolveNativeSource(
        nativePlugin({
          source: 'acme/tools',
          requestedRef: 'main',
          resolvedRef: 'main',
          resolvedSha,
          path: cachedMarketplace,
          marketplace: 'tools',
          pluginName: 'reviewer',
        }),
        context,
      ).resource?.provenance.marketplaceSource,
    ).toBe(cachedMarketplace);


    expect(
      adapter.resolveNativeSource(
        nativePlugin({
          source: 'acme/tools',
          requestedRef: 'main',
          resolvedRef: 'release-1',
          resolvedSha,
          marketplace: 'tools',
          pluginName: 'reviewer',
        }),
        context,
      ).error,
    ).toContain("requested ref 'main' resolved as 'release-1'");
    expect(
      adapter.resolveNativeSource(
        nativePlugin({
          source: 'acme/tools',
          requestedRef: 'release-1',
          resolvedRef: 'release-1',
          resolvedSha,
          marketplace: 'tools',
          pluginName: 'reviewer',
        }),
        context,
      ).error,
    ).toContain("cannot enforce marketplace ref 'release-1'");
  });


  test('serializes OMP-native MCP and reports unsupported settings', () => {
    const paths = fixture();
    const adapter = new OmpProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: paths.home,
      workspaceDirectory: paths.workspace,
    });

    expect(() =>
      adapter.serializeSettings(context, {
        plugins: [],
        settings: { theme: 'dark' },
      }),
    ).toThrow('does not support settings');
    expect(adapter.serializeMcp(context, { plugins: [] })).toBeNull();
    const planned = adapter.serializeMcp(context, {
      plugins: [],
      mcpServers: {
        server: { command: 'npx', args: ['-y', 'mcp-server'] },
      },
    });
    expect(planned?.path).toBe(join(context.root, 'mcp.json'));
    expect(planned?.content).toBe(
      '{\n  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",\n  "mcpServers": {\n    "server": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "mcp-server"\n      ]\n    }\n  }\n}\n',
    );
  });
});

describe('profile adapter registry', () => {
  test('returns every implemented profile adapter', () => {
    expect(getProfileAdapter('pi')).toBeInstanceOf(PiProfileAdapter);
    expect(getProfileAdapter('omp')).toBeInstanceOf(OmpProfileAdapter);
    expect(getProfileAdapter('opencode')).toBeInstanceOf(
      OpenCodeProfileAdapter,
    );
    expect(getProfileAdapter('copilot')).toBeInstanceOf(CopilotProfileAdapter);
    expect(getProfileAdapter('codex')).toBeInstanceOf(CodexProfileAdapter);
    expect(getProfileAdapter('claude')).toBeInstanceOf(ClaudeProfileAdapter);
  });
});
