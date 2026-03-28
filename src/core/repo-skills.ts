import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { parseSkillMetadata } from '../validators/skill.js';
import { CLIENT_MAPPINGS } from '../models/client-mapping.js';
import type { ClientType, Repository } from '../models/workspace-config.js';
export interface WorkspaceSkillEntry {
  repoPath: string;
  name: string;
  description: string;
  location: string;
}

export interface RepoSkillEntry {
  /** Skill name from frontmatter */
  name: string;
  /** Skill description from frontmatter */
  description: string;
  /** Path to SKILL.md relative to the repo root */
  relativePath: string;
  /** File size of SKILL.md in bytes */
  fileSize: number;
}

interface DiscoverOptions {
  /** Client types to derive default skill paths from */
  clients?: (string | ClientType)[];
  /** Custom skill paths (relative to repo root), overrides client-derived paths */
  skillPaths?: string[];
  /** If true, skip discovery entirely */
  disabled?: boolean;
}

/**
 * Discover skills in a repository by scanning skill directories.
 * Parses SKILL.md frontmatter for name and description.
 * Skips symlinks and entries with invalid/missing frontmatter.
 */
export async function discoverRepoSkills(
  repoPath: string,
  options: DiscoverOptions,
): Promise<RepoSkillEntry[]> {
  if (options.disabled) return [];

  const skillDirs = new Set<string>();

  if (options.skillPaths) {
    for (const p of options.skillPaths) {
      skillDirs.add(p);
    }
  } else if (options.clients) {
    for (const client of options.clients) {
      const mapping = CLIENT_MAPPINGS[client as ClientType];
      if (mapping?.skillsPath) {
        skillDirs.add(mapping.skillsPath);
      }
    }
  }

  const results: RepoSkillEntry[] = [];
  const seen = new Set<string>();

  for (const skillDir of skillDirs) {
    const absDir = join(repoPath, skillDir);
    if (!existsSync(absDir)) continue;

    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Skip symlinks/junctions
      const entryPath = join(absDir, entry.name);
      try {
        const stat = lstatSync(entryPath);
        if (stat.isSymbolicLink()) continue;
      } catch {
        continue;
      }

      const skillMdPath = join(entryPath, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;

      const relPath = relative(repoPath, skillMdPath);
      if (seen.has(relPath)) continue;

      try {
        const content = await readFile(skillMdPath, 'utf-8');
        const metadata = parseSkillMetadata(content);
        if (!metadata) continue;

        seen.add(relPath);
        results.push({
          name: metadata.name,
          description: metadata.description,
          relativePath: relPath,
          fileSize: content.length,
        });
      } catch {
        // skip unreadable skill files
      }
    }
  }

  return results;
}

/**
 * Discover skills from all workspace repositories and return entries
 * suitable for embedding in WORKSPACE-RULES.
 * Shared by both updateAgentFiles() and the full sync pipeline.
 *
 * Deduplicates by skill name:
 * - Skills under .agents/ take priority
 * - Otherwise the skill with the largest file size wins
 */
export async function discoverWorkspaceSkills(
  workspacePath: string,
  repositories: Repository[],
  clientNames: string[],
): Promise<WorkspaceSkillEntry[]> {
  const skillsByName = new Map<string, WorkspaceSkillEntry & { fileSize: number }>();

  for (const repo of repositories) {
    if (repo.skills === false || repo.skills === undefined) continue;

    const repoAbsPath = resolve(workspacePath, repo.path);
    const discoverOpts = Array.isArray(repo.skills)
      ? { skillPaths: repo.skills }
      : { clients: clientNames };

    const repoSkills = await discoverRepoSkills(repoAbsPath, discoverOpts);
    for (const skill of repoSkills) {
      // Use forward slashes for consistent cross-platform paths
      const location = `${repo.path}/${skill.relativePath}`.replace(/\\/g, '/');
      const candidate = {
        repoPath: repo.path,
        name: skill.name,
        description: skill.description,
        location,
        fileSize: skill.fileSize,
      };

      const existing = skillsByName.get(skill.name);
      if (!existing) {
        skillsByName.set(skill.name, candidate);
        continue;
      }

      // .agents skills take priority
      const existingIsAgents = existing.location.includes('.agents/');
      const candidateIsAgents = candidate.location.includes('.agents/');
      if (candidateIsAgents && !existingIsAgents) {
        skillsByName.set(skill.name, candidate);
      } else if (!candidateIsAgents && existingIsAgents) {
        // keep existing
      } else if (candidate.fileSize > existing.fileSize) {
        // same priority tier — larger file wins; equal size keeps first-seen (repo order)
        skillsByName.set(skill.name, candidate);
      }
    }
  }

  // Strip fileSize from output entries
  return [...skillsByName.values()].map(({ fileSize: _, ...entry }) => entry);
}

export interface RepoSkillGroup {
  repoName: string;
  skills: WorkspaceSkillEntry[];
}

/**
 * Writes per-repo skills index files to `.allagents/skills-index/<repo-name>.md`.
 * Returns list of relative paths (from `.allagents/`) of written files.
 */
export function writeSkillsIndex(
  workspacePath: string,
  skillsByRepo: Map<string, RepoSkillGroup>,
): string[] {
  if (skillsByRepo.size === 0) return [];

  const indexDir = join(workspacePath, '.allagents', 'skills-index');
  mkdirSync(indexDir, { recursive: true });

  const written: string[] = [];

  for (const [, { repoName, skills }] of skillsByRepo) {
    const skillEntries = skills
      .map(
        (s) =>
          `<skill>\n<name>${s.name}</name>\n<description>${s.description}</description>\n<location>${s.location}</location>\n</skill>`,
      )
      .join('\n');

    const content = `# Skills: ${repoName}\n\n<available_skills>\n${skillEntries}\n</available_skills>\n`;

    const fileName = `${repoName}.md`;
    writeFileSync(join(indexDir, fileName), content, 'utf-8');
    written.push(`skills-index/${fileName}`);
  }

  return written;
}

/**
 * Removes skills-index files not in the current set.
 * Removes the `skills-index/` directory if it becomes empty.
 */
export function cleanupSkillsIndex(
  workspacePath: string,
  currentFiles: string[],
): void {
  const indexDir = join(workspacePath, '.allagents', 'skills-index');
  if (!existsSync(indexDir)) return;

  const currentSet = new Set(currentFiles.map((f) => f.replace('skills-index/', '')));

  let entries: string[];
  try {
    entries = readdirSync(indexDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!currentSet.has(entry)) {
      rmSync(join(indexDir, entry), { force: true });
    }
  }

  // Remove directory if empty
  try {
    const remaining = readdirSync(indexDir);
    if (remaining.length === 0) {
      rmSync(indexDir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

/**
 * Groups WorkspaceSkillEntry[] by repo path, deriving repo name from
 * `repository.name` or path basename.
 */
export function groupSkillsByRepo(
  skills: WorkspaceSkillEntry[],
  repositories: Repository[],
): Map<string, RepoSkillGroup> {
  const repoNameMap = new Map<string, string>();
  for (const repo of repositories) {
    repoNameMap.set(repo.path, repo.name ?? basename(repo.path));
  }

  const grouped = new Map<string, RepoSkillGroup>();
  for (const skill of skills) {
    const repoName = repoNameMap.get(skill.repoPath) ?? basename(skill.repoPath);
    const existing = grouped.get(skill.repoPath);
    if (existing) {
      existing.skills.push(skill);
    } else {
      grouped.set(skill.repoPath, { repoName, skills: [skill] });
    }
  }

  return grouped;
}
