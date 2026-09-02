/** tsc only emits .js — SQL migrations are read at runtime, so copy them into dist/. */
import { cpSync, mkdirSync } from 'node:fs';

const from = 'server/src/db/migrations';
const to = 'dist/server/src/db/migrations';
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copied ${from} -> ${to}`);
