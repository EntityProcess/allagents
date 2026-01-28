/**
 * Utility for parsing plugin source strings to extract organization/owner information
 *
 * This is used for skill name disambiguation when multiple plugins have skills
 * with the same folder name AND the same plugin name. For GitHub sources, we
 * extract the org name. For local paths, the caller should fall back to using
 * the hash utility.
 */

/**
 * Extract the organization/owner from a GitHub source URL
 *
 * Supports the following formats:
 * - `github:org/repo` → org
 * - `github:org/repo#branch` → org
 * - `gh:org/repo` → org
 * - `gh:org/repo#branch` → org
 * - `https://github.com/org/repo` → org
 * - `https://github.com/org/repo/tree/branch/path` → org
 * - `github.com/org/repo` → org
 * - `org/repo` (shorthand) → org
 * - Local paths (starting with `.`, `/`, or Windows drive) → null
 * - Invalid or empty org → null
 *
 * @param source - The plugin source string
 * @returns The organization/owner name, or null for local paths or invalid sources
 */
export function extractOrgFromSource(source: string): string | null {
  // Handle empty or whitespace-only input
  if (!source || source.trim() === '') {
    return null;
  }

  const trimmedSource = source.trim();

  // Check for local paths first
  if (isLocalPath(trimmedSource)) {
    return null;
  }

  // Handle github: prefix (e.g., github:org/repo or github:org/repo#branch)
  if (trimmedSource.startsWith('github:')) {
    return parseOrgFromPrefix(trimmedSource.slice('github:'.length));
  }

  // Handle gh: prefix (e.g., gh:org/repo or gh:org/repo#branch)
  if (trimmedSource.startsWith('gh:')) {
    return parseOrgFromPrefix(trimmedSource.slice('gh:'.length));
  }

  // Handle full GitHub URLs (https://github.com/org/repo or github.com/org/repo)
  const urlMatch = trimmedSource.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)(?:\/|$)/
  );
  if (urlMatch && urlMatch[1]) {
    return validateOrg(urlMatch[1]);
  }

  // Handle shorthand format (org/repo) - must not look like a local path
  if (trimmedSource.includes('/') && !trimmedSource.includes('://')) {
    const firstSlashIndex = trimmedSource.indexOf('/');
    const potentialOrg = trimmedSource.slice(0, firstSlashIndex);
    return validateOrg(potentialOrg);
  }

  return null;
}

/**
 * Check if a source string represents a local path
 */
function isLocalPath(source: string): boolean {
  // Starts with . (relative path)
  if (source.startsWith('.')) {
    return true;
  }

  // Starts with / (Unix absolute path)
  if (source.startsWith('/')) {
    return true;
  }

  // Windows absolute path (e.g., C:\, D:\)
  if (/^[a-zA-Z]:[\\/]/.test(source)) {
    return true;
  }

  // Contains backslash (Windows path separator)
  if (source.includes('\\')) {
    return true;
  }

  return false;
}

/**
 * Parse org from a prefix format (org/repo or org/repo#branch)
 */
function parseOrgFromPrefix(prefixContent: string): string | null {
  // Remove branch suffix if present (e.g., org/repo#branch → org/repo)
  const withoutBranch = prefixContent.split('#')[0] || '';

  // Extract org (everything before the first /)
  const slashIndex = withoutBranch.indexOf('/');
  if (slashIndex === -1) {
    // No slash means no valid org/repo format
    return null;
  }

  const org = withoutBranch.slice(0, slashIndex);
  return validateOrg(org);
}

/**
 * Validate that an org string is valid (non-empty, valid characters)
 * GitHub usernames/orgs: alphanumeric, hyphens, can't start/end with hyphen
 */
function validateOrg(org: string): string | null {
  if (!org || org.trim() === '') {
    return null;
  }

  const trimmedOrg = org.trim();

  // GitHub org/username rules:
  // - Can contain alphanumeric characters and hyphens
  // - Cannot start or end with a hyphen
  // - Cannot have consecutive hyphens
  // - Must be 1-39 characters
  const validOrgPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

  if (!validOrgPattern.test(trimmedOrg)) {
    // Check if it's a single character (which is valid)
    if (trimmedOrg.length === 1 && /^[a-zA-Z0-9]$/.test(trimmedOrg)) {
      return trimmedOrg;
    }
    return null;
  }

  // Check for consecutive hyphens
  if (trimmedOrg.includes('--')) {
    return null;
  }

  return trimmedOrg;
}
