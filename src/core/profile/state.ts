import { randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ClientType } from '../../models/workspace-config.js';
import {
  ProfileStateSchema,
  type ProfileOperation,
  type ProfileResourceRelationship,
  type ProfileState,
} from '../../models/profile-state.js';
import {
  sanitizeNativeError,
  sanitizeNativeProvenance,
} from '../native/types.js';
import { assertSafeProfilePath, sha256Fingerprint } from './files.js';

export type ProfileStateLoadResult =
  | { readonly status: 'missing'; readonly path: string }
  | { readonly status: 'loaded'; readonly path: string; readonly state: ProfileState }
  | { readonly status: 'malformed'; readonly path: string; readonly error: string };

const SECRET_ASSIGNMENT =
  /\b(authorization|credential|password|secret|token|api[-_]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_SECRET = /\bbearer\s+[^\s,;]+/gi;
const URL_IN_TEXT = /\b(?:https?|ssh):\/\/[^\s'"<>]+/gi;

export function getProfileStatePath(profileRoot: string): string {
  return join(resolve(profileRoot), 'state.json');
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ssh:'].includes(url.protocol)) return value;
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:^|[-_.])(auth|credential|key|password|secret|signature|token)(?:$|[-_.])/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeProfileError(error: string | undefined): string | undefined {
  const terminalSafe = sanitizeNativeError(error);
  if (!terminalSafe) return undefined;
  const sanitized = terminalSafe
    .replace(URL_IN_TEXT, (url) => sanitizeUrl(url))
    .replace(BEARER_SECRET, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]');
  return sanitized || undefined;
}

function sanitizeRelationship(
  relationship: ProfileResourceRelationship,
): ProfileResourceRelationship {
  const provenance = relationship.provenance
    ? sanitizeNativeProvenance(relationship.provenance)
    : undefined;
  const error = sanitizeProfileError(relationship.error);
  return {
    ...relationship,
    identity: sanitizeUrl(relationship.identity),
    ...(relationship.requestedRef !== undefined && {
      requestedRef: sanitizeUrl(relationship.requestedRef),
    }),
    ...(relationship.resolvedRef !== undefined && {
      resolvedRef: sanitizeUrl(relationship.resolvedRef),
    }),
    ...(provenance && Object.keys(provenance).length > 0
      ? { provenance }
      : { provenance: undefined }),
    ...(error ? { error } : { error: undefined }),
  };
}

export function sanitizeProfileState(state: ProfileState): ProfileState {
  const result = ProfileStateSchema.safeParse({
    ...state,
    clientStatuses: state.clientStatuses.map((entry) => {
      const error = sanitizeProfileError(entry.error);
      return { ...entry, ...(error ? { error } : { error: undefined }) };
    }),
    resources: state.resources.map(sanitizeRelationship),
  });
  if (!result.success) {
    throw new Error(`Refusing to persist invalid profile state: ${result.error.message}`);
  }
  return result.data;
}

export async function loadProfileState(
  profileRoot: string,
): Promise<ProfileStateLoadResult> {
  const statePath = getProfileStatePath(profileRoot);
  try {
    await assertSafeProfilePath(profileRoot, statePath);
  } catch (error) {
    return {
      status: 'malformed',
      path: statePath,
      error:
        sanitizeProfileError(error instanceof Error ? error.message : String(error)) ??
        'unsafe state path',
    };
  }
  let text: string;
  try {
    text = await readFile(statePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', path: statePath };
    }
    return {
      status: 'malformed',
      path: statePath,
      error: sanitizeProfileError(error instanceof Error ? error.message : String(error)) ?? 'state read failed',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      status: 'malformed',
      path: statePath,
      error: `Invalid profile state JSON: ${sanitizeProfileError(error instanceof Error ? error.message : String(error)) ?? 'parse failed'}`,
    };
  }
  const result = ProfileStateSchema.safeParse(parsed);
  if (!result.success) {
    return {
      status: 'malformed',
      path: statePath,
      error: `Invalid profile state: ${result.error.message}`,
    };
  }
  return { status: 'loaded', path: statePath, state: result.data };
}

/** Missing state has no cleanup authority; malformed state blocks cleanup. */
export function profileStateForCleanup(
  result: ProfileStateLoadResult,
): ProfileState | null {
  if (result.status === 'missing') return null;
  if (result.status === 'malformed') {
    throw new Error(`Refusing profile cleanup because state is malformed: ${result.error}`);
  }
  return result.state;
}

async function writeStateAtomically(
  profileRoot: string,
  statePath: string,
  state: ProfileState,
): Promise<void> {
  await assertSafeProfilePath(profileRoot, dirname(statePath));
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await assertSafeProfilePath(profileRoot, statePath);
  const tempPath = join(
    dirname(statePath),
    `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSafeProfilePath(profileRoot, statePath);
    await rename(tempPath, statePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function saveProfileState(
  profileRoot: string,
  state: ProfileState,
): Promise<ProfileState> {
  const sanitized = sanitizeProfileState(state);
  const existing = await loadProfileState(profileRoot);
  if (existing.status === 'malformed') {
    throw new Error(`Refusing to replace malformed profile state: ${existing.error}`);
  }
  await writeStateAtomically(profileRoot, existing.path, sanitized);
  return sanitized;
}

export interface ProfileResourceCheckpointOptions {
  readonly clientStatus?: ProfileState['status'];
  readonly clientError?: string;
  readonly operation?: Partial<Pick<ProfileOperation, 'kind' | 'completedAt'>>;
  readonly now?: string;
}

export async function checkpointProfileResource(
  profileRoot: string,
  state: ProfileState,
  resource: ProfileResourceRelationship,
  options: ProfileResourceCheckpointOptions = {},
): Promise<ProfileState> {
  const validState = sanitizeProfileState(state);
  const validResource = sanitizeRelationship(resource);
  const resources = [...validState.resources];
  const existingIndex = resources.findIndex((entry) => entry.key === validResource.key);
  if (existingIndex === -1) resources.push(validResource);
  else resources[existingIndex] = validResource;
  const clientStatuses = validState.clientStatuses.map((entry) => {
    if (entry.client !== validResource.client) return entry;
    const error = sanitizeProfileError(options.clientError);
    return {
      client: entry.client,
      status: options.clientStatus ?? 'partial',
      ...(error && { error }),
    };
  });
  const status = clientStatuses.every((entry) => entry.status === 'installed')
    ? 'installed'
    : 'partial';


  const now = options.now ?? new Date().toISOString();
  const operation: ProfileOperation = {
    ...validState.operation,
    ...(options.operation?.kind && { kind: options.operation.kind }),
    updatedAt: now,
    ...(options.operation?.completedAt && {
      completedAt: options.operation.completedAt,
    }),
  };
  return saveProfileState(profileRoot, {
    ...validState,
    status,
    clientStatuses,
    operation,
    resources,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Profile declaration contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  throw new Error(`Profile declaration contains unsupported ${typeof value} value`);
}

export function hashProfileDeclaration(value: unknown): string {
  return sha256Fingerprint(canonicalJson(value));
}

export function createProfileState(input: {
  readonly profile: string;
  readonly clients: readonly ClientType[];
  readonly declaration: unknown;
  readonly operation: Omit<ProfileOperation, 'updatedAt'> & { readonly updatedAt?: string };
}): ProfileState {
  const operation = {
    ...input.operation,
    updatedAt: input.operation.updatedAt ?? input.operation.startedAt,
  };
  const result = ProfileStateSchema.safeParse({
    version: 1,
    profile: input.profile,
    clients: [...input.clients],
    declarationDigest: hashProfileDeclaration(input.declaration),
    status: 'partial',
    clientStatuses: input.clients.map((client) => ({
      client,
      status: 'partial' as const,
    })),
    operation,
    resources: [],
  });
  if (!result.success) {
    throw new Error(`Cannot create profile state: ${result.error.message}`);
  }
  return result.data;
}
