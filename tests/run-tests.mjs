import { rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import esbuild from 'esbuild';

const outdir = '.test-dist';
rmSync(outdir, { recursive: true, force: true });

await esbuild.build({
	entryPoints: ['tests/core.test.ts', 'tests/integration.test.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	outdir,
	logLevel: 'warning',
	plugins: [{
		name: 'obsidian-test-shim',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: resolve('tests/obsidian-shim.ts') }));
		},
	}],
});

const files = readdirSync(outdir).filter(file => file.endsWith('.js')).map(file => `${outdir}/${file}`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
rmSync(outdir, { recursive: true, force: true });
process.exit(result.status ?? 1);
