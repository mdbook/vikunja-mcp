import {
  circuitBreakerRegistry,
  createCircuitBreaker,
  withRetry,
} from '../../src/utils/retry';

jest.mock('../../src/utils/logger');

describe('availability breaker request-error isolation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    circuitBreakerRegistry.clear();
  });

  afterEach(() => {
    circuitBreakerRegistry.clear();
    jest.useRealTimers();
  });

  it.each([400, 401, 403, 404, 409, 422])(
    'keeps shared-key get/list operations available after HTTP %i failures',
    async statusCode => {
      const error = Object.assign(new Error('Network timeout while editing a comment'), {
        statusCode,
        // node-vikunja response is the JSON body, not an HTTP response.
        response: { message: 'request rejected', code: 1 },
      });
      const editComment = jest.fn().mockRejectedValue(error);
      const shouldRetry = jest.fn().mockReturnValue(true);
      const options = { circuitBreakerName: 'mixed-operations', shouldRetry };

      // Exceed the default volume threshold. Each rejection must reach the
      // caller unchanged, without retries or availability failures.
      for (let i = 0; i < 6; i++) {
        await expect(withRetry(editComment, options)).rejects.toBe(error);
      }
      expect(editComment).toHaveBeenCalledTimes(6);
      expect(shouldRetry).not.toHaveBeenCalled();

      const breaker = circuitBreakerRegistry.get(options.circuitBreakerName)!;
      expect(breaker.stats.failures).toBe(0);
      expect(breaker.opened).toBe(false);

      const getTask = jest.fn().mockResolvedValue({ id: 1 });
      const listTasks = jest.fn().mockResolvedValue([{ id: 1 }]);
      await expect(withRetry(getTask, options)).resolves.toEqual({ id: 1 });
      await expect(withRetry(listTasks, options)).resolves.toEqual([{ id: 1 }]);
      expect(getTask).toHaveBeenCalledTimes(1);
      expect(listTasks).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { statusCode: 401 },
    { status: 403 },
    { response: { status: 422 } },
  ])('filters Error-like HTTP failures as well as Error instances: %j', async error => {
    const operation = jest.fn().mockRejectedValue(error);
    const breaker = createCircuitBreaker(operation, 'error-like', { volumeThreshold: 1 });

    await expect(breaker.fire()).rejects.toBe(error);
    expect(breaker.stats.failures).toBe(0);
    expect(breaker.opened).toBe(false);
  });

  it.each([408, 429, 503])(
    'still opens on transient HTTP %i failures and recovers after the reset timeout',
    async statusCode => {
      const error = Object.assign(new Error('upstream unavailable'), { statusCode });
      const operation = jest.fn().mockRejectedValue(error);
      const breaker = createCircuitBreaker(operation, 'transient');

      for (let i = 0; i < 5; i++) {
        await expect(breaker.fire()).rejects.toBe(error);
      }
      expect(breaker.stats.failures).toBe(5);
      expect(breaker.opened).toBe(true);
      await expect(breaker.fire()).rejects.toThrow('Breaker is open');
      expect(operation).toHaveBeenCalledTimes(5);

      await jest.advanceTimersByTimeAsync(30000);
      expect(breaker.halfOpen).toBe(true);
      operation.mockResolvedValue('recovered');
      await expect(breaker.fire()).resolves.toBe('recovered');
      expect(breaker.closed).toBe(true);
    },
  );
});
