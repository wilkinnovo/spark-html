/**
 * Spark (spark-html) VS Code extension — starts the language server.
 *
 * The server ships separately as the `spark-html-language-server` npm package
 * (LSP over stdio, zero deps). This client prefers the project-local install
 * (node_modules) and falls back to a global one on PATH. To avoid noise in
 * plain-HTML projects, it only activates when a workspace folder depends on
 * spark-html (or when `spark.lsp.enable` is forced on).
 */
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { LanguageClient } = require('vscode-languageclient/node');

let client;

function isSparkWorkspace(folders) {
  for (const folder of folders || []) {
    const root = folder.uri.fsPath;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (Object.keys(deps).some((d) => d === 'spark-html' || d.startsWith('spark-html-'))) return true;
    } catch { /* no package.json — keep looking */ }
    if (fs.existsSync(path.join(root, 'node_modules', 'spark-html'))) return true;
  }
  return false;
}

function serverOptions(folders) {
  // Project-local install wins (version matches the project).
  for (const folder of folders || []) {
    const local = path.join(
      folder.uri.fsPath, 'node_modules', 'spark-html-language-server', 'bin', 'cli.js',
    );
    if (fs.existsSync(local)) {
      return { run: { command: process.execPath, args: [local] } };
    }
  }
  // Otherwise the global binary (npm install -g spark-html-language-server).
  return { run: { command: 'spark-html-language-server' } };
}

async function activate(context) {
  const config = vscode.workspace.getConfiguration('spark');
  const enable = config.get('lsp.enable', 'auto');
  if (enable === false || enable === 'off') return;
  const folders = vscode.workspace.workspaceFolders;
  if (enable !== true && enable !== 'on' && !isSparkWorkspace(folders)) return;

  const options = serverOptions(folders);
  client = new LanguageClient(
    'spark-html',
    'Spark (spark-html)',
    { run: options.run, debug: options.run },
    { documentSelector: [{ scheme: 'file', language: 'html' }] },
  );
  try {
    await client.start();
  } catch {
    vscode.window.showWarningMessage(
      'Spark: could not start spark-html-language-server. Install it with ' +
      '`npm install -g spark-html-language-server` (or add it to your project) and reload.',
    );
    client = undefined;
  }
  if (client) context.subscriptions.push(client);
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
