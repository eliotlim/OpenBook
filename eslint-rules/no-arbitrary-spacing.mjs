/**
 * Custom ESLint rule: `tailwind/no-arbitrary-spacing`.
 *
 * Product spacing stays on Tailwind's shared scale. Arbitrary values for
 * padding, margin, gap, space, and scroll-spacing utilities are forbidden in
 * JSX className strings and conventionally named hoisted class/style values;
 * arbitrary values for non-spacing properties remain available.
 */

const ARBITRARY_SPACING =
  /(?:^|:)-?(?:p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?|space-[xy]|scroll-[pm][trblxyse]?)-(?:\[[^\]\s]+\]|\(--[^)\s]+\))!?$/;
const CLASS_VALUE_KEY = /class(Name)?|CLASS|styles?/i;

function keyName(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function hasClassValueContext(node) {
  let current = node.parent;
  while (current) {
    if (current.type === 'JSXAttribute') {
      return current.name.type === 'JSXIdentifier' && current.name.name === 'className';
    }
    if (current.type === 'JSXElement' || current.type === 'JSXFragment') return false;
    if (current.type === 'VariableDeclarator' && keyName(current.id)?.match(CLASS_VALUE_KEY)) return true;
    if (current.type === 'Property' && keyName(current.key)?.match(CLASS_VALUE_KEY)) return true;
    current = current.parent;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noArbitrarySpacing = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow arbitrary Tailwind spacing values in className and named class/style values.',
    },
    schema: [],
    messages: {
      arbitrary:
        'Spacing utility {{className}} uses an arbitrary value. Use the nearest Tailwind spacing-scale utility instead. If no scale utility fits, add an eslint-disable comment with a reason.',
    },
  },
  create(context) {
    function check(node, value) {
      if (!hasClassValueContext(node)) return;
      for (const className of value.split(/\s+/).filter(Boolean)) {
        if (!className.includes('env(') && ARBITRARY_SPACING.test(className)) {
          context.report({node, messageId: 'arbitrary', data: {className}});
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateLiteral(node) {
        const value = node.quasis
          .map(
            (quasi, index) =>
              `${quasi.value.cooked ?? quasi.value.raw}${index < node.expressions.length ? '${}' : ''}`,
          )
          .join('');
        check(node, value);
      },
    };
  },
};

export default {rules: {'no-arbitrary-spacing': noArbitrarySpacing}};
