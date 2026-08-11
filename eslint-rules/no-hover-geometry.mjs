/**
 * Custom ESLint rule: `layout-shift/no-hover-geometry`.
 *
 * Hovering must never change an element's geometry. Tailwind display, spacing,
 * sizing, weight, border-width, scale, and translation utilities are therefore
 * forbidden behind `hover:` and `group-hover:` variants. Paint-only reveals
 * such as `group-hover:opacity-100` remain valid.
 */

const HOVER_VARIANT = /(?:^|:)(?:hover|group-hover(?:\/[^:\s]+)?):/;

function changesGeometry(className) {
  if (!HOVER_VARIANT.test(className)) return false;

  const utility = className.slice(className.lastIndexOf(':') + 1).replace(/^!/, '').replace(/^-/, '');
  return (
    /^(?:hidden|block|flex|grid)$/.test(utility) ||
    /^inline(?:-|$)/.test(utility) ||
    /^(?:p[trblxyse]?|m[trblxyse]?)-/.test(utility) ||
    /^(?:w|h|size|gap)-/.test(utility) ||
    /^font-(?:bold|semibold|medium)$/.test(utility) ||
    /^text-(?:xs|sm|base|lg|xl)(?:\/|$)/.test(utility) ||
    /^border-\d/.test(utility) ||
    /^(?:scale|translate)-/.test(utility)
  );
}

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
export const noHoverGeometry = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow hover-variant Tailwind utilities that change element geometry.',
    },
    schema: [],
    messages: {
      geometry:
        'Hover utility {{className}} changes geometry and can shift layout. Keep it in flow and reveal it with opacity or another paint-only property.',
    },
  },
  create(context) {
    function check(node, value) {
      if (!enclosingClassName(node)) return;
      for (const className of value.split(/\s+/).filter(Boolean)) {
        if (changesGeometry(className)) {
          context.report({node, messageId: 'geometry', data: {className}});
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
    };
  },
};

export default {rules: {'no-hover-geometry': noHoverGeometry}};
