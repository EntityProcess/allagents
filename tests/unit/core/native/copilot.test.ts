import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CopilotNativeClient,
  parseCopilotPluginInventory,
} from '../../../../src/core/native/copilot.js';
import type {
  NativeCommandOptions,
  NativeCommandResult,
  NativeOperationContext,
} from '../../../../src/core/native/types.js';

const context: NativeOperationContext = {
  client: 'copilot',
  scope: 'user',
  nativeScope: 'profile:review',
  root: '/profiles/review/copilot/home',
  cwd: '/work/project',
  env: {
    COPILOT_HOME: '/profiles/review/copilot/home',
    COPILOT_CACHE_HOME: '/profiles/review/copilot/cache',
  },
  roots: { config: '/tmp' },
};

function success(output = ''): NativeCommandResult {
  return { success: true, output, exitCode: 0 };
}

describe('native/copilot', () => {
  describe('source resolution', () => {
    const client = new CopilotNativeClient();

    test('normalizes owner/repository registration sources to runtime marketplace identities', () => {
      expect(client.toPluginSpec('superpowers@obra/superpowers-marketplace')).toBe(
        'superpowers@superpowers-marketplace',
      );
      expect(
        client.resolveSource(
          'superpowers@obra/superpowers-marketplace',
          context,
        ).resource,
      ).toMatchObject({
        resolvedIdentity: 'superpowers@superpowers-marketplace',
        provenance: {
          marketplaceName: 'superpowers-marketplace',
          marketplaceSource: 'obra/superpowers-marketplace',
        },
      });
    });

    test('preserves plugin@marketplace format and rejects unsupported sources', () => {
      expect(client.toPluginSpec('superpowers@superpowers-marketplace')).toBe(
        'superpowers@superpowers-marketplace',
      );
      for (const source of [
        'vercel-labs/agent-browser/skills/agent-browser',
        '',
        'plugin@owner/',
      ]) {
        expect(client.toPluginSpec(source)).toBeNull();
      }
    });
  });

  test('parses the current text inventory without relying on unsupported JSON flags', () => {
    expect(parseCopilotPluginInventory('No plugins installed.\n')).toEqual([]);
    expect(
      parseCopilotPluginInventory(
        'Installed plugins:\n  • advanced-security@copilot-plugins (v1.0.0)\n',
      ),
    ).toEqual(['advanced-security@copilot-plugins']);
    expect(parseCopilotPluginInventory('unexpected output')).toBeNull();
  });

  test('enforces the profile runtime version floor', async () => {
    const supported = new CopilotNativeClient({
      minimumVersion: [1, 0, 74],
      execute: async () => success('GitHub Copilot CLI 1.0.83\n'),
    });
    const unsupported = new CopilotNativeClient({
      minimumVersion: [1, 0, 74],
      execute: async () => success('GitHub Copilot CLI 1.0.73\n'),
    });

    expect(await supported.isAvailable(context)).toBe(true);
    expect(await unsupported.isAvailable(context)).toBe(false);
  });

  test('isolates version side effects and treats a missing selected root as empty', async () => {
    const temporary = await mkdtemp(
      join(tmpdir(), 'allagents-copilot-native-test-'),
    );
    const selectedRoot = join(temporary, 'selected');
    const isolatedCaches: string[] = [];
    let calls = 0;
    try {
      const missingContext: NativeOperationContext = {
        ...context,
        root: join(selectedRoot, 'home'),
        roots: { config: selectedRoot },
        env: {
          COPILOT_HOME: join(selectedRoot, 'home'),
          COPILOT_CACHE_HOME: join(selectedRoot, 'cache'),
        },
      };
      const client = new CopilotNativeClient({
        minimumVersion: [1, 0, 74],
        execute: async (_binary, args, options) => {
          calls++;
          const cache = options?.env?.COPILOT_CACHE_HOME;
          if (cache) {
            isolatedCaches.push(cache);
            await mkdir(cache, { recursive: true });
          }
          expect(args).toEqual(['--version']);
          return success('GitHub Copilot CLI 1.0.83.\\n');
        },
      });

      expect(await client.isAvailable(missingContext)).toBe(true);
      expect(await client.inspect(missingContext)).toEqual({
        success: true,
        resources: [],
      });
      expect(calls).toBe(1);
      await expect(stat(selectedRoot)).rejects.toThrow();
      expect(isolatedCaches).toHaveLength(1);
      await expect(stat(isolatedCaches[0] as string)).rejects.toThrow();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  test('inspects selected-root plugins with exact marketplace identity', async () => {
    let observedOptions: NativeCommandOptions | undefined;
    const client = new CopilotNativeClient({
      execute: async (_binary, args, options) => {
        expect(args).toEqual(['plugin', 'list']);
        observedOptions = options;
        return success(
          'Installed plugins:\n  • advanced-security@copilot-plugins (v1.0.0)\n',
        );
      },
    });

    const inspection = await client.inspect(context);
    expect(observedOptions).toEqual({ cwd: context.cwd, env: context.env });
    expect(inspection.resources).toEqual([
      {
        kind: 'plugin',
        requestedIdentity: 'advanced-security@copilot-plugins',
        resolvedIdentity: 'advanced-security@copilot-plugins',
        context,
        provenance: { marketplaceName: 'copilot-plugins' },
      },
    ]);
  });

  test('registers a missing marketplace before installing and reports its owned name', async () => {
    const calls: string[][] = [];
    const client = new CopilotNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        if (args.join(' ') === 'plugin marketplace list') {
          return success(
            'Included with GitHub Copilot:\n  ◆ copilot-plugins (GitHub: github/copilot-plugins)\n\nRegistered marketplaces:\n',
          );
        }
        return success();
      },
    });
    const resource = client.resolveSource(
      'compound-engineering@compound-engineering-plugin',
      context,
      {
        marketplaceName: 'compound-engineering-plugin',
        marketplaceSource: 'EveryInc/compound-engineering-plugin',
        managedMarketplaceRegistration: 'true',
      },
    ).resource;
    if (!resource) throw new Error('expected native resource');

    expect(await client.install(resource, context)).toEqual({
      success: true,
      registrations: ['compound-engineering-plugin'],
    });
    expect(calls).toEqual([
      ['plugin', 'marketplace', 'list'],
      [
        'plugin',
        'marketplace',
        'add',
        'EveryInc/compound-engineering-plugin',
      ],
      [
        'plugin',
        'install',
        'compound-engineering@compound-engineering-plugin',
      ],
    ]);
  });

  test('preserves an existing marketplace and removes only an owned registration', async () => {
    const calls: string[][] = [];
    const client = new CopilotNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        return args.join(' ') === 'plugin marketplace list'
          ? success(
              'Included with GitHub Copilot:\n\nRegistered marketplaces:\n  • compound-engineering-plugin (GitHub: EveryInc/compound-engineering-plugin)\n',
            )
          : success();
      },
    });
    const resource = client.resolveSource(
      'compound-engineering@compound-engineering-plugin',
      context,
      {
        marketplaceName: 'compound-engineering-plugin',
        marketplaceSource: 'EveryInc/compound-engineering-plugin',
      },
    ).resource;
    if (!resource) throw new Error('expected native resource');

    expect(await client.install(resource, context)).toEqual({ success: true });
    expect(calls).not.toContainEqual([
      'plugin',
      'marketplace',
      'add',
      'EveryInc/compound-engineering-plugin',
    ]);
    expect(
      await client.removeMarketplaceRegistration(
        'compound-engineering-plugin',
        context,
      ),
    ).toEqual({ success: true });
    expect(calls.at(-1)).toEqual([
      'plugin',
      'marketplace',
      'remove',
      'compound-engineering-plugin',
    ]);
  });

  test('supports only user scope', () => {
    const client = new CopilotNativeClient();
    expect(client.supportsScope('user')).toBe(true);
    expect(client.supportsScope('project')).toBe(false);
  });
});
