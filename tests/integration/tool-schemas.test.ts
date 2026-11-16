import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuthManager } from '../../src/auth/AuthManager';
import type { VikunjaClientFactory } from '../../src/client';
import { factoryInitializationPromise } from '../../src/index';
import { registerTools } from '../../src/tools';

describe('Zod 4 tool schemas over MCP (ticket 2743)', () => {
  it('lists every tool with JSON schemas and validates calls before invoking handlers', async () => {
    await factoryInitializationPromise;
    const auth = new AuthManager();
    jest.spyOn(auth, 'isAuthenticated').mockReturnValue(true);
    jest.spyOn(auth, 'getAuthType').mockReturnValue('jwt');
    const server = new McpServer({ name: 'schema-test', version: '1.0.0' });
    const client = new Client({ name: 'schema-test-client', version: '1.0.0' });
    // Registration needs a factory only to enable the full tool set; these calls never use it.
    registerTools(server, auth, {} as VikunjaClientFactory);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(20);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object');
        expect(Object.keys(tool.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
      }

      const schemaFor = (name: string) => tools.find(tool => tool.name === name)!.inputSchema;
      expect(schemaFor('vikunja_task_crud').required).toContain('operation');
      expect(schemaFor('vikunja_templates').properties?.variables).toMatchObject({
        type: 'object', additionalProperties: { type: 'string' },
      });
      expect(schemaFor('vikunja_filters').properties?.parameters).toMatchObject({ type: 'object' });
      expect(schemaFor('vikunja_users').properties?.frontendSettings).toMatchObject({ type: 'object' });
      expect(schemaFor('vikunja_labels').properties?.subcommand).toMatchObject({ default: 'list' });
      expect(schemaFor('vikunja_labels').required ?? []).not.toContain('subcommand');

      const status = await client.callTool({ name: 'vikunja_auth', arguments: { subcommand: 'status' } });
      expect(status.isError).not.toBe(true);
      for (const [name, args] of [
        ['vikunja_task_crud', { operation: 'not-an-operation' }],
        ['vikunja_task_crud', {}],
        ['vikunja_templates', { subcommand: 'instantiate', variables: { name: 123 } }],
        ['vikunja_filters', { action: 'list', parameters: 'not-an-object' }],
        ['vikunja_users', { subcommand: 'update-settings', frontendSettings: [] }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual(expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining('Input validation error') }),
        ]));
      }
    } finally {
      await client.close();
      await server.close();
      jest.restoreAllMocks();
    }
  });
});
