const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dist', 'npm-package');
const packageJsonPath = path.join(root, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of ['README.md', 'README.ko.md', 'LICENSE', 'cli.js']) {
  fs.copyFileSync(path.join(root, file), path.join(outDir, file));
}

const npmPackageJson = {
  ...packageJson,
  name: '@magiof/devtalk',
  main: 'cli.js',
  scripts: {
    cli: 'node cli.js'
  }
};

delete npmPackageJson.activationEvents;
delete npmPackageJson.contributes;
delete npmPackageJson.extensionKind;
delete npmPackageJson.engines;
delete npmPackageJson.devDependencies;

fs.writeFileSync(
  path.join(outDir, 'package.json'),
  JSON.stringify(npmPackageJson, null, 2) + '\n'
);

console.log('Prepared npm package at dist/npm-package');
console.log('Publish with: npm publish dist/npm-package --access=public');
