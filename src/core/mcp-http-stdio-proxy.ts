import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type OAuthDiscoveryState,
  type OAuthClientProvider,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  FetchLike,
  Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { getHomeDir } from '../constants.js';
import {
  GetPromptRequestSchema as GetPromptSchema,
  ListPromptsRequestSchema as ListPromptsSchema,
  ListResourceTemplatesRequestSchema as ListResourceTemplatesSchema,
  ListResourcesRequestSchema as ListResourcesSchema,
  ListToolsRequestSchema as ListToolsSchema,
  ReadResourceRequestSchema as ReadResourceSchema,
  CallToolRequestSchema as CallToolSchema,
} from '@modelcontextprotocol/sdk/types.js';

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
export const AUTH_URL_LOG_PREFIX = 'If the browser does not open, visit: ';

export interface OAuthCallbackRequest {
  authorizationUrl: URL;
  redirectUrl: string;
  state: string;
  signal: AbortSignal;
}

export type OAuthCallbackUrlReader = (
  request: OAuthCallbackRequest,
) => Promise<string>;

type ParsedOAuthCallback =
  | { code: string; authorizationError?: never }
  | { code?: never; authorizationError: true };

export class OAuthAuthorizationError extends Error {
  constructor() {
    super('OAuth authorization failed');
    this.name = 'OAuthAuthorizationError';
  }
}

function parseOAuthCallbackResponse(
  callbackUrl: string,
  redirectUrl: string,
  expectedState: string,
): ParsedOAuthCallback {
  let callback: URL;
  try {
    callback = new URL(callbackUrl.trim());
  } catch {
    throw new Error('Invalid OAuth callback URL');
  }

  const expected = new URL(redirectUrl);
  if (
    callback.username ||
    callback.password ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.hash
  ) {
    throw new Error(
      'OAuth callback URL does not match the registered redirect',
    );
  }

  const states = callback.searchParams.getAll('state');
  if (states.length !== 1 || states[0] !== expectedState) {
    throw new Error('OAuth state validation failed');
  }

  const errors = callback.searchParams.getAll('error');
  const codes = callback.searchParams.getAll('code');
  if (errors.length === 1 && errors[0] && codes.length === 0) {
    return { authorizationError: true };
  }
  if (errors.length > 0) {
    throw new Error('Invalid OAuth authorization response');
  }
  if (codes.length !== 1 || !codes[0]) {
    throw new Error('No OAuth authorization code received');
  }
  return { code: codes[0] };
}

export function validateOAuthCallbackUrl(
  callbackUrl: string,
  redirectUrl: string,
  expectedState: string,
): void {
  parseOAuthCallbackResponse(callbackUrl, redirectUrl, expectedState);
}

export function parseOAuthCallbackUrl(
  callbackUrl: string,
  redirectUrl: string,
  expectedState: string,
): string {
  const callback = parseOAuthCallbackResponse(
    callbackUrl,
    redirectUrl,
    expectedState,
  );
  if (callback.authorizationError) {
    throw new OAuthAuthorizationError();
  }
  return callback.code;
}

export function hashServerUrl(serverUrl: string): string {
  return createHash('sha256').update(serverUrl).digest('hex').slice(0, 16);
}

function getCacheDir(serverUrl: string): string {
  return join(
    getHomeDir(),
    '.allagents',
    'oauth-proxy',
    hashServerUrl(serverUrl),
  );
}

function getMcpFetch(
  serverUrl: string,
  headers: Record<string, string>,
): FetchLike | undefined {
  if (Object.keys(headers).length === 0) {
    return undefined;
  }

  const serverOrigin = new URL(serverUrl).origin;
  return async (input, init) => {
    const requestUrl = new URL(input.toString());
    if (requestUrl.origin !== serverOrigin) {
      return fetch(input, init);
    }

    const mergedHeaders = new Headers(headers);
    new Headers(init?.headers).forEach((value, key) =>
      mergedHeaders.set(key, value),
    );

    return fetch(input, {
      ...init,
      headers: mergedHeaders,
      redirect: 'error',
    });
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: 'utf-8', mode: 0o600 });
}

function parseLoopbackPort(
  clientInfo?: OAuthClientInformationMixed,
): number | undefined {
  const redirectUri =
    clientInfo && 'redirect_uris' in clientInfo
      ? clientInfo.redirect_uris?.[0]
      : undefined;
  if (!redirectUri) {
    return undefined;
  }

  try {
    const parsed = new URL(redirectUri);
    if (
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      parsed.port
    ) {
      return Number(parsed.port);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error('Failed to determine a free loopback port'));
          return;
        }
        resolve(port);
      });
    });
  });
}

export function getBrowserOpenCommands(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Array<{ command: string; args: string[] }> {
  return platform === 'darwin'
    ? [{ command: 'open', args: [url] }]
    : platform === 'win32'
      ? [{ command: 'explorer.exe', args: [url] }]
      : [
          { command: 'xdg-open', args: [url] },
          { command: 'gio', args: ['open', url] },
        ];
}

function tryOpenBrowser(url: string): Promise<void> {
  const commands = getBrowserOpenCommands(url);

  return new Promise((resolve) => {
    const tryCommand = (index: number) => {
      if (index >= commands.length) {
        resolve();
        return;
      }

      const entry = commands[index];
      if (!entry) {
        resolve();
        return;
      }
      const { command, args } = entry;
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', () => {
        tryCommand(index + 1);
      });
    };

    tryCommand(0);
  });
}

class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly clientInfoPath: string;
  private readonly tokensPath: string;
  private readonly verifierPath: string;
  private readonly discoveryPath: string;
  private readonly redirectUriValue: string;
  private clientInfo: OAuthClientInformationMixed | undefined = undefined;
  private tokenSet: OAuthTokens | undefined = undefined;
  private discovery: OAuthDiscoveryState | undefined = undefined;
  private codeVerifierValue: string | undefined = undefined;
  private pendingAuth: Promise<string> | undefined = undefined;
  private authorizationUnavailable = false;
  private readonly stateValue = randomUUID();

  constructor(
    private readonly port: number,
    serverUrl: string,
    private readonly callbackUrlReader?: OAuthCallbackUrlReader,
    private readonly allowAuthorization = true,
  ) {
    const cacheDir = getCacheDir(serverUrl);
    this.clientInfoPath = join(cacheDir, 'client-info.json');
    this.tokensPath = join(cacheDir, 'tokens.json');
    this.verifierPath = join(cacheDir, 'code-verifier.txt');
    this.discoveryPath = join(cacheDir, 'discovery.json');
    this.redirectUriValue = `http://127.0.0.1:${port}/callback`;
  }

  get redirectUrl(): string {
    return this.redirectUriValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'AllAgents',
      redirect_uris: [this.redirectUriValue],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return this.stateValue;
  }

  async load(): Promise<void> {
    this.clientInfo = await readJsonFile<OAuthClientInformationMixed>(
      this.clientInfoPath,
    );
    this.tokenSet = await readJsonFile<OAuthTokens>(this.tokensPath);
    this.discovery = await readJsonFile<OAuthDiscoveryState>(
      this.discoveryPath,
    );
    if (await pathExists(this.verifierPath)) {
      this.codeVerifierValue = await readFile(this.verifierPath, 'utf-8');
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.clientInfo;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    this.clientInfo = clientInformation;
    await writePrivateFile(
      this.clientInfoPath,
      `${JSON.stringify(clientInformation, null, 2)}\n`,
    );
  }

  tokens(): OAuthTokens | undefined {
    return this.tokenSet;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.tokenSet = tokens;
    await writePrivateFile(
      this.tokensPath,
      `${JSON.stringify(tokens, null, 2)}\n`,
    );
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.allowAuthorization) {
      this.authorizationUnavailable = true;
      return;
    }
    this.pendingAuth ??= this.waitForAuthorizationCode(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier;
    await writePrivateFile(this.verifierPath, codeVerifier);
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error('No OAuth code verifier is available');
    }
    return this.codeVerifierValue;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.discovery = state;
    await writePrivateFile(
      this.discoveryPath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const removals =
      scope === 'all'
        ? [
            this.clientInfoPath,
            this.tokensPath,
            this.verifierPath,
            this.discoveryPath,
          ]
        : scope === 'client'
          ? [this.clientInfoPath]
          : scope === 'tokens'
            ? [this.tokensPath]
            : scope === 'verifier'
              ? [this.verifierPath]
              : [this.discoveryPath];

    await Promise.all(removals.map((path) => rm(path, { force: true })));
  }

  async waitForAuthCode(): Promise<string> {
    if (this.authorizationUnavailable) {
      throw new Error(
        'OAuth authorization requires an interactive terminal',
      );
    }
    if (!this.pendingAuth) {
      throw new Error('OAuth authorization has not been started');
    }
    return this.pendingAuth;
  }


  private waitForAuthorizationCode(authorizationUrl: URL): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const readerAbortController = new AbortController();
    let settled = false;
    const settle = (
      outcome: 'resolve' | 'reject',
      value: string | Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      readerAbortController.abort();
      if (server.listening) server.close();
      if (outcome === 'resolve') {
        resolve(value as string);
      } else {
        reject(value as Error);
      }
    };
    const acceptCallback = (callbackUrl: string): void => {
      try {
        settle(
          'resolve',
          parseOAuthCallbackUrl(
            callbackUrl,
            this.redirectUriValue,
            this.stateValue,
          ),
        );
      } catch (error) {
        settle(
          'reject',
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    };
    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        try {
          const callbackUrl = new URL(
            request.url ?? '/',
            this.redirectUriValue,
          ).toString();
          const code = parseOAuthCallbackUrl(
            callbackUrl,
            this.redirectUriValue,
            this.stateValue,
          );
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
          });
          response.end(
            '<html><body><h1>Authorization complete</h1><p>You can close this window.</p></body></html>',
          );
          settle('resolve', code);
        } catch (error) {
          response.writeHead(400, {
            'content-type': 'text/html; charset=utf-8',
          });
          response.end(
            '<html><body><h1>Authorization failed</h1><p>The OAuth response was rejected.</p></body></html>',
          );
          settle(
            'reject',
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
    );
    const timeout = setTimeout(() => {
      settle(
        'reject',
        new Error('Timed out waiting for OAuth authorization callback'),
      );
    }, AUTH_TIMEOUT_MS);
    server.on('error', (error) => settle('reject', error));
    server.listen(this.port, '127.0.0.1', () => {
      console.error('Opening browser for authorization...');
      console.error(`${AUTH_URL_LOG_PREFIX}${authorizationUrl.toString()}`);
      console.error(
        this.callbackUrlReader
          ? 'Using a remote browser? Paste its callback URL in this terminal.'
          : 'Using a remote browser? Run `allagents mcp reauth <name>` in this workspace, then reconnect.',
      );
      // Test-only escape hatch: e2e tests fetch the URL themselves against a local
      // dummy IdP, and skipping the real OS browser-open avoids ever launching one.
      if (process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER === '1') {
        console.error(
          'Skipping automatic browser open (ALLAGENTS_MCP_OAUTH_NO_BROWSER=1).',
        );
      } else {
        void tryOpenBrowser(authorizationUrl.toString());
      }
      if (this.callbackUrlReader) {
        void this.callbackUrlReader({
          authorizationUrl,
          redirectUrl: this.redirectUriValue,
          state: this.stateValue,
          signal: readerAbortController.signal,
        })
          .then(acceptCallback)
          .catch((error) => {
            if (readerAbortController.signal.aborted) return;
            settle(
              'reject',
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      }
    });
    return promise;
  }
}

async function buildOAuthProvider(
  serverUrl: string,
  callbackUrlReader: OAuthCallbackUrlReader | undefined,
  allowAuthorization: boolean,
): Promise<FileOAuthClientProvider> {
  const cacheDir = getCacheDir(serverUrl);
  const cachedClientInfo = await readJsonFile<OAuthClientInformationMixed>(
    join(cacheDir, 'client-info.json'),
  );

  let port = parseLoopbackPort(cachedClientInfo);
  if (!port) {
    port = await findFreePort();
  }

  const provider = new FileOAuthClientProvider(
    port,
    serverUrl,
    callbackUrlReader,
    allowAuthorization,
  );
  await provider.load();
  return provider;
}

function parseCallToolResponse(
  result: Awaited<ReturnType<Client['callTool']>>,
) {
  return {
    content: result.content,
    ...(result.structuredContent !== undefined && {
      structuredContent: result.structuredContent,
    }),
    ...(result.isError !== undefined && { isError: result.isError }),
    ...(result._meta !== undefined && { _meta: result._meta }),
  };
}

interface RemoteConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

async function connectRemoteTransport(
  serverUrl: string,
  headers: Record<string, string>,
  callbackUrlReader?: OAuthCallbackUrlReader,
  allowAuthorization = true,
): Promise<RemoteConnection> {
  const provider = await buildOAuthProvider(
    serverUrl,
    callbackUrlReader,
    allowAuthorization,
  );
  const client = new Client(
    {
      name: 'AllAgents',
      version: '1.0.0',
    },
    { capabilities: {} },
  );

  const buildTransport = () => {
    const mcpFetch = getMcpFetch(serverUrl, headers);
    return new StreamableHTTPClientTransport(new URL(serverUrl), {
      authProvider: provider,
      ...(mcpFetch && { fetch: mcpFetch }),
    });
  };

  let transport = buildTransport();
  try {
    await client.connect(transport as unknown as Transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      throw error;
    }
    const authorizationCode = await provider.waitForAuthCode();
    await transport.finishAuth(authorizationCode);
    await transport.close();
    transport = buildTransport();
    await client.connect(transport as unknown as Transport);
  }

  return { client, transport };
}

export interface ConnectHttpMcpServerOptions {
  headers?: Record<string, string>;
  callbackUrlReader?: OAuthCallbackUrlReader;
  resetCredentials?: boolean;
  allowAuthorization?: boolean;
}

export async function connectHttpMcpServer(
  serverUrl: string,
  options: ConnectHttpMcpServerOptions = {},
): Promise<void> {
  if (options.resetCredentials) {
    await rm(getCacheDir(serverUrl), { recursive: true, force: true });
  }
  const { client, transport } = await connectRemoteTransport(
    serverUrl,
    options.headers ?? {},
    options.callbackUrlReader,
    options.allowAuthorization ?? true,
  );
  try {
    await transport.terminateSession();
  } finally {
    await client.close();
  }
}

export async function runHttpMcpStdioProxy(
  serverUrl: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const { client: remote } = await connectRemoteTransport(serverUrl, headers);
  const local = new Server(
    {
      name: 'AllAgents',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  local.setRequestHandler(ListToolsSchema, async (request) =>
    remote.listTools(request.params),
  );
  local.setRequestHandler(CallToolSchema, async (request) =>
    parseCallToolResponse(await remote.callTool(request.params)),
  );
  local.setRequestHandler(ListResourcesSchema, async (request) =>
    remote.listResources(request.params),
  );
  local.setRequestHandler(ReadResourceSchema, async (request) =>
    remote.readResource(request.params),
  );
  local.setRequestHandler(ListResourceTemplatesSchema, async (request) =>
    remote.listResourceTemplates(request.params),
  );
  local.setRequestHandler(ListPromptsSchema, async (request) =>
    remote.listPrompts(request.params),
  );
  local.setRequestHandler(GetPromptSchema, async (request) =>
    remote.getPrompt(request.params),
  );

  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    console.error(error.message);
  };
  await local.connect(transport);
}
