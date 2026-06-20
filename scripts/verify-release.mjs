import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const versions = JSON.parse(readFileSync(resolve(root, 'versions.json'), 'utf8'));
const required = ['manifest.json', 'main.js', 'styles.css'];

function fail(message) {
	console.error(`Release verification failed: ${message}`);
	process.exitCode = 1;
}

if (manifest.version !== packageJson.version || manifest.version !== packageLock.version || manifest.version !== packageLock.packages?.['']?.version) {
	fail('manifest.json, package.json, and package-lock.json versions must match.');
}
if (!versions[manifest.version]) fail(`versions.json does not contain ${manifest.version}.`);
for (const file of required) if (!existsSync(resolve(root, file))) fail(`Missing build artifact: ${file}`);

const zipPath = resolve(process.argv[2] ?? resolve(root, 'release', `line-last-modified-${manifest.version}.zip`));
if (!existsSync(zipPath)) {
	fail(`Missing release archive: ${zipPath}`);
} else {
	const commands = process.platform === 'win32'
		? [['tar', ['-tf', zipPath]]]
		: [['unzip', ['-Z1', zipPath]], ['tar', ['-tf', zipPath]]];
	let listing;
	for (const [command, args] of commands) {
		const result = spawnSync(command, args, { encoding: 'utf8' });
		if (result.status === 0) { listing = result.stdout; break; }
	}
	if (listing === undefined) {
		fail('Could not inspect the release archive with unzip or tar.');
	} else {
		const files = listing.split(/\r?\n/).map(value => value.trim().replace(/^\.\//, '')).filter(Boolean).sort();
		const expected = [...required].sort();
		if (JSON.stringify(files) !== JSON.stringify(expected)) {
			fail(`Archive must contain exactly ${expected.join(', ')}; found ${files.map(basename).join(', ')}.`);
		}
	}
}

if (!process.exitCode) console.log(`Release ${manifest.version} verified.`);
