/**
 * Temporarily override the resolved home directory for a test.
 *
 * Bun caches os.homedir() for the process, so changing HOME or USERPROFILE
 * cannot isolate tests reliably. getHomeDir() owns this explicitly test-only
 * override while continuing to use os.homedir() in production. The restore
 * function supports nested stubs and deletes an override that was originally
 * absent.
 */
export function stubHomeDir(path: string): () => void {
  const originalTestHome = process.env.ALLAGENTS_TEST_HOME;
  process.env.ALLAGENTS_TEST_HOME = path;

  return () => {
    if (originalTestHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
    else process.env.ALLAGENTS_TEST_HOME = originalTestHome;
  };
}
