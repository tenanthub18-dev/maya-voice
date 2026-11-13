import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const forbidden = /service_role|sb_secret_/iu;

async function filesUnder(directory) {
  const files = [];
  try {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await filesUnder(absolute));
      else files.push(absolute);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return files;
}

export async function scanClientArtifacts(nextDirectory) {
  const candidates = await filesUnder(path.join(nextDirectory, 'static'));
  for (const manifest of [
    path.join(nextDirectory, 'build-manifest.json'),
    path.join(nextDirectory, 'app-build-manifest.json'),
  ]) {
    try { await readFile(manifest); candidates.push(manifest); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const leaks = [];
  for (const file of candidates) {
    if (forbidden.test(await readFile(file, 'utf8'))) leaks.push(file);
  }
  return leaks.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const nextDirectory = path.resolve(process.cwd(), process.argv[2] ?? '.next');
  const leaks = await scanClientArtifacts(nextDirectory);
  if (leaks.length) {
    console.error(`Secret-like service-role markers found in client artifacts:\n${leaks.join('\n')}`);
    process.exitCode = 1;
  }
}
