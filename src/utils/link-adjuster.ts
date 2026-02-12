import { dirname, join, normalize, isAbsolute } from 'node:path';

/**
 * Options for adjusting links in content
 */
export interface LinkAdjustOptions {
  /**
   * Map of skill folder name to resolved name.
   * Used when skills are renamed due to conflicts.
   */
  skillNameMap?: Map<string, string>;
  /**
   * Path to skills in workspace (e.g., '.agents/skills/')
   */
  workspaceSkillsPath: string;
}

/**
 * Mapping of plugin-relative paths to workspace destinations.
 * Keys are path prefixes as they appear in relative paths from .github/ folder.
 */
interface PathMapping {
  /** Pattern to match (normalized path prefix) */
  pattern: string;
  /** Function to transform the matched path */
  transform: (matchedPath: string, options: LinkAdjustOptions) => string;
}

/**
 * Path mappings from plugin structure to workspace structure.
 * These patterns match paths relative to the .github/ folder that point to plugin content.
 */
const PATH_MAPPINGS: PathMapping[] = [
  {
    // skills/ at plugin root -> workspace skills path
    // e.g., ../../skills/foo -> ../../.agents/skills/foo
    pattern: 'skills/',
    transform: (matchedPath: string, options: LinkAdjustOptions) => {
      // Extract the skill folder name and remaining path
      const skillsPrefix = 'skills/';
      const afterSkills = matchedPath.substring(skillsPrefix.length);
      const parts = afterSkills.split('/');
      const skillFolderName = parts[0] ?? '';
      const restOfPath = parts.slice(1).join('/');

      // Check if skill was renamed
      const resolvedName = options.skillNameMap?.get(skillFolderName) ?? skillFolderName;

      // Build new path with workspace skills path
      const newPath = join(options.workspaceSkillsPath, resolvedName, restOfPath);
      return newPath;
    },
  },
];

/**
 * Regular expression patterns for detecting links in content
 */
const LINK_PATTERNS = {
  // #file:path pattern (GitHub Copilot file reference)
  fileReference: /#file:([^\s\])"'`]+)/g,
  // Standard markdown link [text](path)
  markdownLink: /\[([^\]]*)\]\(([^)]+)\)/g,
};

/**
 * Check if a path is a URL (http/https) or absolute
 */
function isUrlOrAbsolute(path: string): boolean {
  return (
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('mailto:') ||
    isAbsolute(path)
  );
}

/**
 * Adjust a single relative path from plugin .github/ structure to workspace structure.
 *
 * This function handles paths that go from .github/some/nested/file.md back up to plugin root
 * and then into plugin content folders like skills/, commands/, or agents/.
 *
 * @param relativePath - The relative path as it appears in the link
 * @param sourceFileRelPath - The relative path of the source file within .github/ (e.g., 'instructions/cargowise.md')
 * @param options - Link adjustment options
 * @returns Adjusted path or original if no adjustment needed
 */
export function adjustRelativePath(
  relativePath: string,
  sourceFileRelPath: string,
  options: LinkAdjustOptions,
): string {
  // Skip URLs and absolute paths
  if (isUrlOrAbsolute(relativePath)) {
    return relativePath;
  }

  // Skip paths that don't go up (they stay within .github/)
  if (!relativePath.startsWith('../')) {
    return relativePath;
  }

  // Normalize the relative path
  const normalized = normalize(relativePath);

  // Calculate how the path resolves from the source file's perspective
  // sourceFileRelPath is relative to .github/, e.g., 'instructions/cargowise.md'
  const sourceDir = dirname(sourceFileRelPath);

  // Count how many ../ we need to exit .github/ folder
  // Split the source directory to count nesting depth
  const sourceDepth = sourceDir === '.' ? 0 : sourceDir.split('/').filter(Boolean).length;

  // Count ../ segments in the original path
  const upSegments = normalized.split('/').filter((s) => s === '..').length;

  // We need (sourceDepth + 1) ../ to exit .github/ and reach workspace root
  // +1 because we're inside .github/ itself
  const exitsGithub = upSegments > sourceDepth;

  if (!exitsGithub) {
    // Path stays within .github/, no adjustment needed
    return relativePath;
  }

  // Calculate what the path resolves to at plugin root level
  // The path exits .github/ and goes to plugin root, then somewhere else
  // We need to figure out where it points to in the plugin structure

  // How many ../ are left after exiting .github/?
  // Total ../ minus (depth to exit .github/)
  const levelsAboveGithub = upSegments - (sourceDepth + 1);

  // The remaining path after all ../ segments
  const pathParts = normalized.split('/');
  const afterUpParts = pathParts.slice(upSegments);
  const targetPath = afterUpParts.join('/');

  // If the path goes above the plugin root (levelsAboveGithub > 0), we can't adjust it
  if (levelsAboveGithub > 0) {
    return relativePath;
  }

  // Now targetPath is relative to plugin root
  // Check if it matches any of our mappings
  for (const mapping of PATH_MAPPINGS) {
    if (targetPath.startsWith(mapping.pattern)) {
      const transformedTarget = mapping.transform(targetPath, options);

      // Build the new path from the source file's location
      // We need to go up from source file to workspace root, then to the transformed target
      // From .github/foo/bar.md: ../../ goes to workspace root
      // From .github/bar.md: ../ goes to workspace root
      const upToRoot = '../'.repeat(sourceDepth + 1);
      return upToRoot + transformedTarget;
    }
  }

  // No mapping matched, return original
  return relativePath;
}

/**
 * Adjust all relative links in markdown content.
 *
 * @param content - The markdown content to process
 * @param sourceFileRelPath - The relative path of the source file within .github/ (e.g., 'instructions/cargowise.md')
 * @param options - Link adjustment options
 * @returns Content with adjusted links
 */
export function adjustLinksInContent(
  content: string,
  sourceFileRelPath: string,
  options: LinkAdjustOptions,
): string {
  let result = content;

  // Replace #file: references
  result = result.replace(LINK_PATTERNS.fileReference, (_match, path) => {
    const adjustedPath = adjustRelativePath(path, sourceFileRelPath, options);
    return `#file:${adjustedPath}`;
  });

  // Replace markdown links [text](path)
  // Need to be careful not to adjust URLs
  result = result.replace(LINK_PATTERNS.markdownLink, (match, text, path) => {
    // Skip anchor links
    if (path.startsWith('#')) {
      return match;
    }
    const adjustedPath = adjustRelativePath(path, sourceFileRelPath, options);
    return `[${text}](${adjustedPath})`;
  });

  return result;
}
