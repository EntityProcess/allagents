import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OmpNativeClient,
  inspectOmpMarketplaceRegistry,
} from '../../../../src/core/native/omp.js';
import type {
  NativeCommandOptions,
  NativeCommandResult,
  NativeOperationContext,
  NativeResource,
} from '../../../../src/core/native/types.js';

const temporaryDirectories: string[] = [];
const timestamp = '2026-09-14T00:00:00.000Z';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface OmpFixture {
  home: string;
  dataRoot: string;
  agentRoot: string;
  workspace: string;
}

interface MarketplaceSummary {
  id: string;
  scope: 'user' | 'project';
  entries: Array<{
    scope: 'user' | 'project';
    installPath: string;
    version: string;
    installedAt: string;
    lastUpdated: string;
    enabled?: boolean;
  }>;
  shadowedBy?: 'project';
}

function fixture(): OmpFixture {
  const home = mkdtempSync(join(tmpdir(), 'allagents-omp-'));
  temporaryDirectories.push(home);
  const dataRoot = join(home, 'xdg-data', 'omp');
  const agentRoot = join(home, '.omp', 'agent');
  const workspace = join(home, 'workspace');
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(agentRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { home, dataRoot, agentRoot, workspace };
}

function context(
  scope: 'user' | 'project',
  paths: OmpFixture,
): NativeOperationContext {
  return {
    client: 'omp',
    scope,
    nativeScope: scope,
    root: scope === 'user' ? paths.agentRoot : paths.workspace,
    cwd: paths.workspace,
    env: {
      HOME: paths.home,
      OMP_PROFILE: 'ambient-profile',
      PI_PROFILE: 'legacy-profile',
      PI_CONFIG_FILES: '/tmp/overlay.yml',
      SENTINEL: 'preserved',
    },
    roots: {
      config: join(paths.home, '.omp'),
      agent: paths.agentRoot,
      data: paths.dataRoot,
      state: join(paths.home, '.omp'),
      cache: join(paths.home, '.omp'),
      dataAgent: paths.dataRoot,
      stateAgent: paths.agentRoot,
      cacheAgent: paths.agentRoot,
    },
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeMarketplace(
  paths: OmpFixture,
  options: {
    name?: string;
    sourceUri?: string;
    plugin?: string;
    catalogName?: string;
    version?: number;
  } = {},
): void {
  const name = options.name ?? 'tools';
  const catalogPath = join(paths.dataRoot, 'plugins', 'cache', 'marketplaces', name, 'marketplace.json');
  writeJson(catalogPath, {
    name: options.catalogName ?? name,
    owner: { name: 'Example' },
    plugins: [
      {
        name: options.plugin ?? 'reviewer',
        source: './plugin',
        version: '2.0.0',
      },
    ],
  });
  writeJson(join(paths.dataRoot, 'marketplaces.json'), {
    version: options.version ?? 1,
    marketplaces: [
      {
        name,
        sourceType: 'github',
        sourceUri: options.sourceUri ?? 'acme/tools',
        catalogPath,
        addedAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
}

function summary(
  paths: OmpFixture,
  scope: 'user' | 'project',
  options: { id?: string; enabled?: boolean; shadowed?: boolean } = {},
): MarketplaceSummary {
  const id = options.id ?? 'reviewer@tools';
  return {
    id,
    scope,
    entries: [
      {
        scope,
        installPath: join(paths.dataRoot, 'plugins', `${scope}-${id.replace('@', '-')}`),
        version: '1.0.0',
        installedAt: timestamp,
        lastUpdated: timestamp,
        ...(options.enabled === false && { enabled: false }),
      },
    ],
    ...(options.shadowed && { shadowedBy: 'project' }),
  };
}

function inventory(marketplace: unknown[]): string {
  return JSON.stringify({ npm: [], marketplace });
}

function pluginResource(
  client: OmpNativeClient,
  operationContext: NativeOperationContext,
  source = 'reviewer@tools',
  marketplaceSource?: string,
): NativeResource {
  const resolved = client.resolveSource(
    source,
    operationContext,
    marketplaceSource ? { marketplaceSource } : {},
  );
  expect(resolved.success).toBe(true);
  expect(resolved.resource).toBeDefined();
  return resolved.resource!;
}

describe('native/omp version and context', () => {
  test('accepts 18.1.17 and newer while rejecting old or malformed versions', async () => {
    const paths = fixture();
    const operationContext = context('user', paths);
    const versionClient = (output: string) => new OmpNativeClient({
      execute: async () => ({ success: true, output }),
    });

    expect(await versionClient('omp/18.1.17').isAvailable(operationContext)).toBe(true);
    expect(await versionClient('18.1.20').isAvailable(operationContext)).toBe(true);
    expect(await versionClient('omp/19.0.0').isAvailable(operationContext)).toBe(true);
    expect(await versionClient('omp/18.1.16').isAvailable(operationContext)).toBe(false);
    expect(await versionClient('omp version 18.1.20').isAvailable(operationContext)).toBe(false);
    expect(
      await new OmpNativeClient({
        execute: async () => ({ success: false, output: '', exitCode: 127 }),
      }).isAvailable(operationContext),
    ).toBe(false);
  });

  test('fails a direct mutation at version inspection before inventory or marketplace access', async () => {
    const paths = fixture();
    const operationContext = context('user', paths);
    const calls: string[][] = [];
    let fileReads = 0;
    const client = new OmpNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        return { success: true, output: 'omp/18.1.16' };
      },
      readFile: async () => {
        fileReads++;
        return '{}';
      },
    });
    const resource = pluginResource(
      client,
      operationContext,
      'reviewer@tools',
      'acme/tools',
    );

    const result = await client.install(resource, operationContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('18.1.17 or newer');
    expect(calls).toEqual([['--version']]);
    expect(fileReads).toBe(0);
  });

  test('uses the resolved data root and removes ambient profile/config selectors', async () => {
    const paths = fixture();
    const operationContext = context('user', paths);
    const calls: Array<{ args: string[]; options?: NativeCommandOptions }> = [];
    const readPaths: string[] = [];
    const client = new OmpNativeClient({
      execute: async (_binary, args, options) => {
        calls.push({ args, ...(options && { options }) });
        return args[0] === '--version'
          ? { success: true, output: 'omp/18.1.20' }
          : { success: true, output: inventory([]) };
      },
      readFile: async (path) => {
        readPaths.push(path);
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });

    const result = await client.inspect(operationContext);

    expect(result.success).toBe(true);
    expect(readPaths).toEqual([join(paths.dataRoot, 'marketplaces.json')]);
    expect(calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['plugin', 'list', '--json'],
    ]);
    for (const call of calls) {
      expect(call.options?.cwd).toBe(paths.workspace);
      expect(call.options?.env?.SENTINEL).toBe('preserved');
      expect(call.options?.env?.OMP_PROFILE).toBeUndefined();
      expect(call.options?.env?.PI_PROFILE).toBeUndefined();
      expect(call.options?.env?.PI_CONFIG_FILES).toBeUndefined();
    }
    expect(calls.some((call) => call.args.includes('--profile'))).toBe(false);
  });
});

describe('native/omp authoritative marketplace inspection', () => {
  test('correlates the versioned registry, catalog, and scoped JSON inventory', async () => {
    const paths = fixture();
    writeMarketplace(paths);
    const marketplace = [
      summary(paths, 'project'),
      summary(paths, 'user', { shadowed: true }),
    ];
    const client = new OmpNativeClient({
      execute: async (_binary, args) => args[0] === '--version'
        ? { success: true, output: 'omp/18.1.20' }
        : { success: true, output: inventory(marketplace) },
    });

    const user = await client.inspect(context('user', paths));
    const project = await client.inspect(context('project', paths));

    expect(user.success).toBe(true);
    expect(user.resources.map((resource) => resource.resolvedIdentity)).toEqual([
      'reviewer@tools',
    ]);
    expect(user.resources[0]?.provenance).toMatchObject({
      marketplaceSource: 'acme/tools',
      installedVersion: '1.0.0',
      catalogVersion: '2.0.0',
      shadowedBy: 'project',
    });
    expect(project.success).toBe(true);
    expect(project.resources).toHaveLength(1);
  });

  test('reports a disabled plugin without crediting it as installed', async () => {
    const paths = fixture();
    writeMarketplace(paths);
    const client = new OmpNativeClient({
      execute: async (_binary, args) => args[0] === '--version'
        ? { success: true, output: 'omp/18.1.20' }
        : {
            success: true,
            output: inventory([summary(paths, 'user', { enabled: false })]),
          },
    });

    const result = await client.inspect(context('user', paths));

    expect(result.success).toBe(true);
    expect(result.resources).toEqual([]);
    expect(result.observations?.[0]?.status).toBe('disabled');
  });

  test('rejects missing catalogs, wrong registry versions, and conflicting identities', async () => {
    const paths = fixture();
    const operationContext = context('user', paths);
    writeMarketplace(paths, { version: 2 });
    let result = await inspectOmpMarketplaceRegistry(operationContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('unsupported or malformed version');

    writeMarketplace(paths);
    const registryPath = join(paths.dataRoot, 'marketplaces.json');
    const firstCatalog = join(paths.dataRoot, 'plugins', 'cache', 'marketplaces', 'tools', 'marketplace.json');
    writeJson(registryPath, {
      version: 1,
      marketplaces: [
        {
          name: 'tools',
          sourceType: 'github',
          sourceUri: 'acme/tools',
          catalogPath: firstCatalog,
          addedAt: timestamp,
          updatedAt: timestamp,
        },
        {
          name: 'other-tools',
          sourceType: 'github',
          sourceUri: 'https://github.com/ACME/tools.git',
          catalogPath: join(paths.dataRoot, 'other-catalog.json'),
          addedAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });
    result = await inspectOmpMarketplaceRegistry(operationContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('ambiguous identity');

    writeMarketplace(paths, { catalogName: 'renamed-tools' });
    result = await inspectOmpMarketplaceRegistry(operationContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('conflicts with catalog name');

    rmSync(firstCatalog, { force: true });
    result = await inspectOmpMarketplaceRegistry(operationContext);
    expect(result.success).toBe(false);
    expect(result.error).toContain('catalog is missing');
  });

  test('rejects malformed, ambiguous, and uncorroborated plugin inventories', async () => {
    const paths = fixture();
    writeMarketplace(paths);
    const valid = summary(paths, 'user');
    const malformedOutputs = [
      '',
      '{not-json',
      JSON.stringify({ marketplace: [] }),
      inventory([{ ...valid, entries: [] }]),
      inventory([{ ...valid, entries: [{ ...valid.entries[0], scope: 'project' }] }]),
      inventory([{ ...valid, shadowedBy: 'project' }]),
      inventory([valid, valid]),
    ];

    for (const output of malformedOutputs) {
      const client = new OmpNativeClient({
        execute: async (_binary, args) => args[0] === '--version'
          ? { success: true, output: 'omp/18.1.20' }
          : { success: true, output },
      });
      const result = await client.inspect(context('user', paths));
      expect(result.success).toBe(false);
      expect(result.resources).toEqual([]);
    }
  });

  test('does not accept a nonzero inventory command even when stdout looks valid', async () => {
    const paths = fixture();
    let calls = 0;
    const client = new OmpNativeClient({
      execute: async (_binary, args): Promise<NativeCommandResult> => {
        calls++;
        return args[0] === '--version'
          ? { success: true, output: 'omp/18.1.20' }
          : { success: false, output: inventory([]), exitCode: 2 };
      },
    });

    const result = await client.inspect(context('user', paths));

    expect(result.success).toBe(false);
    expect(result.error).toContain('exited with code 2');
    expect(calls).toBe(2);
  });
});

describe('native/omp ordered command effects', () => {
  test('registers an absent marketplace before an explicit-scope install and verifies it', async () => {
    const paths = fixture();
    const operationContext = context('user', paths);
    const calls: Array<{ args: string[]; options?: NativeCommandOptions }> = [];
    const marketplace: MarketplaceSummary[] = [];
    const client = new OmpNativeClient({
      execute: async (_binary, args, options) => {
        calls.push({ args, ...(options && { options }) });
        if (args[0] === '--version') return { success: true, output: 'omp/18.1.20' };
        if (args[0] === 'plugin' && args[1] === 'list') {
          return { success: true, output: inventory(marketplace) };
        }
        if (args[0] === 'plugin' && args[1] === 'marketplace') {
          writeMarketplace(paths);
          return { success: true, output: 'added' };
        }
        if (args[0] === 'plugin' && args[1] === 'install') {
          marketplace.push(summary(paths, 'user'));
          return { success: true, output: 'installed' };
        }
        return { success: false, output: '', exitCode: 1 };
      },
    });
    const resource = pluginResource(client, operationContext, 'reviewer@tools', 'acme/tools');

    const result = await client.install(resource, operationContext);

    expect(result).toEqual({ success: true, registrations: ['acme/tools'] });
    expect(calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['plugin', 'list', '--json'],
      ['plugin', 'marketplace', 'add', 'acme/tools'],
      ['plugin', 'install', '--scope', 'user', 'reviewer@tools'],
      ['plugin', 'list', '--json'],
    ]);
  });

  test('stops on registration failure and retains a confirmed registration when install fails', async () => {
    const failedPaths = fixture();
    const failedContext = context('user', failedPaths);
    const failedCalls: string[][] = [];
    const registrationFailure = new OmpNativeClient({
      execute: async (_binary, args) => {
        failedCalls.push(args);
        if (args[0] === '--version') return { success: true, output: 'omp/18.1.20' };
        if (args[1] === 'list') return { success: true, output: inventory([]) };
        return { success: false, output: '', error: 'network unavailable' };
      },
    });
    const failedResource = pluginResource(
      registrationFailure,
      failedContext,
      'reviewer@tools',
      'acme/tools',
    );

    const registrationResult = await registrationFailure.install(
      failedResource,
      failedContext,
    );

    expect(registrationResult.success).toBe(false);
    expect(failedCalls.some((args) => args[1] === 'install')).toBe(false);

    const installedPaths = fixture();
    const installedContext = context('user', installedPaths);
    const installCalls: string[][] = [];
    const installFailure = new OmpNativeClient({
      execute: async (_binary, args) => {
        installCalls.push(args);
        if (args[0] === '--version') return { success: true, output: 'omp/18.1.20' };
        if (args[1] === 'list') return { success: true, output: inventory([]) };
        if (args[1] === 'marketplace') {
          writeMarketplace(installedPaths);
          return { success: true, output: 'added' };
        }
        return { success: false, output: '', error: 'plugin install failed' };
      },
    });
    const installResource = pluginResource(
      installFailure,
      installedContext,
      'reviewer@tools',
      'acme/tools',
    );

    const installResult = await installFailure.install(
      installResource,
      installedContext,
    );

    expect(installResult.success).toBe(false);
    expect(installResult.registrations).toEqual(['acme/tools']);
    expect(installCalls.map((args) => args[1])).toEqual([
      undefined,
      'list',
      'marketplace',
      'install',
    ]);
  });

  test('treats exit-zero install without the exact post-state as a failure', async () => {
    const paths = fixture();
    writeMarketplace(paths);
    const operationContext = context('user', paths);
    const calls: string[][] = [];
    const client = new OmpNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        if (args[0] === '--version') {
          return { success: true, output: 'omp/18.1.20' };
        }
        if (args[1] === 'list') {
          return { success: true, output: inventory([]) };
        }
        return { success: true, output: 'installed' };
      },
    });
    const resource = pluginResource(
      client,
      operationContext,
      'reviewer@tools',
      'acme/tools',
    );

    const result = await client.install(resource, operationContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('absent from user inventory');
    expect(calls.filter((args) => args[1] === 'list')).toHaveLength(2);
  });

  test('skips an exact existing registration/plugin and rejects a source conflict without mutation', async () => {
    const paths = fixture();
    writeMarketplace(paths);
    const operationContext = context('user', paths);
    const calls: string[][] = [];
    const marketplace = [summary(paths, 'user')];
    const client = new OmpNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        return args[0] === '--version'
          ? { success: true, output: 'omp/18.1.20' }
          : { success: true, output: inventory(marketplace) };
      },
    });
    const existing = pluginResource(client, operationContext, 'reviewer@tools', 'acme/tools');

    expect(await client.install(existing, operationContext)).toEqual({ success: true });
    expect(calls.some((args) => args[1] === 'install')).toBe(false);

    marketplace.splice(0);
    const conflicting = pluginResource(
      client,
      operationContext,
      'reviewer@tools',
      'different/tools',
    );
    const conflictResult = await client.install(conflicting, operationContext);
    expect(conflictResult.success).toBe(false);
    expect(conflictResult.error).toContain('conflicting source');
    expect(calls.some((args) => args[1] === 'marketplace')).toBe(false);
  });

  test('uses targeted explicit-scope upgrade/uninstall and preserves the other scope', async () => {
    const paths = fixture();
    writeMarketplace(paths);
    const userContext = context('user', paths);
    const projectContext = context('project', paths);
    const marketplace = [
      summary(paths, 'project'),
      summary(paths, 'user', { shadowed: true }),
    ];
    const calls: string[][] = [];
    const client = new OmpNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        if (args[0] === '--version') return { success: true, output: 'omp/18.1.20' };
        if (args[1] === 'list') return { success: true, output: inventory(marketplace) };
        if (args[1] === 'uninstall') {
          marketplace.splice(
            marketplace.findIndex((entry) => entry.scope === args[3]),
            1,
          );
          const user = marketplace.find((entry) => entry.scope === 'user');
          if (user) delete user.shadowedBy;
        }
        return { success: true, output: 'ok' };
      },
    });
    const userResource = pluginResource(client, userContext);
    const projectResource = pluginResource(client, projectContext);

    expect((await client.update(userResource, userResource, userContext)).success).toBe(true);
    expect((await client.remove(projectResource, projectContext)).success).toBe(true);

    expect(calls).toContainEqual([
      'plugin',
      'upgrade',
      '--scope',
      'user',
      'reviewer@tools',
    ]);
    expect(calls).toContainEqual([
      'plugin',
      'uninstall',
      '--scope',
      'project',
      'reviewer@tools',
    ]);
    expect(calls).not.toContainEqual(['plugin', 'upgrade', 'reviewer@tools']);
    expect(calls.some((args) => args[1] === 'marketplace' && args[2] === 'remove')).toBe(false);

    const remaining = await client.inspect(userContext);
    expect(remaining.resources.map((resource) => resource.resolvedIdentity)).toEqual([
      'reviewer@tools',
    ]);
  });
});
