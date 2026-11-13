import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

function files(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('caller number storage invariant', () => {
  it('keeps raw caller numbers out of the calls schema and calls repository inserts', () => {
    const root = join(process.cwd(), '..', '..');
    const migrationText = files(join(root, 'supabase', 'migrations')).filter((path) => path.endsWith('.sql'))
      .map((path) => readFileSync(path, 'utf8')).join('\n');
    const callsTable = migrationText.match(/create table public\.calls\s*\(([\s\S]*?)\n\);/u)?.[1] ?? '';
    expect(callsTable).toContain('from_e164_hash');
    expect(callsTable).toContain('from_last4');
    expect(callsTable).not.toMatch(/\bfrom_(?:e164|phone)\b|caller_phone_e164/u);

    const repositoryText = files(join(root, 'apps')).filter((path) => /\.(?:ts|py)$/u.test(path) && !path.includes('/tests/'))
      .map((path) => readFileSync(path, 'utf8')).join('\n');
    const inserts = [...repositoryText.matchAll(/(?:from\(['"]calls['"]\)|table\(['"]calls['"]\))[\s\S]{0,500}?insert\(([^;]+)\)/gu)];
    expect(inserts.map((match) => match[1]).join('\n')).not.toMatch(/from_e164\b|caller_phone|phone_e164/u);
  });
});
