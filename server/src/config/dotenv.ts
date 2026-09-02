import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Tiny .env loader (no dependency). Values already present in the real
 * environment always win, so Docker/CI configuration is never overridden.
 */
export function loadDotEnv(file = '.env'): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
