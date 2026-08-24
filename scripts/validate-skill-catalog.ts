import { execFile } from 'node:child_process';
import {
  type CatalogHealthDependencies,
  type CatalogTreeEntry,
  checkSkillCatalogHealth,
  validateSkillCatalog,
} from '../src/core/skill-catalog-health.js';
import { RECOMMENDED_SKILL_CATALOG } from '../src/core/skill-catalog.js';

const mode = process.argv[2];
if (mode !== '--ci' && mode !== '--report') {
  console.error('Usage: bun run scripts/validate-skill-catalog.ts --ci|--report');
  process.exit(2);
}

const token =
  process.env.GITHUB_TOKEN ||
  (await new Promise<string | undefined>((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 3000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  }));
const headers: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'allagents-catalog-health',
};
if (token) headers.Authorization = `Bearer ${token}`;

async function githubGet<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: 'GET',
    headers,
  });
  if (!response.ok) {
    throw new Error(`GitHub GET ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

const dependencies: CatalogHealthDependencies = {
  async getRepository(repo) {
    const repository = await githubGet<{
      full_name: string;
      default_branch: string;
    }>(`/repos/${repo}`);
    const branch = await githubGet<{ commit: { sha: string } }>(
      `/repos/${repo}/branches/${encodeURIComponent(repository.default_branch)}`,
    );
    return {
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
      headSha: branch.commit.sha,
    };
  },
  async getTree(repo, ref) {
    const result = await githubGet<{
      truncated: boolean;
      tree: Array<{ path: string; type: string; mode: string }>;
    }>(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (result.truncated) {
      throw new Error(`GitHub tree response was truncated for ${repo}@${ref}`);
    }
    return result.tree
      .filter(
        (entry): entry is { path: string; type: 'blob' | 'tree'; mode: string } =>
          entry.type === 'blob' || entry.type === 'tree',
      )
      .map(
        (entry): CatalogTreeEntry => ({
          path: entry.path,
          type: entry.type,
          mode: entry.mode,
        }),
      );
  },
  async getTextFile(repo, ref, path) {
    const result = await githubGet<{
      type: string;
      encoding?: string;
      content?: string;
    }>(
      `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
    );
    if (
      result.type !== 'file' ||
      result.encoding !== 'base64' ||
      typeof result.content !== 'string'
    ) {
      return null;
    }
    return Buffer.from(result.content.replace(/\n/g, ''), 'base64').toString(
      'utf8',
    );
  },
};

const validationIssues = validateSkillCatalog(RECOMMENDED_SKILL_CATALOG);
if (validationIssues.length > 0) {
  console.error(JSON.stringify({ validationIssues }, null, 2));
  process.exit(1);
}

const report = await checkSkillCatalogHealth(
  RECOMMENDED_SKILL_CATALOG,
  dependencies,
);
console.log(JSON.stringify(report, null, 2));
if (report.sources.some((source) => source.status !== 'healthy')) {
  process.exit(1);
}
