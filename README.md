# LiteLite: token backgrounds for VS Code themes

VS Code colour themes can set a `background` on token rules, but VS Code ignores it: only foreground colour and font style are drawn. This extension draws those backgrounds, for whichever theme is active.

It also bundles **LiteLite**, a light theme that uses token backgrounds to highlight control flow, top-level declarations and comments.

## Declaring backgrounds in a theme

Add `background` to any `tokenColors` rule or `semanticTokenColors` style:

```jsonc
"tokenColors": [
  { "scope": "comment", "settings": { "foreground": "#1f55d6", "background": "#2f6feb1f" } }
],
"semanticTokenColors": {
  "variable.declaration": { "foreground": "#6b5000", "background": "#ffcc002e" },
  "variable.declaration.local": { "foreground": "#202020", "background": "#00000000" }
}
```

Themes that declare no backgrounds are left alone, so the extension does nothing for them.

## Adding backgrounds to any theme

The same `background` property works in user settings, globally or for specific themes. Theme names can use `*` wildcards, as in VS Code's own `[*Light*]` syntax:

```jsonc
"editor.tokenColorCustomizations": {
  "[Some Theme]": {
    "textMateRules": [{ "scope": "keyword.control", "settings": { "background": "#ff000022" } }]
  }
},
"editor.semanticTokenColorCustomizations": {
  "[Some Theme]": {
    "rules": { "function.declaration": { "background": "#00ff0022" } }
  }
}
```

## How backgrounds are resolved

Backgrounds follow the same rules VS Code uses for token colours, so a background always sits behind the colour it belongs to:

- **TextMate rules** inherit a background from less specific scopes, so `keyword.control.import` inherits from `keyword.control`. Use a transparent colour such as `#00000000` to clear an inherited background.
- **Semantic token rules** override TextMate backgrounds when semantic highlighting is on for the theme. Of the rules that set `background`, the most specific selector wins. A token with no matching semantic `background` keeps its TextMate background.
- **Plain backgrounds:** the theme's default background and `editor.background` count as "no background".

Use translucent colours: backgrounds are drawn over the editor's selection and find-match highlights, so opaque ones would hide them.

## Limitations

- Only files open in visible editors are highlighted, and only for languages with a TextMate grammar.
- Semantic tokens are re-read when a file is edited, focused or saved. If an edit in one file changes how a name in another file is classified, the other file catches up the next time it's focused or saved.
- Lines longer than 20,000 characters are skipped, matching VS Code's default tokenization limit.

## The LiteLite theme

A light theme based on Light 2026. Text is near-black, with colour kept for a few things:

| Element | Text | Background |
|---|---|---|
| Control flow (`if`, `return`, `await`, `throw`…) and ternaries | dark red | pale red |
| Top-level declarations (variables, functions, classes) | dark yellow | pale yellow |
| Type declarations (interfaces, type aliases, enums, type parameters) | purple | pale purple |
| Comments | blue | pale blue |
| Strings | green | none |
| Keywords like `const`, `function`, `export` | grey | none |
| Punctuation and operators | lighter grey | none |

Top-level declarations are told apart from local ones using the language server's semantic tokens. TypeScript and JavaScript mark local declarations, so locals stay near-black.

The choice of highlights in the theme is inspired by these two blog posts:

- [I am sorry, but everyone is getting syntax highlighting wrong](https://tonsky.me/blog/syntax-highlighting/)
- [Highlighting my Code Based on How Much I Care](https://hank.bond/posts/highlighting-my-code-based-on-how-much-i-care/)

## Development

```bash
npm install
```

The LiteLite theme file is generated: edit `scripts/build-theme.js`, then run `npm run build-theme`. The script reads the workbench colours from the Light 2026 theme in your VS Code installation.

To try changes, use **Run → Run Without Debugging** (⌃F5) to open an Extension Development Host. VS Code shows LiteLite in that window automatically without changing the theme setting, and the extension detects this.
