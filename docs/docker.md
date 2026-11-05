# Docker setup (stdio)

[Back to setup](../README.md)

The server uses stdin/stdout for MCP. It has no HTTP listener or port to expose.
Use the [npx setup](../README.md#install-and-connect) unless your MCP client can
launch Docker commands on a machine with Docker installed and running.

## Build and connect

From a checkout of this repository, build the existing Dockerfile:

```sh
docker build -t vikunja-mcp:local .
```

Use this MCP client entry instead of the npx entry, replacing the URL and token:

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "VIKUNJA_URL", "-e", "VIKUNJA_API_TOKEN", "vikunja-mcp:local"],
      "env": {
        "VIKUNJA_URL": "https://vikunja.example.com/api/v1",
        "VIKUNJA_API_TOKEN": "replace-with-your-token"
      }
    }
  }
}
```

Save and restart the client, then follow [Try it](../README.md#try-it).
Docker must be available to the client, not just your terminal.
Use `-i` to keep stdin open. Do not add `-t`: a terminal can corrupt MCP output.
No port mapping, volume or persistent MCP database is needed.

The URL must be reachable **from the container** and end in `/api/v1`.
If Vikunja runs on the host, `localhost` will not point to it. Use a reachable
hostname, a shared Docker network, or your platform's host gateway.
The `-e` arguments forward the two variables supplied by the MCP client without
putting token values in command-line arguments.

## Why no Compose service or published-image quick start?

A detached `docker compose up` service does not connect its stdio to your MCP
client. It would not provide an HTTP MCP endpoint. The client should launch one
process per connection, as above.

This checkout has an image workflow targeting `ghcr.io/mdbook/vikunja-mcp`.
Its configured tags are `latest`, the branch name and a short SHA. That workflow
is not proof that an image is publicly available or matches an npm release.
Until public pull access and a release tag policy are verified, these instructions
use a local build rather than claim a published image is ready to use.
