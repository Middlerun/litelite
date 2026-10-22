// @ts-check
'use strict';

// Loads a colour theme the way VS Code does (include chains, .tmTheme token colours, user
// customizations) so the `background` values VS Code ignores can be drawn as decorations.

const fs = require('fs');
const path = require('path');
const jsonc = require('jsonc-parser');
const tm = require('vscode-textmate');

/** @typedef {{ name?: string, scope?: string | string[], settings: { foreground?: string, background?: string, fontStyle?: string } }} TokenColorRule */
/** @typedef {string | { foreground?: string, background?: string, fontStyle?: string }} SemanticTokenStyle */
/**
 * @typedef {{
 *   tokenColors: TokenColorRule[],
 *   semanticTokenRules: Array<[string, SemanticTokenStyle]>,
 *   semanticHighlighting?: boolean,
 *   colors: Record<string, string>,
 * }} ThemeData
 */

/** @param {string} file */
async function readThemeFile(file) {
  const content = await fs.promises.readFile(file, 'utf8');
  if (path.extname(file).toLowerCase() === '.json') {
    return jsonc.parse(content, [], { allowTrailingComma: true }) ?? {};
  }
  // .tmTheme is a plist; parseRawGrammar's plist parser handles any plist document
  const plist = /** @type {any} */ (tm.parseRawGrammar(content, file));
  return { tokenColors: plist.settings ?? [] };
}

/**
 * @param {string} file
 * @returns {Promise<ThemeData>}
 */
async function loadThemeFile(file) {
  const raw = await readThemeFile(file);
  const dir = path.dirname(file);
  /** @type {ThemeData} */
  const theme = raw.include
    ? await loadThemeFile(path.join(dir, raw.include))
    : { tokenColors: [], semanticTokenRules: [], colors: {} };

  if (typeof raw.tokenColors === 'string') {
    const tokenColors = (await readThemeFile(path.join(dir, raw.tokenColors))).tokenColors ?? [];
    theme.tokenColors = [...theme.tokenColors, ...tokenColors];
  } else if (Array.isArray(raw.tokenColors)) {
    theme.tokenColors = [...theme.tokenColors, ...raw.tokenColors];
  }
  // Later rules win ties, so rules from the including theme override the included one
  theme.semanticTokenRules = [...theme.semanticTokenRules, ...Object.entries(raw.semanticTokenColors ?? {})];
  theme.colors = { ...theme.colors, ...raw.colors };
  if (typeof raw.semanticHighlighting === 'boolean') theme.semanticHighlighting = raw.semanticHighlighting;
  return theme;
}

/**
 * Whether a customization key like `[Theme A][*Light*]` applies to the theme.
 * @param {string} key
 * @param {string} themeName
 */
function keyMatchesTheme(key, themeName) {
  return [...key.matchAll(/\[([^\]]+)\]/g)].some(([, pattern]) => {
    const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return regex.test(themeName);
  });
}

/**
 * Global customizations first, then theme-specific ones, so theme-specific rules win ties.
 * @param {Record<string, any> | undefined} customizations
 * @param {string} themeName
 * @returns {Record<string, any>[]}
 */
function customizationsFor(customizations, themeName) {
  if (!customizations) return [];
  const themeSpecific = Object.entries(customizations)
    .filter(([key]) => key.startsWith('[') && keyMatchesTheme(key, themeName))
    .map(([, value]) => value);
  return [customizations, ...themeSpecific];
}

/**
 * Applies `editor.tokenColorCustomizations` and `editor.semanticTokenColorCustomizations`.
 * @param {ThemeData} theme
 * @param {string} themeName
 * @param {Record<string, any> | undefined} tokenColorCustomizations
 * @param {Record<string, any> | undefined} semanticTokenColorCustomizations
 * @returns {ThemeData}
 */
function applyCustomizations(theme, themeName, tokenColorCustomizations, semanticTokenColorCustomizations) {
  const result = { ...theme };
  for (const customization of customizationsFor(tokenColorCustomizations, themeName)) {
    if (Array.isArray(customization.textMateRules)) {
      result.tokenColors = [...result.tokenColors, ...customization.textMateRules];
    }
  }
  for (const customization of customizationsFor(semanticTokenColorCustomizations, themeName)) {
    if (typeof customization.enabled === 'boolean') result.semanticHighlighting = customization.enabled;
    if (customization.rules) {
      result.semanticTokenRules = [...result.semanticTokenRules, ...Object.entries(customization.rules)];
    }
  }
  return result;
}

/** @param {string} color */
function isTransparent(color) {
  return /^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i.test(color);
}

/**
 * Backgrounds that mean "no token background": the theme's default and editor backgrounds.
 * @param {ThemeData} theme
 */
function plainBackgrounds(theme) {
  // Mirrors vscode-textmate: scopeless rules set the defaults, which start as white
  let defaultBackground = '#FFFFFF';
  for (const rule of theme.tokenColors) {
    if (!rule.scope && rule.settings?.background) defaultBackground = rule.settings.background;
  }
  const colors = [defaultBackground, theme.colors['editor.background']].filter(Boolean);
  return new Set(colors.map((color) => color.toUpperCase()));
}

/**
 * Whether the theme declares any token backgrounds worth drawing.
 * @param {ThemeData} theme
 */
function hasTokenBackgrounds(theme) {
  const plain = plainBackgrounds(theme);
  const drawable = (/** @type {unknown} */ color) =>
    typeof color === 'string' && !isTransparent(color) && !plain.has(color.toUpperCase());
  return (
    theme.tokenColors.some((rule) => rule.scope && drawable(rule.settings?.background)) ||
    theme.semanticTokenRules.some(([, style]) => typeof style === 'object' && drawable(style.background))
  );
}

module.exports = { loadThemeFile, applyCustomizations, isTransparent, plainBackgrounds, hasTokenBackgrounds };
