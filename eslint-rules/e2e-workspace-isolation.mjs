/**
 * Custom ESLint rule: `e2e/workspace-isolation`.
 *
 * The web e2e suite gives every Playwright WORKER its own data server (see
 * packages/web/e2e/fixtures.ts), but tests that share a worker also share that
 * server's single workspace — and page names (rows are pages too) are
 * workspace-unique. Historically each spec avoided cross-test 409s by hand:
 * either by calling `reclaimNames()` to trash a fixed name first, or by
 * suffixing every name with `Date.now()`. Both are easy to forget, and the
 * classic failure is silent — the second test to claim a name renders 0 rows.
 *
 * The structural fix is the per-test `freshWorkspace` reset fixture: a spec opts
 * in with `test.use({freshWorkspace: true})` and then a clean workspace is
 * guaranteed before every test, so plain fixed names are safe. This rule keeps
 * the suite honest:
 *
 *   1. `reclaimNames()` may not be called from a spec — it is the obsolete
 *      manual workaround; opt into `freshWorkspace` instead.
 *   2. A raw `request.post(.../api/pages | .../rows, {data: {name: '<literal>'}})`
 *      with a hardcoded (non-templated) name is only allowed in a spec that has
 *      opted into `freshWorkspace`; otherwise it collides across tests.
 *
 * Templated names (`${tag}` / `${Date.now()}`) and the self-reclaiming
 * `newPage()` seed helper are unaffected.
 */

const messages = {
  noReclaim:
    'reclaimNames() is the obsolete manual name-collision workaround. Enable per-test workspace ' +
    'isolation with `test.use({freshWorkspace: true})` at module scope; pages and rows can then ' +
    'use plain fixed names safely.',
  hardcodedName:
    'Hardcoded page/row name {{name}} is workspace-unique and 409s across tests that share a ' +
    'worker (the second claimant silently renders 0 rows). Add `test.use({freshWorkspace: true})` ' +
    'to this spec for a per-test workspace reset, or derive a unique name (e.g. suffix Date.now()).',
};

function isIdentifier(node, name) {
  return Boolean(node) && node.type === 'Identifier' && node.name === name;
}

function stringLiteral(node) {
  return node && node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

/** Static text of a string/template-literal URL argument (drops interpolations). */
function staticUrl(node) {
  if (!node) return '';
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? '').join(' ');
  return '';
}

function findProperty(objectExpression, key) {
  if (!objectExpression || objectExpression.type !== 'ObjectExpression') return null;
  return (
    objectExpression.properties.find(
      (p) => p.type === 'Property' && !p.computed && isIdentifier(p.key, key),
    ) ?? null
  );
}

/** The literal `name` of a `{data: {name: '<literal>', ...}}` request body, if any. */
function bodyNameLiteral(arg) {
  const data = findProperty(arg, 'data');
  if (!data || data.value.type !== 'ObjectExpression') return null;
  const name = findProperty(data.value, 'name');
  return name ? stringLiteral(name.value) : null;
}

/** Does this call set `freshWorkspace: true` (i.e. `test.use({freshWorkspace: true})`)? */
function enablesFreshWorkspace(node) {
  const {callee} = node;
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    !isIdentifier(callee.object, 'test') ||
    !isIdentifier(callee.property, 'use')
  ) {
    return false;
  }
  const fw = findProperty(node.arguments[0], 'freshWorkspace');
  return Boolean(fw) && fw.value.type === 'Literal' && fw.value.value === true;
}

/** @type {import('eslint').Rule.RuleModule} */
const workspaceIsolation = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require structural per-test workspace isolation (freshWorkspace) instead of manual ' +
        'name-collision workarounds in Playwright e2e specs.',
    },
    schema: [],
    messages,
  },
  create(context) {
    let isolated = false;
    const pending = [];

    return {
      CallExpression(node) {
        const {callee} = node;

        // 1. reclaimNames(...) — always forbidden in a spec.
        if (isIdentifier(callee, 'reclaimNames')) {
          context.report({node, messageId: 'noReclaim'});
          return;
        }

        // test.use({freshWorkspace: true}) — records the opt-in.
        if (enablesFreshWorkspace(node)) {
          isolated = true;
          return;
        }

        // 2. request.post(<pages|rows url>, {data: {name: '<literal>'}}).
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          isIdentifier(callee.property, 'post')
        ) {
          const url = staticUrl(node.arguments[0]);
          if (url.includes('/api/pages') || url.includes('/rows')) {
            const literal = bodyNameLiteral(node.arguments[1]);
            if (literal !== null) pending.push({node, name: literal});
          }
        }
      },
      'Program:exit'() {
        if (isolated) return;
        for (const {node, name} of pending) {
          context.report({node, messageId: 'hardcodedName', data: {name: JSON.stringify(name)}});
        }
      },
    };
  },
};

export default {rules: {'workspace-isolation': workspaceIsolation}};
