import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

import {describe, expect, it} from 'vitest';

import {stripBidiControls} from '@/lib/security/text';
import {renderNotification} from '@/lib/notifications/templates';

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (/\.[cm]?[jt]sx?$/u.test(entry.name)) files.push(absolute);
  }
  return files;
}

describe('untrusted text handling', () => {
  it('contains no raw HTML rendering escape hatch in production web code', async () => {
    const roots = ['app', 'components', 'lib'].map((root) => path.resolve(process.cwd(), root));
    for (const file of (await Promise.all(roots.map(sourceFiles))).flat()) {
      expect(await readFile(file, 'utf8'), file).not.toContain('dangerouslySetInnerHTML');
    }
  });

  it('removes bidi override and isolate controls while preserving multilingual text', () => {
    expect(stripBidiControls('Caller\u202Egpj.exe\u202C — اردو \u2066safe\u2069'))
      .toBe('Callergpj.exe — اردو safe');
  });

  it('escapes untrusted restaurant names and alert text in email HTML', () => {
    const message = renderNotification('en', 'message_taken', {
      restaurantName: '<img src=x onerror=alert(1)>',
      detail: '<script>alert(1)</script>',
    });
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toContain('<img');
    expect(message.html).toContain('&lt;script&gt;');
  });
});
