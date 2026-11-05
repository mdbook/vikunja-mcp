# Vikunja MCP Server

Let your AI assistant manage tasks, projects, labels and teams in Vikunja.
This is an MCP server: your assistant runs it and calls its tools, not a web app or a command prompt.

## Install and connect

You need **Node.js 24+**, a running Vikunja instance, and an MCP client that
supports local stdio servers (for example, Claude Desktop). In Vikunja, open
**Settings > API Tokens**, create a token, and grant the project/task permissions
you need. Keep the token private.

In Claude Desktop, open **Settings > Developer > Edit Config**. Add this entry
to your client's MCP configuration (merge with any existing `mcpServers` entries),
replace the URL and token, save, then restart the client:

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "npx",
      "args": ["-y", "@joyjit/vikunja-mcp"],
      "env": {
        "VIKUNJA_URL": "https://vikunja.example.com/api/v1",
        "VIKUNJA_API_TOKEN": "replace-with-your-token"
      }
    }
  }
}
```

**The URL must end in `/api/v1`**, including any path prefix your instance uses,
for example `https://example.com/vikunja/api/v1`. Use the API address reachable
from the machine running your MCP client, not a project page URL.

The client starts the server for you. The first start downloads the npm package
and needs internet access. No clone, build, database or separate server start is
needed. The package name is still `@joyjit/vikunja-mcp`; it is not an
`@mdbook` package. See [source setup](docs/development.md) if you need changes
that have not reached npm.

**Docker users:** this server supports **stdio only**, not HTTP or SSE. `npx`
is the supported quick start. For a container-based client command, see
[Docker setup](docs/docker.md). Do not use `docker compose up` as an HTTP service.

## Try it

After restart, check that your client lists the Vikunja tools. Ask your assistant:

> List my Vikunja projects.

Then use a project name from that list:

> Create a task called "My first MCP task" in project "Personal".

Approve the tool call if your client asks. The assistant should report a task ID;
open that project in Vikunja and check that the task is there. These are prompts
for your assistant, not commands to paste into a terminal.

## Configuration

Only the URL and token above are needed for automatic connection. Put settings
in the MCP entry's `env` object; you do not need a `.env` file for this setup.

| Variable | Purpose | Default |
| --- | --- | --- |
| `VIKUNJA_URL` | Full API base URL ending in `/api/v1` | Required for automatic connection |
| `VIKUNJA_API_TOKEN` | API token (`tk_` prefix) or JWT | Required for automatic connection |
| `DEBUG` | Debug logging | `false` |
| `LOG_LEVEL` | `error`, `warn`, `info` or `debug` | `info` (`debug` when `DEBUG=true`) |
| `VIKUNJA_BULK_WRITE_CONCURRENCY` | Parallel bulk writes | `1` (safe for SQLite) |

API tokens are recommended. Their permissions limit what the assistant can do.
User and export tools require a JWT instead; JWTs expire and must be replaced.
The token type is detected automatically. Never commit credentials or share your
client config. Logs go to stderr; stdout is reserved for the MCP protocol.

Saved filters are held in memory and disappear when the server restarts.
Label writes are additive, not replace/clear operations. File attachments are
not implemented. See the [tool reference](docs/tools.md) for details.

## Troubleshooting

- **No tools / `npx` not found:** check Node.js is 24+ and available to the desktop
  app, not just your terminal. If needed, use the absolute path to `npx` in
  `command`, then fully quit and reopen the client.
- **Connection error / 404:** check the API URL ends in `/api/v1` and is reachable
  from the client (or container). `localhost` inside Docker means the container.
- **401:** check the token is valid and has not expired. **403:** check its
  permissions and access to the project; retrying will not grant access.
- **Server seems idle in a terminal:** it waits for MCP messages on stdin. Start
  it through your MCP client, then ask the assistant to use a tool.
- **More detail:** set `LOG_LEVEL` to `debug` and inspect your client's server
  logs. Remove credentials before sharing logs.

## More documentation

- [Tools, arguments and examples](docs/tools.md)
- [Docker setup](docs/docker.md)
- [Build from source and tests](docs/development.md)
- [Changelog and fork history](CHANGELOG.md)
- [Historical reports](docs/archive/README.md)

Maintained fork of [democratize-technology/vikunja-mcp](https://github.com/democratize-technology/vikunja-mcp).
Source: [mdbook/vikunja-mcp](https://github.com/mdbook/vikunja-mcp).
Licensed under [MIT](LICENSE).
