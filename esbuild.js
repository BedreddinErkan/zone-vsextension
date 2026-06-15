const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const builds = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
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
