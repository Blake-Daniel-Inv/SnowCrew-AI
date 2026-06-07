import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getConfigDir } from './config';
import { withFileLock } from './file-lock';

export function ensureDataDir(directoryName: string): string {
  const dirPath = path.join(getConfigDir(), directoryName);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Atomic write: write to a tempfile in the same directory, fsync it,
 * rename into place, then fsync the parent directory. `rename` is atomic
 * on POSIX filesystems, and the directory fsync ensures the rename
 * itself survives a power loss.
 */
function atomicWrite(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const suffix = crypto.randomBytes(8).toString('hex');
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${suffix}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* noop */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* noop */
    }
    throw err;
  }
  let dirFd: number | null = null;
  try {
    dirFd = fs.openSync(directory, 'r');
    fs.fsyncSync(dirFd);
  } catch {
    /* directory fsync best-effort; some platforms (e.g. Windows) don't support it */
  } finally {
    if (dirFd != null) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* noop */
      }
    }
  }
}

/**
 * Read, modify, and write a JSON file under a per-path lock. Concurrent
 * callers for the same path are serialized so no update is lost.
 *
 * If the file exists but is unparseable, it is quarantined (renamed with
 * a .corrupt-<ts> suffix) and the caller is thrown an error. We never
 * silently apply the mutator to `fallback` over a corrupt file — that
 * would wipe whatever recoverable data is on disk.
 */
export async function mutateJsonFile<T>(
  filePath: string,
  fallback: T,
  mutator: (current: T) => T
): Promise<T> {
  return withFileLock(filePath, () => {
    let current: T;
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      try {
        current = JSON.parse(raw) as T;
      } catch (err) {
        const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
        fs.renameSync(filePath, quarantinePath);
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Refusing to overwrite unparseable JSON at ${filePath}; quarantined to ${quarantinePath}: ${message}`
        );
      }
    } else {
      current = fallback;
    }
    const next = mutator(current);
    atomicWrite(filePath, JSON.stringify(next, null, 2));
    return next;
  });
}
