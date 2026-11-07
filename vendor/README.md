# Vendored browser libraries

## `anthropic-sdk-1.3.0.min.js`

The official Anthropic TypeScript SDK (`@anthropic-ai/sdk` 1.3.0, Apache-2.0, see `anthropic-sdk-LICENSE`)
bundled as a single browser ES module. `index.html` imports it on first use of an AI feature
(`anthropicSdk()`), so it costs nothing until someone reads a photo with Claude.

Rebuild (or move to a newer SDK release) with:

```bash
mkdir sdk-build && cd sdk-build && npm init -y
npm install @anthropic-ai/sdk@1.3.0 esbuild
echo 'export { default } from "@anthropic-ai/sdk";' > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --platform=browser --minify --legal-comments=eof \
  --outfile=../vendor/anthropic-sdk-1.3.0.min.js
```

If you change the file name, update the path in `anthropicSdk()` in `index.html`.
