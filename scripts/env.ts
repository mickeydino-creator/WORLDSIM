// Minimal .env loader for scripts and the custom server (Next loads .env itself for its own runtime).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnv() {
  for (const name of ['.env.local', '.env']) {
    const path = join(process.cwd(), name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
}
