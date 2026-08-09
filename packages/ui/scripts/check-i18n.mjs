#!/usr/bin/env node

import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const LOCALES = ['en', 'de', 'ja', 'zh'];
const MESSAGES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n', 'messages');

const unwrap = (expression) => {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const propertyName = (name, sourceFile) => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  throw new Error(`${sourceFile.fileName}: unsupported catalog key ${name.getText(sourceFile)}`);
};

const flattenObject = (object, sourceFile, prefix = '', keys = []) => {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${sourceFile.fileName}: unsupported catalog property ${property.getText(sourceFile)}`);
    }

    const name = propertyName(property.name, sourceFile);
    const key = prefix ? `${prefix}.${name}` : name;
    const value = unwrap(property.initializer);
    if (ts.isObjectLiteralExpression(value)) flattenObject(value, sourceFile, key, keys);
    else keys.push(key);
  }
  return keys;
};

const catalogKeys = (locale) => {
  const fileName = resolve(MESSAGES_DIR, `${locale}.ts`);
  const sourceFile = ts.createSourceFile(
    fileName,
    readFileSync(fileName, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== locale || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (!ts.isObjectLiteralExpression(initializer)) {
        throw new Error(`${fileName}: exported catalog ${locale} is not an object literal`);
      }
      return flattenObject(initializer, sourceFile);
    }
  }

  throw new Error(`${fileName}: could not find catalog ${locale}`);
};

const keysByLocale = Object.fromEntries(LOCALES.map((locale) => [locale, new Set(catalogKeys(locale))]));
const englishKeys = keysByLocale.en;

console.log(`i18n parity (English source: ${englishKeys.size} keys)`);
for (const locale of LOCALES) {
  const keys = keysByLocale[locale];
  const missing = [...englishKeys].filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !englishKeys.has(key));
  const namespaces = new Map();
  for (const key of missing) {
    const namespace = key.split('.')[0];
    namespaces.set(namespace, (namespaces.get(namespace) ?? 0) + 1);
  }
  const topMissing = [...namespaces]
    .sort(([a, aCount], [b, bCount]) => bCount - aCount || a.localeCompare(b))
    .slice(0, 5)
    .map(([namespace, count]) => `${namespace} (${count})`)
    .join(', ');

  console.log(`${locale}: missing ${missing.length}, extra ${extra.length}`);
  console.log(`  top missing namespaces: ${topMissing || 'none'}`);
}
