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
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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

function hashServerUrl(serverUrl: string): string {
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

function getRequestInit(
  headers: Record<string, string>,
): RequestInit | undefined {
  if (Object.keys(headers).length === 0) {
    return undefined;
  }
  return { headers };
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

function tryOpenBrowser(url: string): void {
  const commands: Array<{ command: string; args: string[] }> =
    process.platform === 'darwin'
      ? [{ command: 'open', args: [url] }]
      : process.platform === 'win32'
        ? [{ command: 'cmd', args: ['/c', 'start', '', url] }]
        : [
            { command: 'xdg-open', args: [url] },
            { command: 'gio', args: ['open', url] },
          ];

  for (const { command, args } of commands) {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    } catch {
      // Try the next launcher.
    }
  }
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
  private readonly stateValue = randomUUID();

  constructor(
    private readonly port: number,
    serverUrl: string,
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
    if (!this.pendingAuth) {
      throw new Error('OAuth authorization has not been started');
    }
    return this.pendingAuth;
  }

  private waitForAuthorizationCode(authorizationUrl: URL): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer(
        (request: IncomingMessage, response: ServerResponse) => {
          try {
            const parsed = new URL(
              request.url ?? '/',
              `http://127.0.0.1:${this.port}`,
            );
            const code = parsed.searchParams.get('code');
            const error = parsed.searchParams.get('error');

            if (code) {
              response.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
              });
              response.end(
                '<html><body><h1>Authorization complete</h1><p>You can close this window.</p></body></html>',
              );
              server.close();
              resolve(code);
              return;
            }

            const message = error ?? 'No authorization code received';
            response.writeHead(400, {
              'content-type': 'text/html; charset=utf-8',
            });
            response.end(
              `<html><body><h1>Authorization failed</h1><p>${message}</p></body></html>`,
            );
            server.close();
            reject(new Error(message));
          } catch (error) {
            server.close();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
      );

      const timeout = setTimeout(() => {
        server.close();
        reject(new Error('Timed out waiting for OAuth authorization callback'));
      }, AUTH_TIMEOUT_MS);

      server.on('close', () => {
        clearTimeout(timeout);
      });
      server.on('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        console.error('Opening browser for authorization...');
        console.error(
          `If the browser does not open, visit: ${authorizationUrl.toString()}`,
        );
        tryOpenBrowser(authorizationUrl.toString());
      });
    });
  }
}

async function buildOAuthProvider(
  serverUrl: string,
): Promise<FileOAuthClientProvider> {
  const cacheDir = getCacheDir(serverUrl);
  const cachedClientInfo = await readJsonFile<OAuthClientInformationMixed>(
    join(cacheDir, 'client-info.json'),
  );

  let port = parseLoopbackPort(cachedClientInfo);
  if (!port) {
    port = await findFreePort();
  }

  const provider = new FileOAuthClientProvider(port, serverUrl);
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

async function connectRemoteTransport(
  serverUrl: string,
  headers: Record<string, string>,
): Promise<Client> {
  const provider = await buildOAuthProvider(serverUrl);
  const client = new Client(
    {
      name: 'AllAgents',
      version: '1.0.0',
    },
    { capabilities: {} },
  );

  const buildTransport = () => {
    const requestInit = getRequestInit(headers);
    return new StreamableHTTPClientTransport(new URL(serverUrl), {
      authProvider: provider,
      ...(requestInit && { requestInit }),
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

  return client;
}

export async function runHttpMcpStdioProxy(
  serverUrl: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const remote = await connectRemoteTransport(serverUrl, headers);
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
