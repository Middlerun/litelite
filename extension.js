// @ts-check
'use strict';

// Draws the token backgrounds that colour themes declare but VS Code ignores: `background` in
// `tokenColors` rules and in `semanticTokenColors` styles (plus the user's customizations of both).
// Backgrounds are resolved the way VS Code resolves token colours (TextMate scopes, then semantic
// tokens on top), so they always sit behind the matching foreground.

const path = require('path');
const vscode = require('vscode');
const { GrammarRegistry, DocumentTokens, loadOnigLib, createSemanticMatcher, decodeSemanticTokens, overlay } = require('./highlighter');
const { loadThemeFile, applyCustomizations, hasTokenBackgrounds } = require('./themes');

const DEBOUNCE_MS = 150;
const SEMANTIC_RETRY_MS = 1000;
const SEMANTIC_MAX_RETRIES = 10;
const IGNORED_SCHEMES = new Set(['output', 'debug', 'vscode-scm']);

/**
 * @typedef {{
 *   theme: import('./themes').ThemeData,
 *   matcher: ReturnType<typeof createSemanticMatcher>,
 *   decorationTypes: Map<string, vscode.TextEditorDecorationType>,
 * }} ActiveTheme
 */
/**
 * @typedef {{
 *   tokens: DocumentTokens,
 *   ranges: Map<string, vscode.Range[]>,
 *   timer?: NodeJS.Timeout,
 *   busy: boolean,
 *   pending: boolean,
 *   semanticRetries: number,
 * }} DocumentEntry
 */

/** Set only while the active theme declares token backgrounds */
/** @type {ActiveTheme | undefined} */
let active;
/** @type {Promise<GrammarRegistry> | undefined} */
let registryPromise;
/** @type {vscode.LogOutputChannel} */
let log;
let themeGeneration = 0;
/**
 * In an Extension Development Host, VS Code shows the developed extension's theme without
 * changing the theme settings, until another theme is picked
 * @type {string | undefined}
 */
let developmentThemeName;

/** @type {Map<string, DocumentEntry>} */
const documents = new Map();

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  log = vscode.window.createOutputChannel('Token Backgrounds', { log: true });
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    developmentThemeName = findDevelopmentTheme(context.extension.packageJSON?.contributes?.themes ?? []);
  }

  context.subscriptions.push(
    log,
    { dispose: () => deactivateTheme() },
    vscode.window.onDidChangeActiveColorTheme(() => refreshTheme()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      const themeSettingChanged =
        event.affectsConfiguration('workbench.colorTheme') ||
        event.affectsConfiguration('workbench.preferredLightColorTheme') ||
        event.affectsConfiguration('workbench.preferredDarkColorTheme') ||
        event.affectsConfiguration('workbench.preferredHighContrastColorTheme') ||
        event.affectsConfiguration('workbench.preferredHighContrastLightColorTheme') ||
        event.affectsConfiguration('window.autoDetectColorScheme');
      if (themeSettingChanged) developmentThemeName = undefined;
      if (
        themeSettingChanged ||
        event.affectsConfiguration('editor.tokenColorCustomizations') ||
        event.affectsConfiguration('editor.semanticTokenColorCustomizations')
      ) {
        refreshTheme();
      } else if (active && event.affectsConfiguration('editor.semanticHighlighting')) {
        scheduleVisible();
      }
    }),
    vscode.extensions.onDidChange(() => {
      registryPromise = undefined;
      refreshTheme();
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      if (!active) return;
      for (const editor of editors) {
        const entry = documents.get(editor.document.uri.toString());
        if (entry) applyDecorations(editor, entry);
        schedule(editor.document);
      }
    }),
    // Semantic tokens can change because of edits elsewhere, so refresh on focus and save
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (active && editor) schedule(editor.document);
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      if (active) scheduleVisible();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const entry = documents.get(event.document.uri.toString());
      if (!entry) return;
      for (const change of event.contentChanges) {
        entry.tokens.applyChange(change.range.start.line, change.range.end.line, change.text);
      }
      if (isVisible(event.document)) schedule(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      clearTimeout(documents.get(key)?.timer);
      documents.delete(key);
    }),
  );

  refreshTheme();

  // Used by tests to inspect what was decorated
  return {
    /** @param {vscode.Uri} uri */
    rangesFor: (uri) => documents.get(uri.toString())?.ranges,
  };
}

function deactivate() {
  deactivateTheme();
}

/**
 * Mirrors VS Code's choice of development theme: the first one matching the current theme type.
 * @param {Array<{ id?: string, label?: string, uiTheme?: string }>} themes
 */
function findDevelopmentTheme(themes) {
  const uiThemeByKind = {
    [vscode.ColorThemeKind.Light]: 'vs',
    [vscode.ColorThemeKind.Dark]: 'vs-dark',
    [vscode.ColorThemeKind.HighContrast]: 'hc-black',
    [vscode.ColorThemeKind.HighContrastLight]: 'hc-light',
  };
  const theme = themes.find((t) => t.uiTheme === uiThemeByKind[vscode.window.activeColorTheme.kind]) ?? themes[0];
  return theme && (theme.id ?? theme.label);
}

function activeThemeName() {
  if (developmentThemeName) return developmentThemeName;
  const workbench = vscode.workspace.getConfiguration('workbench');
  if (!vscode.workspace.getConfiguration('window').get('autoDetectColorScheme')) {
    return workbench.get('colorTheme');
  }
  const settingByKind = {
    [vscode.ColorThemeKind.Light]: 'preferredLightColorTheme',
    [vscode.ColorThemeKind.Dark]: 'preferredDarkColorTheme',
    [vscode.ColorThemeKind.HighContrast]: 'preferredHighContrastColorTheme',
    [vscode.ColorThemeKind.HighContrastLight]: 'preferredHighContrastLightColorTheme',
  };
  return workbench.get(settingByKind[vscode.window.activeColorTheme.kind]);
}

/** @param {string} themeName */
function findThemeFile(themeName) {
  for (const extension of vscode.extensions.all) {
    for (const theme of extension.packageJSON?.contributes?.themes ?? []) {
      if ((theme.id ?? theme.label) === themeName && theme.path) {
        return path.join(extension.extensionPath, theme.path);
      }
    }
  }
  return undefined;
}

function getRegistry() {
  registryPromise ??= loadOnigLib().then((onigLib) => {
    const contributions = vscode.extensions.all.map((extension) => ({
      extensionPath: extension.extensionPath,
      grammars: extension.packageJSON?.contributes?.grammars ?? [],
    }));
    return new GrammarRegistry(onigLib, contributions);
  });
  return registryPromise;
}

function semanticSuperTypes() {
  /** @type {Map<string, string>} */
  const superTypes = new Map();
  for (const extension of vscode.extensions.all) {
    for (const type of extension.packageJSON?.contributes?.semanticTokenTypes ?? []) {
      if (type.id && type.superType) superTypes.set(type.id, type.superType);
    }
  }
  return superTypes;
}

async function refreshTheme() {
  const generation = ++themeGeneration;
  try {
    const themeName = activeThemeName();
    const themeFile = typeof themeName === 'string' ? findThemeFile(themeName) : undefined;
    if (!themeName || !themeFile) {
      deactivateTheme();
      return;
    }

    const editorConfig = vscode.workspace.getConfiguration('editor');
    const theme = applyCustomizations(
      await loadThemeFile(themeFile),
      themeName,
      editorConfig.get('tokenColorCustomizations'),
      editorConfig.get('semanticTokenColorCustomizations'),
    );
    const registry = await getRegistry();
    if (generation !== themeGeneration) return;

    deactivateTheme();
    if (!hasTokenBackgrounds(theme)) {
      log.info(`Theme "${themeName}" declares no token backgrounds`);
      return;
    }
    registry.setTheme(theme);
    active = { theme, matcher: createSemanticMatcher(theme.semanticTokenRules, semanticSuperTypes()), decorationTypes: new Map() };
    log.info(`Drawing token backgrounds for theme "${themeName}"`);
    scheduleVisible();
  } catch (error) {
    log.error('Failed to load the active theme', error);
    if (generation === themeGeneration) deactivateTheme();
  }
}

function deactivateTheme() {
  for (const entry of documents.values()) clearTimeout(entry.timer);
  documents.clear();
  if (!active) return;
  for (const type of active.decorationTypes.values()) type.dispose();
  active = undefined;
}

/** @param {vscode.TextDocument} document */
function isVisible(document) {
  return vscode.window.visibleTextEditors.some((editor) => editor.document === document);
}

function scheduleVisible() {
  for (const editor of vscode.window.visibleTextEditors) schedule(editor.document);
}

/**
 * @param {vscode.TextDocument} document
 * @param {number} [delay]
 */
function schedule(document, delay = DEBOUNCE_MS) {
  if (!active || IGNORED_SCHEMES.has(document.uri.scheme)) return;
  const key = document.uri.toString();
  let entry = documents.get(key);
  if (!entry || entry.tokens.languageId !== document.languageId) {
    entry = {
      tokens: new DocumentTokens(document.languageId, document.lineCount),
      ranges: new Map(),
      busy: false,
      pending: false,
      semanticRetries: 0,
    };
    documents.set(key, entry);
  }
  const scheduled = entry;
  clearTimeout(scheduled.timer);
  scheduled.timer = setTimeout(() => {
    update(document, scheduled).catch((error) => log.error(`Failed to highlight ${key}`, error));
  }, delay);
}

/**
 * Fetches semantic tokens as background overrides per line, `null` when the provider isn't ready yet,
 * or `undefined` when semantic highlighting doesn't apply to this document.
 * @param {vscode.TextDocument} document
 * @param {ActiveTheme} theme
 */
async function getSemanticOverrides(document, theme) {
  const setting = vscode.workspace.getConfiguration('editor', document).get('semanticHighlighting.enabled');
  const enabled = setting === 'configuredByTheme' ? theme.theme.semanticHighlighting === true : setting === true;
  if (!enabled) return undefined;

  /** @type {vscode.SemanticTokensLegend | undefined} */
  const legend = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', document.uri);
  if (!legend) return undefined;
  /** @type {vscode.SemanticTokens | undefined} */
  const tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', document.uri);
  if (!tokens) return null;
  return decodeSemanticTokens(tokens.data, legend, theme.matcher, document.languageId);
}

/**
 * @param {vscode.TextDocument} document
 * @param {DocumentEntry} entry
 */
async function update(document, entry) {
  const theme = active;
  if (!theme || document.isClosed || documents.get(document.uri.toString()) !== entry) return;
  if (entry.busy) {
    entry.pending = true;
    return;
  }
  entry.busy = true;
  try {
    const version = document.version;
    const isStale = () => active !== theme || document.isClosed || document.version !== version;

    const registry = await getRegistry();
    const grammar = await registry.grammarFor(document.languageId);
    if (!grammar || isStale()) return;

    const semantic = await getSemanticOverrides(document, theme);
    if (isStale()) return;

    const complete = await entry.tokens.tokenize(
      (line) => document.lineAt(line).text,
      document.lineCount,
      grammar,
      registry.backgroundById,
      isStale,
    );
    if (!complete) return;

    /** @type {Map<string, vscode.Range[]>} */
    const ranges = new Map();
    entry.tokens.lines.forEach((lineTokens, line) => {
      if (!lineTokens) return;
      const overrides = semantic?.get(line);
      const segments = overrides ? overlay(lineTokens.segments, overrides) : lineTokens.segments;
      for (const segment of segments) {
        const colorRanges = ranges.get(segment.background) ?? [];
        colorRanges.push(new vscode.Range(line, segment.start, line, segment.end));
        ranges.set(segment.background, colorRanges);
      }
    });
    entry.ranges = ranges;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) applyDecorations(editor, entry);
    }

    // The semantic provider (e.g. the TypeScript server) may still be starting up
    if (semantic === null && entry.semanticRetries < SEMANTIC_MAX_RETRIES) {
      entry.semanticRetries++;
      schedule(document, SEMANTIC_RETRY_MS);
    } else if (semantic !== null) {
      entry.semanticRetries = 0;
    }
  } finally {
    entry.busy = false;
    if (entry.pending) {
      entry.pending = false;
      schedule(document);
    }
  }
}

/**
 * @param {vscode.TextEditor} editor
 * @param {DocumentEntry} entry
 */
function applyDecorations(editor, entry) {
  if (!active) return;
  for (const color of entry.ranges.keys()) {
    if (!active.decorationTypes.has(color)) {
      active.decorationTypes.set(
        color,
        vscode.window.createTextEditorDecorationType({
          backgroundColor: color,
          borderRadius: '3px',
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
      );
    }
  }
  for (const [color, type] of active.decorationTypes) {
    editor.setDecorations(type, entry.ranges.get(color) ?? []);
  }
}

module.exports = { activate, deactivate };
