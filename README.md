# surfcad-agent

Bring-your-own-agent [SurfCAD](https://surfcad.com) skill and helper library. SurfCAD is a web CAD app on a custom Manifold kernel. Agents bring their own model. This repo has no API keys and does not call a hosted model.

**Pre-release.** Version 0.1.0 is the tree layout, the vendored helper runtime, and the skill. The MCP server in `packages/mcp-server` is a placeholder (the stdio process is a later revision). `server.json` and the registry publish flow are not in this revision. Nothing here is published to npm from this tree.

npm `surfcad` and npm `surfcad-mcp` already exist as `0.0.1` placeholders ("coming soon"). This repo's packages are `0.1.0` and are not published yet. The plugin `.mcp.json` points at `surfcad-mcp@0.1.0`, which will not resolve from the registry until that version is published.

License: Apache-2.0.

## Layout

```
.claude-plugin/marketplace.json     marketplace name: surfcad-agent
plugins/surfcad/                    plugin name: surfcad (no bin/)
  .claude-plugin/plugin.json
  .mcp.json                         npx -y surfcad-mcp@0.1.0
  skills/surfcad/SKILL.md           skill name: surfcad
  skills/surfcad/references/
packages/surfcad/                   npm surfcad, the helper library
  UPSTREAM                          pinned 3dculos SHA
  vendor/                           copy of that commit's sync-files.json list
packages/mcp-server/                npm surfcad-mcp, placeholder
scripts/sync-3dculos.mjs            re-vendor the pin
scripts/gen-references.mjs          regenerate four skill references
```

There is one skill folder. There is no `.claude/skills` or `.agents/skills` copy.

## Helper library

`packages/surfcad` re-exports `loadManifold`, `runScript`, `helperScope`, and the STL / 3MF / STEP exporters. The wasm is `vendor/built/manifold.wasm`, resolved from the package directory, so it works from `node_modules/surfcad` without depending on the process working directory. It is the custom kernel shipped with 3dculos, not npm `manifold-3d`.

The pin is the full SHA in `packages/surfcad/UPSTREAM`. `npm run sync` downloads that commit from GitHub, copies every `runtimeFiles` and `catalogFiles` path from `sync-files.json` into `vendor/` (paths kept), and writes `vendor/MANIFEST.json`. CI runs the sync again and fails if the tree differs.

```bash
npm test
```

Run that from this directory. The headless test builds a filleted box, a two-body assembly, and a bent sheet, and checks status, bounding box, volume, body count, and non-empty STL, 3MF, and STEP.

## Install the skill

| Agent | Skill | MCP |
| --- | --- | --- |
| Claude Code | `/plugin marketplace add artur0x0/surfcad-agent` then `/plugin install surfcad@surfcad-agent` | The plugin `.mcp.json` starts `npx -y surfcad-mcp@0.1.0` once that version is published. Standalone: `claude mcp add --transport stdio surfcad -- npx -y surfcad-mcp@0.1.0` |
| claude.ai / Cowork | Customize, Plugins, Add marketplace `artur0x0/surfcad-agent`, or upload the `plugins/surfcad` folder | Chat needs a remote HTTP server. This revision ships stdio config only, so Chat gets the skill without tools |
| Claude API | Upload `plugins/surfcad/skills/surfcad` (`name` matches the folder) | — |
| Grok Build | Reads this Claude marketplace, or `npx skills add artur0x0/surfcad-agent -a grok` | `grok mcp add surfcad -- npx -y surfcad-mcp@0.1.0` |
| Hermes | `hermes skills install artur0x0/surfcad-agent/plugins/surfcad/skills/surfcad` | `hermes mcp add surfcad --command npx --args -y surfcad-mcp@0.1.0` |
| Other agents | `npx skills add artur0x0/surfcad-agent` | Registry name, when published: `io.github.artur0x0/surfcad` |

The skill's frontmatter is only `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools`. `metadata.version` is the string `"0.1.0"`.
