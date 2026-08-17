import { build } from 'esbuild'
await build({ entryPoints: ['src/web/main.ts'], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', alias: { vue: 'vue/dist/vue.esm-bundler.js' }, outfile: 'dist/web/app.js', minify: true, sourcemap: false, loader: { '.css': 'css' }, assetNames: 'assets/[name]-[hash]' })
