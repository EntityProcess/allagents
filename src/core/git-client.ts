import simpleGit from 'simple-git';

const DEFAULT_CLONE_TIMEOUT_MS = 300_000;
export const CLONE_TIMEOUT_MS = (() => {
  const raw = process.env.ALLAGENTS_CLONE_TIMEOUT_MS;
  if (!raw) return DEFAULT_CLONE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLONE_TIMEOUT_MS;
})();

export function createGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

export function createGit(baseDir?: string) {
  return simpleGit(baseDir, {
    timeout: { block: CLONE_TIMEOUT_MS },
    config: [
      'filter.lfs.required=false',
      'filter.lfs.smudge=',
      'filter.lfs.clean=',
      'filter.lfs.process=',
    ],
  }).env(createGitEnv());
}
