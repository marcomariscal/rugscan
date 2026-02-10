# MCP server (`assay mcp`)

Assay can run as an MCP (Model Context Protocol) server over stdio.

```bash
assay mcp
```

Notes:
- Communicates over stdin/stdout using JSON-RPC framing (`Content-Length`).
- Exposes Assay analysis as MCP tools.

## Tools

- `assay.analyzeTransaction`
- `assay.analyzeAddress`

## Claude Code setup

Add an MCP server entry in your Claude Code MCP config:

```json
{
  "mcpServers": {
    "assay": {
      "command": "assay",
      "args": ["mcp"]
    }
  }
}
```

Then Claude can call `assay.analyzeTransaction` / `assay.analyzeAddress` directly.
