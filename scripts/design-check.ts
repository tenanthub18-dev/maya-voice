import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';

type Theme = 'light' | 'dark';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const tokenPath = `${repositoryRoot}/apps/web/styles/tokens.css`;
const primitivePath = `${repositoryRoot}/apps/web/components/ui/index.tsx`;

const requiredPairs = [
  ['--color-text', '--color-canvas'],
  ['--color-text', '--color-surface'],
  ['--color-text-muted', '--color-canvas'],
  ['--color-text-muted', '--color-surface'],
  ['--color-accent', '--color-canvas'],
  ['--color-accent', '--color-surface'],
  ['--color-on-accent', '--color-accent'],
  ['--color-success', '--color-surface'],
  ['--color-warning', '--color-surface'],
  ['--color-danger', '--color-surface'],
] as const;

export function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  if (!channels || channels.length !== 3) throw new Error(`Expected a six-digit hex colour, received ${hex}`);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

export function readThemeTokens(css: string, theme: Theme): Map<string, string> {
  const selector = theme === 'light' ? ':root' : "[data-theme='dark']";
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Missing ${selector} token block`);
  const end = css.indexOf('\n}', start);
  if (end === -1) throw new Error(`Unclosed ${selector} token block`);
  const tokens = new Map<string, string>();
  for (const match of css.slice(start, end).matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6});/g)) tokens.set(match[1], match[2].toLowerCase());
  return tokens;
}

export function contrastViolations(css: string): string[] {
  const failures: string[] = [];
  for (const theme of ['light', 'dark'] as const) {
    const tokens = readThemeTokens(css, theme);
    for (const [foregroundName, backgroundName] of requiredPairs) {
      const foreground = tokens.get(foregroundName);
      const background = tokens.get(backgroundName);
      if (!foreground || !background) {
        failures.push(`${theme}: missing ${!foreground ? foregroundName : backgroundName}`);
        continue;
      }
      const ratio = contrastRatio(foreground, background);
      if (ratio < 4.5) failures.push(`${theme}: ${foregroundName} on ${backgroundName} is ${ratio.toFixed(2)}:1`);
    }
  }
  return failures;
}

export function tapTargetViolations(source: string): string[] {
  const failures: string[] = [];
  for (const primitive of ['buttonBase', 'iconButtonBase', 'inputBase', 'selectBase', 'switchBase', 'tabsTriggerBase']) {
    const declaration = source.match(new RegExp(`const ${primitive} = ([^;]+);`))?.[1] ?? '';
    if (!declaration.includes('min-h-11')) failures.push(`${primitive} lacks a 44px minimum height`);
  }
  const iconDeclaration = source.match(/const iconButtonBase = ([^;]+);/)?.[1] ?? '';
  if (!iconDeclaration.includes('min-w-11')) failures.push('iconButtonBase lacks a 44px minimum width');
  return failures;
}

describe('design system quality gate', () => {
  test('semantic colour roles meet WCAG AA in light and dark themes', () => {
    expect(contrastViolations(readFileSync(tokenPath, 'utf8'))).toEqual([]);
  });

  test('interactive primitives guarantee a 44px tap target', () => {
    expect(tapTargetViolations(readFileSync(primitivePath, 'utf8'))).toEqual([]);
  });
});
