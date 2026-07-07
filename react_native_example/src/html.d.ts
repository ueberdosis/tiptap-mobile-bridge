/// Lets `import editorHtml from './editor.html'` resolve to the file's contents as a string.
/// The inlining is done at build time by `babel-plugin-inline-import` (see babel.config.js), so no
/// file is read at runtime — the editor bundle rides inside the JS bundle and loads offline.
declare module '*.html' {
  const content: string;
  export default content;
}
