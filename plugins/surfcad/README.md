# SurfCAD plugin

This folder is the SurfCAD plugin for Claude Code, claude.ai, and other agents that read a Claude marketplace. It models complete 3D parts and assemblies on the Manifold kernel used by SurfCAD (surfcad.com). You bring your own model. The plugin does not embed an API key, and it does not phone home to a model provider.

The skill lives at `skills/surfcad/SKILL.md`. The folder name and the frontmatter `name` are both `surfcad`. Reference docs next to the skill cover the helper catalog, the Manifold build this app ships, the `.surf.json` assembly file, sheet metal, a modeling workflow, failure recovery, and runnable examples. Install the marketplace `surfcad-agent` from this repository, then install the plugin `surfcad`.

`.mcp.json` launches the stdio server with `npx -y surfcad-mcp@0.1.0` when that package version is published. Until then the skill still loads, and Chat-style clients that ignore local stdio servers get the skill without tools. There is no `bin/` directory in this plugin. The license is Apache-2.0.
