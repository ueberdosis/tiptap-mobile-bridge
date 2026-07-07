module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Inline `import x from './*.html'` as the file's contents (a string) at build time, so the
  // editor bundle rides inside the JS bundle and loads offline with no runtime file access.
  plugins: [['babel-plugin-inline-import', {extensions: ['.html']}]],
};
