/**
 * Absolute-path checks for secret roots and credential directories.
 *
 * Several stores validated their root with `path.startsWith("/")`. That is only correct
 * on POSIX, and it broke Windows in two separate ways:
 *
 * 1. A native Windows root (`C:\...`) was rejected outright.
 * 2. A POSIX root that had been through `path.join` was also rejected. On Windows,
 *    `join("/opt/x", "..", "voice-secrets")` returns `\opt\voice-secrets`, so the
 *    leading `/` became `\` and the check failed even though the path was absolute.
 *
 * A drive-rooted path and a root-relative path are both absolute on Windows, so both are
 * accepted there. A POSIX-style `/c/...` path is deliberately *not* treated as absolute
 * on Windows: Node resolves it against the current drive (to `C:\c\...`), which would
 * silently create the credential directory somewhere unrelated.
 */

const windowsAbsolute = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]|[\\/])/;

/** True when `path` is absolute for the current platform. */
export function isAbsoluteFilesystemPath(path: string): boolean {
  if (path.startsWith("/")) return true;
  if (process.platform !== "win32") return false;
  // `\\server\share` (UNC), `C:\dir`, and `\dir` are all absolute on Windows.
  return windowsAbsolute.test(path);
}
