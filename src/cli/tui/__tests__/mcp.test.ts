import { describe, expect, it } from 'bun:test';
import type {
  AddManagedMcpServerRequest,
  McpDestinationSync,
} from '../../../core/mcp-management.js';
import type { McpDestination } from '../../../core/mcp-servers.js';
import type {
  McpServerConfig,
  UserWorkspaceConfig,
} from '../../../models/workspace-config.js';
import {
  type McpManagementApi,
  type McpTuiDependencies,
  type McpTuiPrompts,
  runMcpServers,
} from '../actions/mcp.js';
import type { TuiCache } from '../cache.js';
import type { TuiContext } from '../context.js';

const CANCEL = Symbol('cancel');

interface SelectRequest {
  message: string;
  options: Array<{ label: string; value: string; hint?: string }>;
}

class ScriptedPrompts implements McpTuiPrompts {
  readonly selectRequests: SelectRequest[] = [];
  readonly notes: Array<{ message: string; title?: string }> = [];
  readonly passwordRequests: Array<{ message: string; signal: AbortSignal }> =
    [];
  readonly selects: Array<string | symbol>;
  readonly texts: Array<string | symbol>;
  readonly multiselects: Array<string[] | symbol>;
  readonly confirms: Array<boolean | symbol>;

  constructor(script: {
    selects: Array<string | symbol>;
    texts?: Array<string | symbol>;
    multiselects?: Array<string[] | symbol>;
    confirms?: Array<boolean | symbol>;
  }) {
    this.selects = [...script.selects];
    this.texts = [...(script.texts ?? [])];
    this.multiselects = [...(script.multiselects ?? [])];
    this.confirms = [...(script.confirms ?? [])];
  }

  async select<T extends string>(request: {
    message: string;
    options: Array<{ label: string; value: T; hint?: string }>;
  }): Promise<T | symbol> {
    this.selectRequests.push(request as SelectRequest);
    const value = this.selects.shift();
    if (value === undefined) {
      throw new Error(`Missing select response for ${request.message}`);
    }
    return value as T | symbol;
  }

  async text(): Promise<string | symbol> {
    const value = this.texts.shift();
    if (value === undefined) throw new Error('Missing text response');
    return value;
  }

  async password(request: {
    message: string;
    signal: AbortSignal;
  }): Promise<string | symbol> {
    this.passwordRequests.push(request);
    return this.text();
  }

  async multiselect<T extends string>(): Promise<T[] | symbol> {
    const value = this.multiselects.shift();
    if (value === undefined) throw new Error('Missing multiselect response');
    return value as T[] | symbol;
  }

  async confirm(): Promise<boolean | symbol> {
    const value = this.confirms.shift();
    if (value === undefined) throw new Error('Missing confirm response');
    return value;
  }

  isCancel(value: unknown): value is symbol {
    return value === CANCEL;
  }

  note(message: string, title?: string): void {
    this.notes.push({ message, ...(title && { title }) });
  }
}

function context(hasWorkspace = true): TuiContext {
  return {
    hasWorkspace,
    workspacePath: hasWorkspace ? '/workspace' : null,
    projectPluginCount: 0,
    userPluginCount: 0,
    needsSync: false,
    hasUserConfig: true,
    marketplaceCount: 0,
  };
}

function destination(options: {
  cwd?: string;
  scope?: string;
  profile?: string;
}): McpDestination {
  if (options.profile) {
    return {
      kind: 'profile',
      name: options.profile,
      configPath: '/home/user/.allagents/workspace.yaml',
    };
  }
  if (options.scope === 'project') {
    return {
      kind: 'project',
      workspacePath: options.cwd ?? '/workspace',
      configPath: `${options.cwd ?? '/workspace'}/.allagents/workspace.yaml`,
    };
  }
  return {
    kind: 'user',
    configPath: '/home/user/.allagents/workspace.yaml',
  };
}

const completedSync: McpDestinationSync = { kind: 'profile', result: null };

function dependencies(options: {
  prompts: ScriptedPrompts;
  servers?: Record<string, McpServerConfig>;
  userConfig?: UserWorkspaceConfig | null;
  onAdd?: (request: AddManagedMcpServerRequest) => Promise<void> | void;
  onReauthenticate?: (destination: McpDestination, name: string) => void;
  onRemove?: (destination: McpDestination, name: string) => void;
  onUpdate?: (destination: McpDestination) => void;
}): McpTuiDependencies {
  const management: McpManagementApi = {
    async addManagedMcpServer(request) {
      await options.onAdd?.(request);
      return { config: request.config, sync: completedSync };
    },
    async listManagedMcpServers() {
      return options.servers ?? {};
    },
    async reauthenticateManagedMcpServer(selected, name) {
      options.onReauthenticate?.(selected, name);
    },
    async removeManagedMcpServer(selected, name) {
      options.onRemove?.(selected, name);
      return completedSync;
    },
    async updateManagedMcpServers(selected) {
      options.onUpdate?.(selected);
      return completedSync;
    },
  };
  return {
    prompts: options.prompts,
    management,
    getUserConfig: async () => options.userConfig ?? null,
    resolveDestination: destination,
  };
}

function cacheCounter(): { cache: TuiCache; count: () => number } {
  let invalidations = 0;
  return {
    cache: {
      invalidate() {
        invalidations += 1;
      },
    } as unknown as TuiCache,
    count: () => invalidations,
  };
}

describe('runMcpServers', () => {
  it('selects a declared profile and adds an HTTP server through management', async () => {
    const callbackUrl =
      'http://127.0.0.1:3117/callback?code=complete&state=state';
    const callbackSignal = new AbortController().signal;
    const prompts = new ScriptedPrompts({
      selects: ['profile:work', '__add__', 'http', '__back__'],
      texts: [
        'remote',
        'https://mcp.example.test/path',
        `Authorization=\${MCP_TOKEN}`,
        '',
        callbackUrl,
      ],
      multiselects: [['claude']],
      confirms: [true],
    });
    let added: AddManagedMcpServerRequest | undefined;
    let pastedCallback: string | undefined;
    const { cache, count } = cacheCounter();
    const userConfig = {
      repositories: [],
      plugins: [],
      clients: [],
      profiles: {
        work: {
          clients: [{ name: 'claude', install: 'file', settings: {} }],
          plugins: [],
        },
      },
    } as UserWorkspaceConfig;

    await runMcpServers(
      context(),
      cache,
      dependencies({
        prompts,
        userConfig,
        async onAdd(request) {
          added = request;
          request.authorization?.output(
            'Open the browser to authorize this server.',
          );
          pastedCallback = await request.authorization?.readCallback({
            authorizationUrl: new URL('https://login.example.test/authorize'),
            redirectUrl: 'http://127.0.0.1:3117/callback',
            state: 'state',
            signal: callbackSignal,
          });
        },
      }),
    );

    expect(added?.destination).toMatchObject({ kind: 'profile', name: 'work' });
    expect(added?.config).toEqual({
      type: 'http',
      url: 'https://mcp.example.test/path',
      headers: { Authorization: `\${MCP_TOKEN}` },
      clients: ['claude'],
    });
    expect(pastedCallback).toBe(callbackUrl);
    expect(prompts.passwordRequests).toEqual([
      {
        message: 'Paste the OAuth callback URL',
        signal: callbackSignal,
      },
    ]);
    expect(prompts.notes).toContainEqual({
      message: 'Open the browser to authorize this server.',
      title: 'Authorization',
    });
    expect(count()).toBe(1);
    expect(
      prompts.selectRequests[0]?.options.map((option) => option.value),
    ).toEqual(['project', 'user', 'profile:work', '__back__']);
  });

  it('offers reauthentication only for HTTP servers and calls management for HTTP', async () => {
    const prompts = new ScriptedPrompts({
      selects: [
        'user',
        'server:local',
        'back',
        'server:remote',
        'reauthenticate',
        'back',
        '__back__',
      ],
    });
    const reauthenticated: Array<{
      destination: McpDestination;
      name: string;
    }> = [];
    const { cache, count } = cacheCounter();

    await runMcpServers(
      context(false),
      cache,
      dependencies({
        prompts,
        servers: {
          local: { type: 'stdio', command: 'npx', args: ['secret-token'] },
          remote: { type: 'http', url: 'https://example.test/mcp' },
        },
        onReauthenticate(selected, name) {
          reauthenticated.push({ destination: selected, name });
        },
      }),
    );

    const localActions = prompts.selectRequests.find(
      (request) => request.message === 'MCP server: local',
    );
    const remoteActions = prompts.selectRequests.find(
      (request) => request.message === 'MCP server: remote',
    );
    expect(localActions?.options.map((option) => option.value)).not.toContain(
      'reauthenticate',
    );
    expect(remoteActions?.options.map((option) => option.value)).toContain(
      'reauthenticate',
    );
    expect(reauthenticated).toEqual([
      {
        destination: expect.objectContaining({ kind: 'user' }),
        name: 'remote',
      },
    ]);
    expect(count()).toBe(1);
  });

  it('confirms removal, updates through management, and invalidates after each mutation', async () => {
    const prompts = new ScriptedPrompts({
      selects: ['project', 'server:local', 'remove', '__update__', '__back__'],
      confirms: [true],
    });
    const removals: string[] = [];
    const updates: McpDestination[] = [];
    const { cache, count } = cacheCounter();

    await runMcpServers(
      context(),
      cache,
      dependencies({
        prompts,
        servers: { local: { type: 'stdio', command: 'node' } },
        onRemove(selected, name) {
          expect(selected.kind).toBe('project');
          removals.push(name);
        },
        onUpdate(selected) {
          updates.push(selected);
        },
      }),
    );

    expect(removals).toEqual(['local']);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.kind).toBe('project');
    expect(count()).toBe(2);
  });

  it('does not mutate when add or removal prompts are cancelled', async () => {
    let addCalls = 0;
    const addPrompts = new ScriptedPrompts({
      selects: ['user', '__add__', '__back__'],
      texts: [CANCEL],
    });
    await runMcpServers(
      context(false),
      undefined,
      dependencies({
        prompts: addPrompts,
        onAdd() {
          addCalls += 1;
        },
      }),
    );

    let removeCalls = 0;
    const removePrompts = new ScriptedPrompts({
      selects: ['user', 'server:local', 'remove', 'back', '__back__'],
      confirms: [false],
    });
    await runMcpServers(
      context(false),
      undefined,
      dependencies({
        prompts: removePrompts,
        servers: { local: { type: 'stdio', command: 'node' } },
        onRemove() {
          removeCalls += 1;
        },
      }),
    );

    expect(addCalls).toBe(0);
    expect(removeCalls).toBe(0);
  });

  it('shows safe metadata without header, environment, argument, or URL credential values', async () => {
    const prompts = new ScriptedPrompts({
      selects: [
        'user',
        'server:secure-http',
        'back',
        'server:secure-stdio',
        'back',
        '__back__',
      ],
    });
    await runMcpServers(
      context(false),
      undefined,
      dependencies({
        prompts,
        servers: {
          'secure-http': {
            type: 'http',
            url: 'https://user:password@example.test/private?token=url-secret',
            headers: { Authorization: 'header-secret' },
          },
          'secure-stdio': {
            type: 'stdio',
            command: '/private/secret-command',
            args: ['--token', 'argument-secret'],
            env: { API_TOKEN: 'environment-secret' },
          },
        },
      }),
    );

    const rendered = prompts.notes.map((note) => note.message).join('\n');
    expect(rendered).toContain('Origin: https://example.test');
    expect(rendered).toContain('Headers: Authorization');
    expect(rendered).toContain('Arguments: 2 configured');
    expect(rendered).toContain('Environment: API_TOKEN');
    expect(rendered).not.toContain('password');
    expect(rendered).not.toContain('url-secret');
    expect(rendered).not.toContain('header-secret');
    expect(rendered).not.toContain('secret-command');
    expect(rendered).not.toContain('argument-secret');
    expect(rendered).not.toContain('environment-secret');
  });
});
