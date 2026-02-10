import { symlink, lstat, readlink, rm, mkdir, unlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { platform } from 'node:os';
import { realpath } from 'node:fs/promises';

/**
 * Resolve a path's parent directory through symlinks, keeping the final component.
 * This handles the case where a parent directory (e.g., ~/.claude/skills) is a symlink
 * to another location (e.g., ~/.agents/skills). In that case, computing relative paths
 * from the symlink path produces broken symlinks.
 *
 * Returns the real path of the parent + the original basename.
 * If realpath fails (parent doesn't exist), returns the original resolved path.
 */
async function resolveParentSymlinks(path: string): Promise<string> {
  const resolved = resolve(path);
  const dir = dirname(resolved);
  const base = resolved.substring(dir.length + 1); // preserve original basename
  try {
    const realDir = await realpath(dir);
    return `${realDir}/${base}`;
  } catch {
    return resolved;
  }
}

/**
 * Resolve the target of a symlink to an absolute path
 */
function resolveSymlinkTarget(linkPath: string, linkTarget: string): string {
  // If linkTarget is already absolute (e.g., Windows junction), resolve returns it as-is
  // Otherwise, resolve it relative to the link's directory
  return resolve(dirname(linkPath), linkTarget);
}

/**
 * Creates a symlink, handling cross-platform differences.
 * Returns true if symlink was created (or already exists pointing to correct target),
 * false if symlink creation failed (caller should fall back to copy).
 *
 * @param target - The path the symlink should point to (canonical location)
 * @param linkPath - The path where the symlink should be created
 */
export async function createSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    const resolvedTarget = resolve(target);
    const resolvedLinkPath = resolve(linkPath);

    // If target and link are the same path, nothing to do
    if (resolvedTarget === resolvedLinkPath) {
      return true;
    }

    // Also check with symlinks resolved in parent directories.
    // This handles cases where e.g. ~/.claude/skills is a symlink to ~/.agents/skills,
    // so ~/.claude/skills/<skill> and ~/.agents/skills/<skill> are physically the same.
    const realTarget = await resolveParentSymlinks(target);
    const realLinkPath = await resolveParentSymlinks(linkPath);

    if (realTarget === realLinkPath) {
      return true;
    }

    // Check if linkPath already exists
    try {
      const stats = await lstat(linkPath);
      if (stats.isSymbolicLink()) {
        // Check if it already points to the correct target
        const existingTarget = await readlink(linkPath);
        const resolvedExisting = resolveSymlinkTarget(linkPath, existingTarget);
        if (resolvedExisting === resolvedTarget) {
          return true; // Already correct, skip recreation
        }
        // Points to wrong target, remove it
        // Use unlink for symlinks/junctions on Windows
        await unlink(linkPath);
      } else {
        // Not a symlink (regular file/dir), remove it
        await rm(linkPath, { recursive: true });
      }
    } catch (err: unknown) {
      // ELOOP = circular symlink, ENOENT = doesn't exist
      // For ELOOP, try to remove the broken symlink
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ELOOP') {
        try {
          await unlink(linkPath);
        } catch {
          // If we can't remove it, symlink creation will fail and trigger copy fallback
        }
      }
      // For ENOENT or other errors, continue to symlink creation
    }

    // Ensure parent directory exists
    const linkDir = dirname(linkPath);
    await mkdir(linkDir, { recursive: true });

    // Use the real (symlink-resolved) parent directory for computing the relative path.
    // This ensures the symlink target is correct even when the link's parent dir is a symlink.
    const realLinkDir = await resolveParentSymlinks(linkDir);
    const relativePath = relative(realLinkDir, target);

    // On Windows, use junction type for directory symlinks (no admin required)
    const symlinkType = platform() === 'win32' ? 'junction' : undefined;

    await symlink(relativePath, linkPath, symlinkType);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is a valid symlink pointing to the expected target
 */
export async function isValidSymlink(linkPath: string, expectedTarget: string): Promise<boolean> {
  try {
    const stats = await lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      return false;
    }
    const existingTarget = await readlink(linkPath);
    const resolvedExisting = resolveSymlinkTarget(linkPath, existingTarget);
    const resolvedExpected = resolve(expectedTarget);
    return resolvedExisting === resolvedExpected;
  } catch {
    return false;
  }
}
