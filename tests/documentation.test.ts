import { describe, expect, it } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (file: string): string => readFileSync(resolve(root, file), 'utf8');

type ClientConfig = {
  mcpServers: {
    vikunja: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  };
};

const clientConfig = (file: string): ClientConfig => {
  const block = read(file).match(/```json\n([\s\S]*?)\n```/);
  if (!block) throw new Error(`Missing client configuration in ${file}`);
  return JSON.parse(block[1]) as ClientConfig;
};

describe('README setup documentation', () => {
  it('provides a minimal npx config for the actual package and full API URL', () => {
    const server = clientConfig('README.md').mcpServers.vikunja;
    const pkg = JSON.parse(read('package.json')) as { name: string };

    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', pkg.name]);
    expect(new URL(server.env.VIKUNJA_URL).pathname).toMatch(/\/api\/v1$/);
    expect(server.env.VIKUNJA_API_TOKEN).toBe('replace-with-your-token');
  });

  it('keeps setup before the reference and has one configuration section', () => {
    const readme = read('README.md');

    expect(readme.trim().split('\n').length).toBeLessThanOrEqual(150);
    expect(readme.match(/^## Configuration$/gm)).toHaveLength(1);
    expect(readme.indexOf('```json')).toBeLessThan(readme.indexOf('## Try it'));
    expect(readme).not.toContain('vikunja_tasks.create(');
  });

  it('documents a Docker client command with open stdin and forwarded credentials', () => {
    const server = clientConfig('docs/docker.md').mcpServers.vikunja;

    expect(server.command).toBe('docker');
    expect(server.args).toEqual([
      'run',
      '--rm',
      '-i',
      '-e',
      'VIKUNJA_URL',
      '-e',
      'VIKUNJA_API_TOKEN',
      'vikunja-mcp:local',
    ]);
    expect(server.args).not.toContain('-t');
    expect(new URL(server.env.VIKUNJA_URL).pathname).toMatch(/\/api\/v1$/);
    expect(server.env.VIKUNJA_API_TOKEN).toBe('replace-with-your-token');
  });

  it.each([
    'README.md',
    'docs/docker.md',
    'docs/development.md',
    'docs/tools.md',
    'docs/archive/README.md',
  ])('keeps relative documentation links reachable in %s', (file) => {
    for (const match of read(file).matchAll(/\]\(([^)]+)\)/g)) {
      const href = match[1];
      if (/^(?:[a-z]+:|#)/i.test(href)) continue;
      const target = href.split('#')[0];
      expect(existsSync(resolve(root, dirname(file), target))).toBe(true);
    }
  });
});
