const gridPx = String.raw`-?(?:4|6|8|10|12|16|20|24|28|32|36|40|44|48|56|64|80|96|112|128|144|160|176|192|208|224|240|256|288|320|384)px`;
const gridRem = String.raw`-?(?:0\.25|0\.375|0\.5|0\.625|0\.75|1|1\.25|1\.5|1\.75|2|2\.25|2\.5|2\.75|3|3\.5|4|5|6|7|8|9|10|11|12|13|14|15|16|18|20|24)rem`;
const variable = String.raw`var\([^)]*\)`;
const number = String.raw`-?(?:[0-9]*\.)?[0-9]+`;
const calcInitialAtom = String.raw`(?:${gridPx}|${gridRem}|${variable})`;
const calcOperand = String.raw`(?:${gridPx}|${gridRem}|${number}|${variable})`;
const calculation = String.raw`calc\(\s*${calcInitialAtom}(?:\s+[-+*/]\s+${calcOperand})*\s*\)`;
const percentage = String.raw`-?(?:[0-9]*\.)?[0-9]+%`;
const spacingAtom = String.raw`(?:0|auto|${gridPx}|${gridRem}|${percentage}|${variable}|${calculation})`;
const spacingValue = `/^${spacingAtom}(?:\\s+${spacingAtom}){0,3}$/`;
const radiusAtom = String.raw`(?:0|50%|999px|9999px|4px|6px|8px|${variable}|${calculation}|calc\(var\(--radius\) - 2px\))`;
const radiusValue = `/^${radiusAtom}(?:\\s+${radiusAtom}){0,3}$/`;

export default {
  // The package script intentionally passes only src/index.css; generated CSS
  // and component-local styles are owned by other spacing clusters.
  rules: {
    'declaration-property-value-allowed-list': {
      '/^(?:(?:padding|margin)(?:-(?:top|right|bottom|left|inline(?:-start|-end)?|block(?:-start|-end)?))?|gap|row-gap|column-gap)$/i': [
        spacingValue,
      ],
      'border-radius': [radiusValue],
    },
  },
  reportDescriptionlessDisables: true,
  reportInvalidScopeDisables: true,
  reportNeedlessDisables: true,
};
