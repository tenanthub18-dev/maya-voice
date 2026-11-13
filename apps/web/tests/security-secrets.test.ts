import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {describe, expect, it} from 'vitest';

// @ts-expect-error The production scanner is an executable JavaScript module.
import {scanClientArtifacts} from '../scripts/check-client-secrets.mjs';

describe('client bundle secret scanner', () => {
  it('passes clean client artifacts and reports service-role markers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'client-bundle-'));
    const staticDirectory = path.join(root, 'static/chunks');
    await mkdir(staticDirectory, {recursive: true});
    await writeFile(path.join(staticDirectory, 'clean.js'), 'console.log("client")', 'utf8');
    await expect(scanClientArtifacts(root)).resolves.toEqual([]);

    await writeFile(path.join(staticDirectory, 'leak.js'), 'const role="service_role";', 'utf8');
    await expect(scanClientArtifacts(root)).resolves.toEqual([path.join(staticDirectory, 'leak.js')]);
  });
});
