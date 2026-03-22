/**
 * Git error classification — extracted so it can be tested independently
 * of simple-git module mocks that other tests install.
 */

export class GitCloneError extends Error {
  readonly url: string;
  readonly isTimeout: boolean;
  readonly isAuthError: boolean;

  constructor(
    message: string,
    url: string,
    isTimeout = false,
    isAuthError = false,
  ) {
    super(message);
    this.name = 'GitCloneError';
    this.url = url;
    this.isTimeout = isTimeout;
    this.isAuthError = isAuthError;
  }
}

export function classifyError(error: unknown, url: string): GitCloneError {
  const errorMessage =
    error instanceof Error ? error.message : String(error);

  const isTimeout =
    errorMessage.includes('block timeout') ||
    errorMessage.includes('timed out');

  const isAuthError =
    errorMessage.includes('Authentication failed') ||
    errorMessage.includes('could not read Username') ||
    errorMessage.includes('Permission denied') ||
    errorMessage.includes('Repository not found');

  // HTTP 5xx from the remote can indicate auth/token issues (e.g., expired
  // credential sent by Git Credential Manager) rather than a genuine server
  // error.  Treat it like an auth error so callers get actionable guidance.
  const isServerError =
    /returned error: 5\d\d/.test(errorMessage) ||
    errorMessage.includes('Internal Server Error');

  if (isTimeout) {
    return new GitCloneError(
      `Clone timed out after 60s for ${url}.\n  Check your network connection and repository access.\n  For SSH: ssh-add -l (to check loaded keys)\n  For HTTPS: Check your git credentials`,
      url,
      true,
      false,
    );
  }

  if (isAuthError || isServerError) {
    return new GitCloneError(
      `Authentication failed for ${url}.\n  For private repos, ensure you have access.\n  For SSH: Check your keys with 'ssh -T git@github.com'\n  For HTTPS: Configure git credentials or run 'gh auth setup-git'`,
      url,
      false,
      true,
    );
  }

  return new GitCloneError(
    `Failed to clone ${url}: ${errorMessage}`,
    url,
    false,
    false,
  );
}
