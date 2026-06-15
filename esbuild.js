const fs = require('fs/promises');
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const zoneCjsShimPlugin = {
  name: 'zone-cjs-shim',
  setup(build) {
    build.onLoad({ filter: /zone\/dist\/tools\/(builtinCapabilities|toolExecutor)\.js$/ }, async (args) => {
      const source = await fs.readFile(args.path, 'utf8');
      return {
        contents: source.replaceAll(
          '(await import("./toolDefinitions.js")).ZONE_TOOLS',
          'require("./toolDefinitions.js").ZONE_TOOLS',
        ),
        loader: 'js',
      };
    });
  },
};

const builds = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    define: { 'import.meta.url': '__importMetaUrl' },
    banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
    plugins: [zoneCjsShimPlugin],
    outfile: 'out/extension.js',
    sourcemap: true,
  },
  {
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: 'out/webview.js',
    sourcemap: true,
  },
];

async function main() {
  if (watch) {
    const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((context) => context.watch()));
    console.log('Watching extension and webview bundles...');
    return;
  }

  await Promise.all(builds.map((options) => esbuild.build(options)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
