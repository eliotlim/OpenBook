/**
 * Custom ESLint rule: `tailwind/no-arbitrary-spacing`.
 *
 * Product spacing stays on Tailwind's shared scale. Arbitrary bracket values
 * for padding, margin, and gap utilities are forbidden in JSX className
 * strings; arbitrary values for non-spacing properties remain available.
 */

const ARBITRARY_SPACING = /(?:^|:)!?-?(?:p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?)-\[[^\]\s]+\]$/;

function enclosingClassName(node) {
  let current = node.parent;
  while (current) {
    if (current.type === 'JSXAttribute') {
      return current.name.type === 'JSXIdentifier' && current.name.name === 'className' ? current : null;
    }
    if (current.type === 'JSXElement' || current.type === 'JSXFragment') return null;
    current = current.parent;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noArbitrarySpacing = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow arbitrary Tailwind padding, margin, and gap values in className.',
    },
    schema: [],
    messages: {
      arbitrary:
        'Spacing utility {{className}} uses an arbitrary value. Use the nearest Tailwind spacing-scale utility instead.',
    },
  },
  create(context) {
    function check(node, value) {
      if (!enclosingClassName(node)) return;
      for (const className of value.split(/\s+/).filter(Boolean)) {
        if (ARBITRARY_SPACING.test(className)) {
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
