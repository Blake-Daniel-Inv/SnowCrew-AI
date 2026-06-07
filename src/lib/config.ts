import fs from 'fs';
import path from 'path';

const APP_DIR_NAME = '.crewai-studio-local';

export function getConfigDir(): string {
  // In SPCS / Docker, DATA_DIR points to a mounted Snowflake stage volume
  // so workspace data persists across container restarts.
  const dataDir = process.env.DATA_DIR;
  if (dataDir) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    return dataDir;
  }

  // Local development fallback
  const home = process.env.HOME || process.cwd();
  const dirPath = path.join(home, APP_DIR_NAME);

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  return dirPath;
}

/**
 * True when running inside a container (SPCS, Docker, etc.).
 * Mirrors the middleware check so server and lib agree on mode.
 * `NEXT_PUBLIC_CONTAINER_MODE` is included so a build that set only
 * the public flag still works; presence of `DATA_DIR` (set by the
 * SPCS image entrypoint) is also sufficient.
 */
export function isContainerMode(): boolean {
  return (
    process.env.NEXT_PUBLIC_CONTAINER_MODE === '1' ||
    process.env.CONTAINER_MODE === '1' ||
    Boolean(process.env.DATA_DIR)
  );
}
