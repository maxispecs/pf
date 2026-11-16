const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const options = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'dist/extension.js',
	external: ['vscode'],
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	sourcemap: true,
	minify: !watch,
	logLevel: 'info',
};

/**
 * The identity card draws its buttons with codicons. The font and its stylesheet are a dev dependency
 * (@vscode/codicons) copied next to the card's own media at build time, so nothing is fetched at run time
 * and the package has no runtime dependency. The copies are not committed (see .gitignore).
 */
function copyCodicons() {
	const fs = require('node:fs');
	const path = require('node:path');
	// The package's exports map hides dist/, so go through the symlink pnpm makes in this package.
	const from = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
	for (const file of ['codicon.css', 'codicon.ttf']) {
		fs.copyFileSync(path.join(from, file), path.join(__dirname, 'media', file));
	}
}

async function main() {
	copyCodicons();
	if (watch) {
		const ctx = await esbuild.context(options);
		await ctx.watch();
	} else {
		await esbuild.build(options);
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
