// @ts-check
'use strict';

// Editor-independent logic: TextMate tokenization, semantic token matching and
// segment composition. Kept free of the `vscode` module so it can be tested in Node.

const fs = require('fs');
const path = require('path');
const tm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');
const { isTransparent, plainBackgrounds } = require('./themes');

// Same limit VS Code uses by default (editor.maxTokenizationLineLength)
const MAX_LINE_LENGTH = 20000;
const LINE_TIME_LIMIT_MS = 500;
const CHUNK_TIME_MS = 15;

/** @typedef {import('./themes').ThemeData} ThemeData */
/** @typedef {{ start: number, end: number, background: string }} Segment */
/** @typedef {{ start: number, end: number, background: string | null }} Override */
/** @typedef {{ state: tm.StateStack, segments: Segment[] }} LineTokens */

/** @type {Promise<tm.IOnigLib> | undefined} */
let onigLibPromise;

function loadOnigLib() {
  onigLibPromise ??= (async () => {
    const wasmPath = path.join(path.dirname(require.resolve('vscode-oniguruma')), 'onig.wasm');
    const wasm = await fs.promises.readFile(wasmPath);
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    return {
      createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
      createOnigString: (s) => new oniguruma.OnigString(s),
    };
  })();
  return onigLibPromise;
}

/**
 * Resolves languages to grammars using the grammar contributions of installed extensions,
 * and resolves token backgrounds from the theme exactly as VS Code resolves token colours.
 */
class GrammarRegistry {
  /**
   * @param {tm.IOnigLib} onigLib
   * @param {Array<{ extensionPath: string, grammars: any[] }>} contributions
   */
  constructor(onigLib, contributions) {
    /** @type {Map<string, string>} */
    this.scopeByLanguage = new Map();
    /** @type {Map<string, string>} */
    this.pathByScope = new Map();
    /** @type {Map<string, string[]>} */
    this.injectionsByScope = new Map();
    /** Background colour for each colour id in the theme's colour map, or null when plain */
    /** @type {Array<string | null>} */
    this.backgroundById = [];

    for (const { extensionPath, grammars } of contributions) {
      for (const grammar of grammars) {
        if (!grammar.scopeName || !grammar.path) continue;
        this.pathByScope.set(grammar.scopeName, path.join(extensionPath, grammar.path));
        if (grammar.language) this.scopeByLanguage.set(grammar.language, grammar.scopeName);
        for (const target of grammar.injectTo ?? []) {
          const injections = this.injectionsByScope.get(target) ?? [];
          injections.push(grammar.scopeName);
          this.injectionsByScope.set(target, injections);
        }
      }
    }

    this.registry = new tm.Registry({
      onigLib: Promise.resolve(onigLib),
      loadGrammar: async (scopeName) => {
        const grammarPath = this.pathByScope.get(scopeName);
        if (!grammarPath) return null;
        const content = await fs.promises.readFile(grammarPath, 'utf8');
        return tm.parseRawGrammar(content, grammarPath);
      },
      getInjections: (scopeName) => this.injectionsByScope.get(scopeName),
    });
  }

  /** @param {ThemeData} theme */
  setTheme(theme) {
    this.registry.setTheme({ name: 'active', settings: theme.tokenColors });
    const plain = plainBackgrounds(theme);
    this.backgroundById = this.registry
      .getColorMap()
      .map((color) => (!color || isTransparent(color) || plain.has(color.toUpperCase()) ? null : color));
  }

  /** @param {string} languageId */
  async grammarFor(languageId) {
    const scopeName = this.scopeByLanguage.get(languageId);
    if (!scopeName) return null;
    try {
      return await this.registry.loadGrammar(scopeName);
    } catch {
      return null;
    }
  }
}

/**
 * @param {Uint32Array} tokens `tokenizeLine2` output: [startIndex, metadata] pairs
 * @param {number} lineLength
 * @param {Array<string | null>} backgroundById
 * @returns {Segment[]}
 */
function toSegments(tokens, lineLength, backgroundById) {
  /** @type {Segment[]} */
  const segments = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const start = tokens[i];
    const end = i + 2 < tokens.length ? tokens[i + 2] : lineLength;
    const background = backgroundById[tokens[i + 1] >>> 24];
    if (!background || start === end) continue;
    const last = segments[segments.length - 1];
    if (last && last.end === start && last.background === background) {
      last.end = end;
    } else {
      segments.push({ start, end, background });
    }
  }
  return segments;
}

/** Incrementally maintained TextMate tokenization of one document. */
class DocumentTokens {
  /**
   * @param {string} languageId
   * @param {number} lineCount
   */
  constructor(languageId, lineCount) {
    this.languageId = languageId;
    /** @type {Array<LineTokens | undefined>} */
    this.lines = new Array(lineCount).fill(undefined);
    this.dirtyFrom = 0;
  }

  /**
   * Replaces lines `startLine..endLine` (inclusive) with the lines of `text`, marking them for retokenization.
   * @param {number} startLine
   * @param {number} endLine
   * @param {string} text
   */
  applyChange(startLine, endLine, text) {
    const addedLines = text.split('\n').length;
    this.lines.splice(startLine, endLine - startLine + 1, ...new Array(addedLines).fill(undefined));
    this.dirtyFrom = Math.min(this.dirtyFrom, startLine);
  }

  /**
   * Retokenizes from the first dirty line until the tokenizer state converges with the previous run.
   * Yields to the event loop periodically; returns false if `isStale` reports the document changed meanwhile.
   * @param {(line: number) => string} getLine
   * @param {number} lineCount
   * @param {tm.IGrammar} grammar
   * @param {Array<string | null>} backgroundById
   * @param {() => boolean} isStale
   */
  async tokenize(getLine, lineCount, grammar, backgroundById, isStale) {
    this.lines.length = lineCount;
    let line = this.dirtyFrom;
    let deadline = Date.now() + CHUNK_TIME_MS;

    while (line < lineCount) {
      const previous = this.lines[line];
      const startState = line === 0 ? tm.INITIAL : /** @type {LineTokens} */ (this.lines[line - 1]).state;
      const text = getLine(line);
      if (text.length > MAX_LINE_LENGTH) {
        this.lines[line] = { state: startState, segments: [] };
      } else {
        const result = grammar.tokenizeLine2(text, startState, LINE_TIME_LIMIT_MS);
        this.lines[line] = { state: result.ruleStack, segments: toSegments(result.tokens, text.length, backgroundById) };
      }
      line++;

      // Once the state matches the previous run, following lines are unchanged up to the next edited line
      if (previous && previous.state.equals(/** @type {LineTokens} */ (this.lines[line - 1]).state)) {
        while (line < lineCount && this.lines[line] !== undefined) line++;
      }

      if (Date.now() > deadline) {
        this.dirtyFrom = line;
        await new Promise((resolve) => setImmediate(resolve));
        if (isStale()) return false;
        deadline = Date.now() + CHUNK_TIME_MS;
      }
    }

    this.dirtyFrom = Infinity;
    return true;
  }
}

/**
 * Builds a matcher that resolves a semantic token's background the way VS Code resolves each style
 * property: of the rules that set it, the highest-scoring selector wins, later rules winning ties.
 * Returns `undefined` when no rule sets a background (the TextMate background then stays), or `null`
 * for an explicitly transparent background.
 * @param {ThemeData['semanticTokenRules']} rules
 * @param {Map<string, string>} superTypes semantic token type -> its super type
 */
function createSemanticMatcher(rules, superTypes) {
  const backgroundRules = rules.flatMap(([selector, style]) => {
    if (typeof style !== 'object' || typeof style.background !== 'string') return [];
    const [typeAndModifiers, language] = selector.split(':');
    const [type, ...modifiers] = typeAndModifiers.split('.');
    return [{ type, modifiers, language, background: isTransparent(style.background) ? null : style.background }];
  });

  /** @type {Map<string, string[]>} */
  const hierarchies = new Map();
  /** @param {string} type */
  const hierarchyOf = (type) => {
    let hierarchy = hierarchies.get(type);
    if (!hierarchy) {
      hierarchy = [type];
      for (let current = superTypes.get(type); current && !hierarchy.includes(current); current = superTypes.get(current)) {
        hierarchy.push(current);
      }
      hierarchies.set(type, hierarchy);
    }
    return hierarchy;
  };

  /**
   * @param {string} type
   * @param {Set<string>} modifiers
   * @param {string} language
   * @returns {string | null | undefined}
   */
  return (type, modifiers, language) => {
    /** @type {string | null | undefined} */
    let best;
    let bestScore = -1;
    for (const rule of backgroundRules) {
      let score = 0;
      if (rule.language !== undefined) {
        if (rule.language !== language) continue;
        score += 10;
      }
      if (rule.type !== '*') {
        const level = hierarchyOf(type).indexOf(rule.type);
        if (level === -1) continue;
        score += 100 - level;
      }
      if (!rule.modifiers.every((modifier) => modifiers.has(modifier))) continue;
      score += rule.modifiers.length * 100;
      if (score >= bestScore) {
        best = rule.background;
        bestScore = score;
      }
    }
    return best;
  };
}

/**
 * Decodes LSP-style relative semantic token data into per-line background overrides.
 * @param {Uint32Array} data
 * @param {{ tokenTypes: string[], tokenModifiers: string[] }} legend
 * @param {ReturnType<typeof createSemanticMatcher>} matcher
 * @param {string} language
 */
function decodeSemanticTokens(data, legend, matcher, language) {
  /** @type {Map<number, Override[]>} */
  const overridesByLine = new Map();
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const [deltaLine, deltaStart, length, typeIndex, modifierBits] = data.subarray(i, i + 5);
    if (deltaLine) {
      line += deltaLine;
      character = deltaStart;
    } else {
      character += deltaStart;
    }

    /** @type {Set<string>} */
    const modifiers = new Set();
    for (let bit = 0; bit < legend.tokenModifiers.length; bit++) {
      if (modifierBits & (1 << bit)) modifiers.add(legend.tokenModifiers[bit]);
    }
    const background = matcher(legend.tokenTypes[typeIndex], modifiers, language);
    if (background === undefined) continue;

    const overrides = overridesByLine.get(line) ?? [];
    overrides.push({ start: character, end: character + length, background });
    overridesByLine.set(line, overrides);
  }
  return overridesByLine;
}

/**
 * Applies semantic overrides on top of TextMate segments, as semantic styles replace TextMate styles.
 * @param {Segment[]} segments
 * @param {Override[]} overrides
 * @returns {Segment[]}
 */
function overlay(segments, overrides) {
  let result = segments;
  for (const override of overrides) {
    /** @type {Segment[]} */
    const next = [];
    for (const segment of result) {
      if (segment.end <= override.start || segment.start >= override.end) {
        next.push(segment);
        continue;
      }
      if (segment.start < override.start) next.push({ ...segment, end: override.start });
      if (segment.end > override.end) next.push({ ...segment, start: override.end });
    }
    if (override.background) next.push({ start: override.start, end: override.end, background: override.background });
    result = next;
  }
  return result;
}

module.exports = {
  GrammarRegistry,
  DocumentTokens,
  loadOnigLib,
  createSemanticMatcher,
  decodeSemanticTokens,
  overlay,
};
