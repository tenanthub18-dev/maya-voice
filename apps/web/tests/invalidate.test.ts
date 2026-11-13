import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {beforeEach, describe, expect, it, vi} from 'vitest';

const revalidatePath = vi.fn();
const setCookie = vi.fn();
const cookies = vi.fn(async () => ({set: setCookie}));
const invalidateModule = '@/lib/data/invalidate';

vi.mock('next/cache', () => ({revalidatePath}));
vi.mock('next/headers', () => ({cookies}));

async function actionFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await actionFiles(absolute));
    else if (entry.name === 'actions.ts') files.push(absolute);
  }
  return files;
}

beforeEach(() => {
  revalidatePath.mockReset();
  setCookie.mockReset();
  cookies.mockClear();
});

describe('write invalidation', () => {
  it('keeps direct Next.js cache invalidation out of server actions', async () => {
    const files = await actionFiles(path.join(process.cwd(), 'app'));
    const offenders: string[] = [];
    for (const file of files) {
      if (/from ['"]next\/cache['"]/u.test(await readFile(file, 'utf8'))) offenders.push(path.relative(process.cwd(), file));
    }
    expect(offenders).toEqual([]);
  });

  it('invalidates the root layout and rotates the live revision cookie after every write', async () => {
    const {invalidateAfterWrite} = await import(invalidateModule);

    await invalidateAfterWrite();
    await invalidateAfterWrite();

    expect(revalidatePath).toHaveBeenNthCalledWith(1, '/', 'layout');
    expect(revalidatePath).toHaveBeenNthCalledWith(2, '/', 'layout');
    expect(cookies).toHaveBeenCalledTimes(2);
    expect(setCookie).toHaveBeenCalledTimes(2);
    const [first, second] = setCookie.mock.calls.map(([options]) => options as Record<string, unknown>);
    expect(first).toMatchObject({name: 'live-rev', httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 86_400});
    expect(second).toMatchObject({name: 'live-rev', httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 86_400});
    expect(first.value).toEqual(expect.any(String));
    expect(second.value).toEqual(expect.any(String));
    expect(first.value).not.toBe(second.value);
  });
});
