import { ApplicationConfigSchema, Environment } from '../../src/config/types';

describe('configuration schema defaults', () => {
  it('parses omitted sections through their nested defaults', () => {
    const config = ApplicationConfigSchema.parse({});

    expect(config.environment).toBe(Environment.DEVELOPMENT);
    expect(config.auth).toEqual({});
    expect(config.logging).toEqual({ level: 'info', environment: Environment.DEVELOPMENT });
    expect(config.rateLimiting.default.requestsPerMinute).toBe(60);
    expect(config.rateLimiting.expensive.executionTimeout).toBe(120000);
    expect(config.rateLimiting.bulk.requestsPerMinute).toBe(5);
    expect(config.rateLimiting.export.maxResponseSize).toBe(1073741824);
    expect(ApplicationConfigSchema.parse({ auth: {}, logging: {}, rateLimiting: {} })).toEqual(config);
  });
});
