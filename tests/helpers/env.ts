/**
 * Temporarily override the resolved home directory for a test.
 *
 * os.homedir() (what src/constants.ts#getHomeDir now delegates to) reads
 * $HOME on POSIX and %USERPROFILE% on Windows — never both — so tests that
 * only stubbed HOME silently stopped taking effect on Windows. Stubbing both
 * keeps tests platform-independent. Returns a restore function that deletes
 * (rather than stringifies `undefined` into) any var that wasn't originally set.
 */
export function stubHomeDir(path: string): () => void {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = path;
  process.env.USERPROFILE = path;

  return () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  };
}
