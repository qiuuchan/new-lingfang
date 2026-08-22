import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const PLUGIN_README_MAX_BYTES = 256 * 1024;

export type ReadmeValidationError = {
  code: 'readme_too_large' | 'readme_invalid_utf8';
  path: string;
  message: string;
};

/** Validate the exact root README.md using the same boundary as the registry. */
export function validateRootReadme(pluginPath: string): ReadmeValidationError | null {
  const readmePath = path.join(pluginPath, 'README.md');
  if (!existsSync(readmePath)) return null;
  const bytes = readFileSync(readmePath);
  if (bytes.length > PLUGIN_README_MAX_BYTES) {
    return { code: 'readme_too_large', path: 'README.md', message: 'README.md 不能超过 256 KiB' };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      code: 'readme_invalid_utf8',
      path: 'README.md',
      message: 'README.md 必须是 UTF-8 文本',
    };
  }
  return null;
}
