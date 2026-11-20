// @ts-check
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log(`[watch] build started (${build.initialOptions.outfile})`);
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log(`[watch] build finished (${build.initialOptions.outfile})`);
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const sharedOptions = {
  bundle: true,
  minify: production,
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'silent',
  plugins: [problemMatcherPlugin],
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    ...sharedOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...sharedOptions,
    entryPoints: ['src/webview/ui/index.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

async function main() {
  const contexts = await Promise.all(targets.map((options) => esbuild.context(options)));

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    return;
  }

  try {
    const results = await Promise.all(contexts.map((ctx) => ctx.rebuild()));
    if (results.some((r) => r.errors.length > 0)) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
