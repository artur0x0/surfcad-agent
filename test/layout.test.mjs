import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

const FRONTMATTER_KEYS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const REFERENCES = [
  'helpers.md',
  'manifold-api.md',
  'assembly-format.md',
  'sheet-metal.md',
  'modeling-workflow.md',
  'failure-modes.md',
  'examples.md',
];

test('versions, license, and names are the pre-release contract', () => {
  assert.equal(json('package.json').version, '0.1.0');
  assert.equal(json('packages/surfcad/package.json').name, 'surfcad');
  assert.equal(json('packages/surfcad/package.json').version, '0.1.0');
  assert.equal(json('packages/surfcad/package.json').license, 'Apache-2.0');
  const mcp = json('packages/mcp-server/package.json');
  assert.equal(mcp.name, 'surfcad-mcp');
  assert.equal(mcp.version, '0.1.0');
  assert.equal(mcp.mcpName, 'io.github.artur0x0/surfcad');
  assert.equal(mcp.private, true);
  assert.equal(mcp.bin, undefined);
  const plugin = json('plugins/surfcad/.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'surfcad');
  assert.equal(plugin.version, '0.1.0');
  assert.equal(plugin.license, 'Apache-2.0');
  const market = json('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'surfcad-agent');
  assert.equal(market.plugins[0].name, 'surfcad');
  assert.equal(market.plugins[0].source, './plugins/surfcad');
  const mcpConfig = json('plugins/surfcad/.mcp.json');
  assert.deepEqual(mcpConfig, {
    mcpServers: { surfcad: { command: 'npx', args: ['-y', 'surfcad-mcp@0.1.0'] } },
  });
  assert.ok(!existsSync(join(root, 'plugins/surfcad/bin')));
  assert.ok(!existsSync(join(root, '.claude/skills')));
  assert.ok(!existsSync(join(root, '.agents/skills')));
  assert.ok(!existsSync(join(root, 'server.json')));
  assert.ok(read('LICENSE').includes('Apache License'));
  assert.ok(read('plugins/surfcad/LICENSE').includes('Apache License'));
  assert.ok(!read('plugins/surfcad/.claude-plugin/plugin.json').includes('MIT'));
});

test('skill frontmatter is the six spec keys and links every reference', () => {
  const text = read('plugins/surfcad/skills/surfcad/SKILL.md');
  const fence = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fence, 'missing frontmatter');
  const keys = [];
  for (const line of fence[1].split('\n')) {
    if (/^[A-Za-z]/.test(line)) keys.push(line.split(':')[0]);
  }
  assert.deepEqual(keys, FRONTMATTER_KEYS);
  assert.match(fence[1], /^name: surfcad$/m);
  assert.match(fence[1], /^license: Apache-2\.0$/m);
  assert.match(fence[1], /^allowed-tools: Read Write Bash$/m);
  assert.match(fence[1], /version: "0\.1\.0"/);
  assert.match(fence[1], /homepage: "https:\/\/github\.com\/artur0x0\/surfcad-agent"/);
  const description = fence[1].match(/^description: "(.*)"$/m)[1];
  assert.ok(description.length >= 1 && description.length <= 1024);
  assert.ok(!description.includes('<'));
  const compatibility = fence[1].match(/^compatibility: (.*)$/m)[1];
  assert.ok(compatibility.length <= 500);
  const body = text.slice(fence[0].length);
  assert.ok(body.split('\n').length < 500);
  for (const name of REFERENCES) {
    assert.ok(body.includes(`](references/${name})`), `SKILL.md does not link ${name}`);
    assert.ok(existsSync(join(root, 'plugins/surfcad/skills/surfcad/references', name)));
  }
  const words = read('plugins/surfcad/README.md').split(/\s+/).filter(Boolean);
  assert.ok(words.length >= 40, `plugin README has ${words.length} words`);
});

test('generated helpers reference lists all 71 catalog helpers', () => {
  const catalog = json('packages/surfcad/vendor/src/lib/surfcad/catalog/helpers.json');
  assert.equal(catalog.count, 71);
  assert.equal(catalog.helpers.length, 71);
  const helpers = read('plugins/surfcad/skills/surfcad/references/helpers.md');
  for (const helper of catalog.helpers) {
    assert.ok(helpers.includes(`### ${helper.name}\n`), `missing ${helper.name}`);
    assert.ok(helpers.includes(helper.signature), `missing signature ${helper.name}`);
  }
  const pin = read('packages/surfcad/UPSTREAM').match(/\b([0-9a-f]{40})\b/)[1];
  const manifest = json('packages/surfcad/vendor/MANIFEST.json');
  assert.equal(manifest.commit, pin);
  assert.equal(manifest.upstream, 'https://github.com/artur0x0/3dculos');
  const sync = json('packages/surfcad/vendor/src/lib/surfcad/catalog/sync-files.json');
  const listed = [...sync.runtimeFiles, ...sync.catalogFiles];
  assert.deepEqual(Object.keys(manifest.files), listed);
  for (const rel of listed) {
    const path = join(root, 'packages/surfcad/vendor', rel);
    assert.ok(statSync(path).isFile(), rel);
  }
  assert.ok(statSync(join(root, 'packages/surfcad/vendor/built/manifold.wasm')).size > 1000);
  const refDir = join(root, 'plugins/surfcad/skills/surfcad/references');
  const extras = readdirSync(refDir).filter((name) => !REFERENCES.includes(name));
  assert.deepEqual(extras, []);
});
