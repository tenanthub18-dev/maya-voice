import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import ts from 'typescript';
import {describe, expect, it} from 'vitest';

import en from '@/messages/en.json';
import fr from '@/messages/fr.json';

function keys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
}

function renderedStringLiterals(expression: ts.Expression, constants: ReadonlyMap<string, ts.Expression>, seen = new Set<string>()): ts.StringLiteralLike[] {
  if (ts.isStringLiteralLike(expression)) return [expression];
  if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
    const value = constants.get(expression.text);
    if (value) return renderedStringLiterals(value, constants, new Set([...seen, expression.text]));
  }
  if (ts.isParenthesizedExpression(expression)) return renderedStringLiterals(expression.expression, constants, seen);
  if (ts.isConditionalExpression(expression)) {
    return [...renderedStringLiterals(expression.whenTrue, constants, seen), ...renderedStringLiterals(expression.whenFalse, constants, seen)];
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return renderedStringLiterals(expression.right, constants, seen);
  }
  return [];
}

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? tsxFiles(path) : entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function containsMessageProperty(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'message') return true;
  let found = false;
  ts.forEachChild(node, (child) => { if (!found && containsMessageProperty(child)) found = true; });
  return found;
}

describe('translation contract', () => {
  it('keeps English and French message key sets identical', () => {
    expect(keys(fr).sort()).toEqual(keys(en).sort());
  });

  it('discloses owner browser AI, review text/usage and no audio storage in EN and FR', () => {
    for (const screen of ['onboarding', 'agent'] as const) {
      const english = en.screens[screen].testCall.testMode;
      const french = fr.screens[screen].testCall.testMode;
      expect(english).toContain('AI assistant');
      expect(english).toContain('Call text and usage may be saved for review');
      expect(english).toContain('audio is not stored');
      expect(english).toContain('Practice orders and bookings are not saved or texted');
      expect(french).toContain('assistant IA');
      expect(french).toContain('texte de l’appel et les données d’utilisation');
      expect(french).toContain('l’audio n’est pas conservé');
      expect(french).toContain('pratique ne sont pas enregistrées et aucun SMS');
    }
  });

  it('does not ship hard-coded user-visible strings in TSX', () => {
    const root = join(process.cwd());
    const files = [...tsxFiles(join(root, 'app')), ...tsxFiles(join(root, 'components'))];
    const failures: string[] = [];

    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const constants = new Map<string, ts.Expression>();
      const collectConstants = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) constants.set(node.name.text, node.initializer);
        ts.forEachChild(node, collectConstants);
      };
      collectConstants(source);
      const inspect = (node: ts.Node): void => {
        if (ts.isJsxText(node) && /[A-Za-z]/u.test(node.text)) {
          failures.push(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} text ${JSON.stringify(node.text.trim())}`);
        }
        if (ts.isJsxAttribute(node) && ['aria-label', 'placeholder', 'title'].includes(node.name.getText(source)) && node.initializer && ts.isStringLiteral(node.initializer) && /[A-Za-z]/u.test(node.initializer.text)) {
          failures.push(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${node.name.getText(source)} ${JSON.stringify(node.initializer.text)}`);
        }
        if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
          for (const literal of renderedStringLiterals(node.expression, constants)) {
            if (/[A-Za-z]/u.test(literal.text)) failures.push(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(literal.getStart()).line + 1} expression ${JSON.stringify(literal.text)}`);
          }
        }
        if (ts.isJsxAttribute(node) && ['aria-label', 'placeholder', 'title'].includes(node.name.getText(source)) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          for (const literal of renderedStringLiterals(node.initializer.expression, constants)) {
            if (/[A-Za-z]/u.test(literal.text)) failures.push(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(literal.getStart()).line + 1} ${node.name.getText(source)} ${JSON.stringify(literal.text)}`);
          }
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^setError$/u.test(node.expression.text)) {
          const argument = node.arguments[0];
          if (argument && containsMessageProperty(argument)) {
            failures.push(`${relative(root, file)}:${source.getLineAndCharacterOfPosition(argument.getStart()).line + 1} raw API error message`);
          }
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }

    expect(failures).toEqual([]);
  });
});
