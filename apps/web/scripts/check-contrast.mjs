import {readFileSync} from 'node:fs';

const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');

function tokens(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/giu)].map((match) => [match[1], match[2]]));
}

const lightBlock = css.match(/:root\s*\{([^}]*)\}/u)?.[1] ?? '';
const darkBlock = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/u)?.[1] ?? '';
const themes = {light: tokens(lightBlock), dark: tokens(darkBlock)};

function luminance(hex) {
  const channels = hex.match(/[\da-f]{2}/giu)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  if (linear.length !== 3) throw new Error(`Invalid colour: ${hex}`);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const textPairs = [
  ['text', 'background'], ['text', 'surface'], ['text', 'surface-raised'],
  ['muted', 'background'], ['muted', 'surface'], ['accent-strong', 'surface'],
  ['success', 'surface'], ['warning', 'surface'], ['danger', 'surface'], ['on-accent', 'accent'],
];
const uiPairs = [
  ['border', 'background'], ['border', 'surface'], ['border', 'surface-raised'],
  ['accent', 'background'], ['accent', 'surface'],
];
const failures = [];

for (const [theme, values] of Object.entries(themes)) {
  for (const [foreground, background] of textPairs) {
    const ratio = contrast(values[foreground], values[background]);
    if (ratio < 4.5) failures.push(`${theme}: --${foreground} on --${background} is ${ratio.toFixed(2)}:1 (needs 4.5:1)`);
  }
  for (const [foreground, background] of uiPairs) {
    const ratio = contrast(values[foreground], values[background]);
    if (ratio < 3) failures.push(`${theme}: --${foreground} on --${background} is ${ratio.toFixed(2)}:1 (needs 3:1)`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('WCAG AA contrast checks passed for light and dark theme tokens.');
}
