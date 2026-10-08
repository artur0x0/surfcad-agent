# surfcad-mcp

Placeholder for the SurfCAD MCP server. Version 0.1.0. Apache-2.0. This package is `"private": true` and has no `bin`. Do not publish it.

The registry name is `mcpName`: `io.github.artur0x0/surfcad`. The plugin at `plugins/surfcad/.mcp.json` is already wired to `npx -y surfcad-mcp@0.1.0`. npm currently has only the `0.0.1` "coming soon" placeholder, so that `npx` invocation will not resolve until a later revision publishes a real server at 0.1.0.

There is no stdio entrypoint, no HTTP entrypoint, and no API key in this revision. The helper library the server will call is `packages/surfcad`.
