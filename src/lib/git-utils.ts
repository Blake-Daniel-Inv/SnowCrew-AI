import { execSync } from 'child_process';
import path from 'path';
import { isContainerMode } from './config';

const MAX_PATH_LENGTH = 4096;

export function isGitRepo(dirPath: string): boolean {
  // Skip git validation in container/SPCS environments
  if (isContainerMode()) {
    return true;
  }

  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: dirPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveRepoPath(inputPath: string): string {
  if (typeof inputPath !== 'string') {
    throw new Error('repoPath must be a string');
  }
  if (inputPath.length > MAX_PATH_LENGTH) {
    throw new Error(`repoPath exceeds maximum length (${MAX_PATH_LENGTH})`);
  }
  if (inputPath.includes('\0')) {
    throw new Error('repoPath must not contain null bytes');
  }
  const expanded = inputPath.startsWith('~')
    ? path.join(process.env.HOME || '', inputPath.slice(1))
    : path.resolve(inputPath);
  if (expanded.trim().length === 0) {
    throw new Error('repoPath must not be empty');
  }
  return expanded;
}
