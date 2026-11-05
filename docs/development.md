# Build from source

[Back to setup](../README.md)

Use source setup for development or fixes not yet in the npm package.
You need Git and Node.js 24+; the MCP client and Vikunja prerequisites are the
same as in the README.

```sh
git clone https://github.com/mdbook/vikunja-mcp.git
cd vikunja-mcp
npm ci
```

`npm ci` runs the build through the package's `prepare` script. In the README's
MCP entry, change `command` to `node` and `args` to
`["/absolute/path/to/vikunja-mcp/dist/index.js"]`. Keep the same `env` values.
Save and restart the client. Rebuild with `npm run build` after changing source.

The npm package is named `@joyjit/vikunja-mcp` in `package.json` and the
release workflow. The source fork is `mdbook/vikunja-mcp`; these are different
names, not interchangeable install targets.

Run unit tests with `npm test`. The tests mock Vikunja and need no credentials.
See [MCP integration tests](MCP-INTEGRATION-CI.md) for tests against a disposable
Vikunja instance in Docker.

These docs describe the checked-out source. A branch or npm release may lag
another branch. Confirm which ref you are building rather than assuming a
published npm package contains every source fix.
