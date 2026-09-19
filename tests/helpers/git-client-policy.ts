import { createGit } from '../../src/core/git-client.js';

const repoPath = process.argv[2];
if (!repoPath) throw new Error('Repository path is required');

await createGit(repoPath).status();
