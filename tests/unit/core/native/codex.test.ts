import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexNativeClient,
  parseCodexMarketplaceInventory,
  parseCodexPluginId,
  parseCodexPluginInventory,
} from '../../../../src/core/native/codex.js';
import type {
  NativeCommandOptions,
  NativeCommandResult,
  NativeOperationContext,
} from '../../../../src/core/native/types.js';

const roots: string[] = [];

function success(output = ''): NativeCommandResult {
  return { success: true, output, exitCode: 0 };
}

async function fixture(): Promise<NativeOperationContext> {
  const root = await mkdtemp(join(tmpdir(), 'allagents-codex-native-test-'));
  roots.push(root);
  return {
    client: 'codex',
    scope: 'user',
    nativeScope: 'profile:review',
    root,
    cwd: '/work/project',
    env: { CODEX_HOME: root },
    roots: { config: root, agent: root, data: root },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('native/codex', () => {
  test('parses exact plugin and marketplace JSON identities', () => {
    expect(parseCodexPluginId('demo@tools')).toEqual({
      plugin: 'demo',
      marketplace: 'tools',
    });
    expect(parseCodexPluginId('demo@owner/tools')).toBeNull();
    expect(
      parseCodexMarketplaceInventory(
        JSON.stringify({
          marketplaces: [
            {
              name: 'tools',
              root: '/marketplace',
              marketplaceSource: {
                sourceType: 'local',
                source: '/marketplace',
              },
            },
          ],
        }),
      ),
    ).toEqual([
      {
        name: 'tools',
        root: '/marketplace',
        marketplaceSource: {
          sourceType: 'local',
          source: '/marketplace',
        },
      },
    ]);
    expect(
      parseCodexPluginInventory(
        JSON.stringify({
          installed: [
            {
              pluginId: 'demo@tools',
              name: 'demo',
              marketplaceName: 'tools',
              installed: true,
              enabled: true,
            },
          ],
          available: [],
        }),
      )?.installed[0]?.pluginId,
    ).toBe('demo@tools');
    expect(parseCodexPluginInventory('[]')).toBeNull();
  });

  test('gates the JSON lifecycle and version in disposable Codex homes', async () => {
    const selectedRoot = join(tmpdir(), 'allagents-codex-selected-missing');
    const homes: string[] = [];
    const calls: string[][] = [];
    const execute = async (
      _binary: string,
      args: string[],
      options?: NativeCommandOptions,
    ) => {
      calls.push(args);
      homes.push(options?.env?.CODEX_HOME ?? '');
      return args[0] === '--version'
        ? success('codex-cli 0.149.0\n')
        : success('Commands: add list marketplace remove\n');
    };
    const client = new CodexNativeClient({
      minimumVersion: [0, 149, 0],
      execute,
    });
    const context: NativeOperationContext = {
      client: 'codex',
      scope: 'user',
      nativeScope: 'profile:review',
      root: selectedRoot,
      env: { CODEX_HOME: selectedRoot },
    };

    expect(await client.isAvailable(context)).toBe(true);
    expect(calls).toEqual([['--version'], ['plugin', '--help']]);
    expect(homes.every((home) => home !== selectedRoot)).toBe(true);
    const oldClient = new CodexNativeClient({
      minimumVersion: [0, 149, 0],
      execute: async () => success('codex-cli 0.148.0\n'),
    });
    expect(await oldClient.isAvailable(context)).toBe(false);
    expect(await client.inspect(context)).toEqual({
      success: true,
      resources: [],
    });
  });

  test('reports enabled plugins and classifies disabled plugins separately', async () => {
    const context = await fixture();
    const client = new CodexNativeClient({
      execute: async () =>
        success(
          JSON.stringify({
            installed: [
              {
                pluginId: 'enabled@tools',
                name: 'enabled',
                marketplaceName: 'tools',
                installed: true,
                enabled: true,
              },
              {
                pluginId: 'disabled@tools',
                name: 'disabled',
                marketplaceName: 'tools',
                installed: true,
                enabled: false,
              },
            ],
            available: [],
          }),
        ),
    });

    const inspection = await client.inspect(context);
    expect(inspection.resources.map((entry) => entry.resolvedIdentity)).toEqual([
      'enabled@tools',
    ]);
    expect(inspection.observations?.[0]).toMatchObject({
      status: 'disabled',
      resource: { resolvedIdentity: 'disabled@tools' },
    });
  });

  test('registers a missing marketplace before installing its exact plugin', async () => {
    const context = await fixture();
    const calls: string[][] = [];
    const client = new CodexNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        if (args.join(' ') === 'plugin marketplace list --json') {
          return success('{"marketplaces":[]}');
        }
        if (args[2] === 'add' && args[1] === 'marketplace') {
          return success(
            '{"marketplaceName":"tools","installedRoot":"/cache/tools","alreadyAdded":false}',
          );
        }
        return success(
          '{"pluginId":"demo@tools","name":"demo","marketplaceName":"tools","version":"1.0.0","installedPath":"/cache/demo","authPolicy":"ON_USE"}',
        );
      },
    });
    const resource = client.resolveSource('demo@tools', context, {
      marketplaceName: 'tools',
      marketplaceSource: 'owner/tools',
      resolvedRef: 'main',
      marketplaceSparsePath: 'catalog',
      managedMarketplaceRegistration: 'true',
    }).resource;
    expect(resource).toBeDefined();

    expect(await client.install(resource!, context)).toEqual({
      success: true,
      registrations: ['tools'],
    });
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'list', '--json'],
      [
        'plugin',
        'marketplace',
        'add',
        'owner/tools',
        '--ref',
        'main',
        '--sparse',
        'catalog',
        '--json',
      ],
      ['plugin', 'add', 'demo@tools', '--json'],
    ]);
  });

  test('upgrades Git marketplaces and re-adds plugins during targeted update', async () => {
    const context = await fixture();
    const calls: string[][] = [];
    const client = new CodexNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        if (args.join(' ') === 'plugin marketplace list --json') {
          return success(
            '{"marketplaces":[{"name":"tools","root":"/cache/tools","marketplaceSource":{"sourceType":"git","source":"https://github.com/owner/tools.git"}}]}',
          );
        }
        if (args[2] === 'upgrade') {
          return success(
            '{"selectedMarketplaces":["tools"],"upgradedRoots":["/cache/tools"],"errors":[]}',
          );
        }
        return success(
          '{"pluginId":"demo@tools","name":"demo","marketplaceName":"tools","version":"1.0.1","installedPath":"/cache/demo","authPolicy":"ON_USE"}',
        );
      },
    });
    const resource = client.resolveSource('demo@tools', context, {
      marketplaceName: 'tools',
    }).resource!;

    expect(await client.update(resource, resource, context)).toEqual({
      success: true,
    });
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'marketplace', 'upgrade', 'tools', '--json'],
      ['plugin', 'add', 'demo@tools', '--json'],
    ]);
  });

  test('removes exact plugins but preserves marketplaces used by other plugins', async () => {
    const context = await fixture();
    const calls: string[][] = [];
    const client = new CodexNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        if (args[1] === 'remove' && args[2] === 'demo@tools') {
          return success(
            '{"pluginId":"demo@tools","name":"demo","marketplaceName":"tools"}',
          );
        }
        if (args.join(' ') === 'plugin marketplace list --json') {
          return success(
            '{"marketplaces":[{"name":"tools","root":"/tools","marketplaceSource":{"sourceType":"local","source":"/tools"}}]}',
          );
        }
        return success(
          '{"installed":[{"pluginId":"other@tools","name":"other","marketplaceName":"tools","installed":true,"enabled":true}],"available":[]}',
        );
      },
    });
    const resource = client.resolveSource('demo@tools', context).resource!;

    expect(await client.remove(resource, context)).toEqual({ success: true });
    expect(await client.removeMarketplaceRegistration('tools', context)).toEqual(
      {
        success: false,
        error: "Codex marketplace 'tools' is still used by installed plugins",
      },
    );
    expect(calls.at(-1)).toEqual([
      'plugin',
      'list',
      '--marketplace',
      'tools',
      '--json',
    ]);
  });
});
