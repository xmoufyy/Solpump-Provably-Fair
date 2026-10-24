import { rmSync } from "node:fs";

/**
 * Removes a test's temp directory. On Windows, libSQL releases a database file only when its native
 * handles are garbage-collected (not at close()), so a just-closed file can still be locked; it is left
 * in the OS temp folder rather than failing the run.
 */
export function removeTempDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    if (!["EBUSY", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
  }
}
