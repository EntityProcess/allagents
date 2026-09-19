import { createHash, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { ProfileResourceOwnership } from '../../models/profile-state.js';

const FULL_SHA256 = /^[a-f0-9]{64}$/;

export function sha256Fingerprint(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

async function existingStats(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoSymlinkChain(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments) {
    current = join(current, segment);
    const stats = await existingStats(current);
    if (!stats) break;
    if (stats.isSymbolicLink()) {
      throw new Error(`Unsafe profile path traverses a symbolic link: ${current}`);
    }
  }
}

/**
 * Verify both the lexical containment boundary and every existing component in
 * the root/destination chain immediately before filesystem mutation.
 */
export async function assertSafeProfilePath(
  writeRoot: string,
  destination: string,
): Promise<void> {
  const root = resolve(writeRoot);
  const candidate = resolve(destination);
  const rel = relative(root, candidate);
  if (rel !== '' && (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))) {
    throw new Error(`Profile destination escapes selected write root: ${candidate}`);
  }
  await assertNoSymlinkChain(root);
  await assertNoSymlinkChain(candidate);
}

export async function fingerprintProfileFile(path: string): Promise<string | null> {
  const stats = await existingStats(path);
  if (!stats) return null;
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to fingerprint symbolic link: ${path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Refusing to fingerprint non-file profile resource: ${path}`);
  }
  return sha256Fingerprint(await readFile(path));
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly size: number;
  readonly modifiedAt: number;
}

interface ExpectedFile {
  readonly fingerprint: string;
  readonly identity: FileIdentity;
}

function fileIdentity(stats: Stats): FileIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    size: stats.size,
    modifiedAt: stats.mtimeMs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt
  );
}

async function restoreCapturedFile(
  capturedPath: string,
  destination: string,
  recoveryDirectory: string,
): Promise<boolean> {
  try {
    await link(capturedPath, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  await rm(recoveryDirectory, { recursive: true, force: true });
  return true;
}

function recoveryError(error: unknown, capturedPath: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message}; the destination changed during recovery, so the captured file was retained at ${capturedPath}`,
    { cause: error },
  );
}

async function atomicWriteFile(
  writeRoot: string,
  destination: string,
  content: Uint8Array,
  mode: number,
  expected?: ExpectedFile,
): Promise<void> {
  const parent = dirname(destination);
  await assertSafeProfilePath(writeRoot, parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertSafeProfilePath(writeRoot, destination);

  const uniqueName = `${process.pid}.${randomUUID()}`;
  const temporaryPath = join(parent, `.${basename(destination)}.${uniqueName}.tmp`);
  const recoveryDirectory = expected
    ? join(parent, `.${basename(destination)}.${uniqueName}.recovery`)
    : undefined;
  const capturedPath = recoveryDirectory
    ? join(recoveryDirectory, basename(destination))
    : undefined;
  let handle: FileHandle | undefined;
  let captured = false;
  let published = false;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    await handle.writeFile(content);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertSafeProfilePath(writeRoot, destination);

    if (!expected) {
      await link(temporaryPath, destination);
      published = true;
      await unlink(temporaryPath);
      return;
    }

    if (!recoveryDirectory || !capturedPath) {
      throw new Error('Managed file recovery path was not initialized');
    }
    await mkdir(recoveryDirectory, { mode: 0o700 });
    await rename(destination, capturedPath);
    captured = true;

    const capturedStats = await lstat(capturedPath);
    const capturedFingerprint = capturedStats.isFile()
      ? sha256Fingerprint(await readFile(capturedPath))
      : undefined;
    if (
      !capturedStats.isFile() ||
      capturedFingerprint !== expected.fingerprint ||
      !sameFileIdentity(fileIdentity(capturedStats), expected.identity)
    ) {
      throw new Error(`Refusing to overwrite modified profile file: ${destination}`);
    }

    await assertSafeProfilePath(writeRoot, destination);
    await link(temporaryPath, destination);
    published = true;
    await unlink(temporaryPath);
    await rm(recoveryDirectory, { recursive: true, force: true });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (captured && !published && capturedPath && recoveryDirectory) {
      try {
        const restored = await restoreCapturedFile(
          capturedPath,
          destination,
          recoveryDirectory,
        );
        if (!restored) throw recoveryError(error, capturedPath);
      } catch (restoreError) {
        if (
          restoreError instanceof Error &&
          restoreError.cause === error
        ) {
          throw restoreError;
        }
        throw new AggregateError(
          [error, restoreError],
          `Managed file publication failed and the captured file could not be restored from ${capturedPath}`,
        );
      }
    } else if (recoveryDirectory) {
      await rm(recoveryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export interface ManagedFileMaterialization {
  readonly root: string;
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly mode: number;
  /** Required when replacing an existing AllAgents-managed file. */
  readonly previousFingerprint?: string;
}

export interface ManagedFileMaterializationResult {
  readonly status: 'created' | 'updated' | 'unchanged';
  readonly preFingerprint?: string;
  readonly postFingerprint: string;
}

export async function materializeManagedFile(
  request: ManagedFileMaterialization,
): Promise<ManagedFileMaterializationResult> {
  await assertSafeProfilePath(request.root, request.path);
  if (
    request.previousFingerprint !== undefined &&
    !FULL_SHA256.test(request.previousFingerprint)
  ) {
    throw new Error('Managed file previous fingerprint must be a full SHA-256 digest');
  }

  const desired = typeof request.content === 'string'
    ? Buffer.from(request.content, 'utf8')
    : request.content;
  const postFingerprint = sha256Fingerprint(desired);
  const stats = await existingStats(request.path);
  let preFingerprint: string | undefined;
  let expectedFile: ExpectedFile | undefined;
  if (stats) {
    if (!stats.isFile()) {
      throw new Error(`Profile file destination is not a regular file: ${request.path}`);
    }
    preFingerprint = sha256Fingerprint(await readFile(request.path));
    const verifiedStats = await existingStats(request.path);
    if (!verifiedStats?.isFile()) {
      throw new Error(`Profile file destination changed during inspection: ${request.path}`);
    }
    const initialIdentity = fileIdentity(stats);
    const verifiedIdentity = fileIdentity(verifiedStats);
    if (!sameFileIdentity(initialIdentity, verifiedIdentity)) {
      throw new Error(`Profile file destination changed during inspection: ${request.path}`);
    }
    if (!request.previousFingerprint) {
      throw new Error(`Refusing to overwrite unowned profile file: ${request.path}`);
    }
    if (preFingerprint !== request.previousFingerprint) {
      throw new Error(`Refusing to overwrite modified profile file: ${request.path}`);
    }
    const currentMode = stats.mode & 0o777;
    if (preFingerprint === postFingerprint && currentMode === request.mode) {
      return { status: 'unchanged', preFingerprint, postFingerprint };
    }
    expectedFile = {
      fingerprint: preFingerprint,
      identity: verifiedIdentity,
    };
  }

  await atomicWriteFile(request.root, request.path, desired, request.mode, expectedFile);
  return {
    status: preFingerprint ? 'updated' : 'created',
    ...(preFingerprint && { preFingerprint }),
    postFingerprint,
  };
}

export interface ManagedFileRemoval {
  readonly root: string;
  readonly path: string;
  readonly ownership: ProfileResourceOwnership;
  readonly expectedFingerprint?: string;
}

export interface ManagedFileRemovalResult {
  readonly status: 'removed' | 'missing' | 'retained-referenced' | 'retained-modified';
  readonly preFingerprint?: string;
}

export async function removeManagedFile(
  request: ManagedFileRemoval,
): Promise<ManagedFileRemovalResult> {
  await assertSafeProfilePath(request.root, request.path);
  if (request.ownership === 'referenced') {
    return { status: 'retained-referenced' };
  }
  if (!request.expectedFingerprint || !FULL_SHA256.test(request.expectedFingerprint)) {
    throw new Error('Managed file cleanup requires a full SHA-256 fingerprint');
  }

  const stats = await existingStats(request.path);
  if (!stats) return { status: 'missing' };
  if (!stats.isFile()) {
    throw new Error(`Refusing to remove non-file profile resource: ${request.path}`);
  }
  const preFingerprint = sha256Fingerprint(await readFile(request.path));
  if (preFingerprint !== request.expectedFingerprint) {
    return { status: 'retained-modified', preFingerprint };
  }

  await assertSafeProfilePath(request.root, request.path);
  await unlink(request.path);
  return { status: 'removed', preFingerprint };
}
