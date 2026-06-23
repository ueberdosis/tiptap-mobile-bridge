import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Bundle the editor + bridge into a single self-contained HTML file that native
// hosts load into a webview. Inlining everything avoids runtime asset requests,
// so the host can load it straight from the device filesystem.
export default defineConfig({
  plugins: [viteSingleFile()],
})
