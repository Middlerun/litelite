// @ts-check
'use strict';

// Generates themes/litelite-color-theme.json. Edit colours and rules here rather than in the
// generated file. Run with `npm run build-theme`.

const fs = require('fs');
const path = require('path');
const jsonc = require('jsonc-parser');

const VSCODE_THEMES = '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/theme-defaults/themes';
const OUTPUT = path.join(__dirname, '..', 'themes', 'litelite-color-theme.json');

/** @param {string} file */
function loadBuiltInTheme(file) {
  return jsonc.parse(fs.readFileSync(path.join(VSCODE_THEMES, file), 'utf8'), [], { allowTrailingComma: true });
}

// Workbench colours are copied from Light 2026's include chain, since a theme can't include
// files from another extension. Lowercased to match how VS Code's colour picker writes hex values.
/** @type {Record<string, string>} */
const colors = {};
for (const file of ['light_vs.json', 'light_plus.json', 'light_modern.json', '2026-light.json']) {
  for (const [key, value] of Object.entries(loadBuiltInTheme(file).colors ?? {})) {
    colors[key] = typeof value === 'string' ? value.toLowerCase() : value;
  }
}

const TEXT = '#202020';
const TYPE = '#9333ea';
const KEYWORD = '#a3a3a3';
const PUNCT = '#939393';
const CONTROL = '#a31515';
const DECL = '#000000';
const STRING = '#009c39';
const COMMENT = '#1f55d6';

// Token backgrounds: VS Code ignores these, the bundled extension draws them.
// Translucent so selections and find matches show through.
const CONTROL_BG = '#e028281b';
const DECL_BG = '#ffdd004c';
const TYPE_BG = '#9333ea1c';
const COMMENT_BG = '#2f6feb1f';
// Explicitly clears a background inherited from a parent scope or less specific rule
const NO_BG = '#00000000';

Object.assign(colors, {
  'editor.foreground': TEXT,
  // Bracket pair colourisation would otherwise override the punctuation grey
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`editorBracketHighlight.foreground${i}`, PUNCT])),
  'editorBracketHighlight.unexpectedBracket.foreground': CONTROL,
});

/**
 * @param {string} name
 * @param {string | string[]} scope
 * @param {string} foreground
 * @param {{ background?: string, fontStyle?: string }} [options]
 */
function rule(name, scope, foreground, { background, fontStyle } = {}) {
  /** @type {Record<string, string>} */
  const settings = { foreground };
  if (background !== undefined) settings.background = background;
  if (fontStyle !== undefined) settings.fontStyle = fontStyle;
  return { name, scope, settings };
}

/** @type {Array<{ name?: string, scope?: string | string[], settings: Record<string, string> }>} */
const tokenColors = [
  { settings: { foreground: TEXT } },

  rule('Punctuation and operators', [
    'punctuation', 'meta.brace', 'keyword.operator', 'storage.type.function.arrow',
    'punctuation.definition.template-expression',
  ], PUNCT),

  rule('Keywords', [
    'keyword', 'storage', 'storage.type', 'storage.modifier',
    'keyword.control.import', 'keyword.control.export', 'keyword.control.default',
    'keyword.control.from', 'keyword.control.as', 'keyword.control.type',
    'keyword.control.require', 'keyword.control.satisfies', 'keyword.control.new',
    'keyword.control.directive', 'keyword.control.module', 'keyword.control.intrinsic',
    'keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.word',
    'keyword.operator.logical.python', 'keyword.operator.sizeof', 'keyword.operator.alignof',
    'keyword.operator.cast', 'keyword.operator.type.asserts',
    'keyword.other',
  ], KEYWORD, { background: NO_BG }),

  rule('Control flow', [
    'keyword.control', 'keyword.control.flow', 'keyword.control.conditional',
    'keyword.control.loop', 'keyword.control.switch', 'keyword.control.trycatch',
    'keyword.control.exception', 'keyword.control.with', 'keyword.control.assert',
    'keyword.operator.ternary',
  ], CONTROL, { background: CONTROL_BG }),

  // Type usages stay near-black; only declarations are purple
  rule('Type declarations', [
    'entity.name.type.interface', 'entity.name.type.alias', 'entity.name.type.enum',
    'entity.name.type.struct', 'entity.name.type.trait', 'entity.name.type.union',
    'entity.name.interface', 'entity.name.struct', 'entity.name.enum', 'entity.name.trait',
    'entity.name.union',
  ], TYPE, { background: TYPE_BG, fontStyle: 'bold' }),

  // TextMate can't tell top-level from nested declarations; semantic tokens refine this
  rule('Declarations (fallback without semantic highlighting)', [
    'meta.definition.function entity.name.function',
    'meta.definition.variable entity.name.function',
    'meta.definition.variable variable.other.constant',
    'meta.definition.variable variable.other.readwrite',
    'entity.name.type.class', 'entity.name.class',
    // entity.name.type.module alone also matches qualifiers like `React` in `React.Component`
    'meta.namespace.declaration entity.name.type.module',
    'entity.name.function.python',
    'entity.name.type.class.python',
  ], DECL, { background: DECL_BG, fontStyle: 'bold' }),

  rule('Near-black overrides', [
    'entity.name.tag', 'support.class.component', 'support.class.console',
    'meta.template.expression', 'meta.embedded', 'variable.parameter',
    'entity.name.type.module.go', 'entity.name.package.go',
    'string meta.template.expression',
  ], TEXT),

  rule('Strings', [
    'string', 'punctuation.definition.string', 'string punctuation.definition.string',
    'string.regexp', 'string.template', 'constant.character.escape',
    'support.type.property-name.json', 'punctuation.support.type.property-name',
    'string.quoted.docstring',
  ], STRING),

  // The explicit empty font style stops declaration scopes repeated under `comment` (below) inheriting bold
  rule('Comments', [
    'comment', 'punctuation.definition.comment', 'string.comment',
    'comment storage', 'comment keyword', 'comment punctuation', 'comment entity',
    'comment variable', 'comment support', 'comment constant', 'comment markup',
    'comment string', 'comment source',
  ], COMMENT, { background: COMMENT_BG, fontStyle: '' }),

  rule('Invalid', ['invalid', 'invalid.illegal', 'invalid.deprecated'], '#cd3131', { fontStyle: 'italic' }),
  rule('Markup emphasis', 'markup.italic', TEXT, { fontStyle: 'italic' }),
  rule('Markup strong', 'markup.bold', TEXT, { fontStyle: 'bold' }),
  rule('Markup heading', ['markup.heading', 'markup.heading entity.name'], TEXT, { fontStyle: 'bold' }),
  rule('Markup strikethrough', 'markup.strikethrough', TEXT, { fontStyle: 'strikethrough' }),
];

// Rules matching more of a token's own scope beat rules matching enclosing scopes, so
// `storage.type` would win over `comment storage` for JSDoc tags like `@param`. Repeating
// every other rule's scopes under `comment` keeps everything inside comments blue.
const commentScopes = /** @type {string[]} */ (tokenColors.find((r) => r.name === 'Comments')?.scope);
for (const r of tokenColors) {
  if (r.name === 'Comments' || !r.scope) continue;
  for (const scope of [r.scope].flat()) {
    const prefixed = `comment ${scope}`;
    if (!scope.startsWith('comment') && !commentScopes.includes(prefixed)) commentScopes.push(prefixed);
  }
}

/**
 * @param {string[]} types
 * @param {object} style
 */
const declarations = (types, style) => Object.fromEntries(types.map((type) => [`${type}.declaration`, style]));

const semanticTokenColors = {
  // When no semantic rule sets a style property, VS Code falls back to the TextMate rule for a
  // matching scope, e.g. `class` -> entity.name.type.class, which would make references to
  // classes like `Date` bold. Setting an empty font style on every token stops that.
  '*': { fontStyle: '' },

  // Everything defaults to near-black so semantic tokens override TextMate guesses
  variable: TEXT, parameter: TEXT, property: TEXT, function: TEXT, method: TEXT,
  enumMember: TEXT, namespace: TEXT, event: TEXT, label: TEXT, macro: TEXT,
  decorator: TEXT,

  class: TEXT, interface: TEXT, type: TEXT, enum: TEXT, typeParameter: TEXT,
  struct: TEXT, builtinType: TEXT, typeAlias: TEXT, union: TEXT, trait: TEXT,
  selfTypeKeyword: TEXT,

  // Top-level declarations (TypeScript marks nested ones with `local`)
  ...declarations(['variable', 'function', 'class', 'namespace'], { foreground: DECL, background: DECL_BG, fontStyle: 'bold' }),
  // Type declarations are purple instead
  ...declarations(['interface', 'type', 'enum', 'struct', 'typeAlias', 'trait', 'union'], {
    foreground: TYPE,
    background: TYPE_BG,
    fontStyle: 'bold',
  }),
  'typeParameter.declaration': { foreground: TYPE, background: TYPE_BG, fontStyle: 'bold' },
  'variable.declaration.local': { foreground: TEXT, background: NO_BG, fontStyle: '' },
  'function.declaration.local': { foreground: TEXT, background: NO_BG, fontStyle: '' },

  keyword: KEYWORD,
  'keyword.controlFlow': { foreground: CONTROL, background: CONTROL_BG },
  selfKeyword: KEYWORD, operator: PUNCT, punctuation: PUNCT,
  string: STRING,
  comment: { foreground: COMMENT, background: COMMENT_BG },
};

const theme = {
  $schema: 'vscode://schemas/color-theme',
  name: 'LiteLite',
  type: 'light',
  semanticHighlighting: true,
  colors: Object.fromEntries(Object.entries(colors).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  tokenColors,
  semanticTokenColors,
};

fs.writeFileSync(OUTPUT, `${JSON.stringify(theme, null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)}`);
