import { withRetry, isTransientError, isRetryableError, RETRY_CONFIG, circuitBreakerRegistry } from '../../src/utils/retry';
import { logger } from '../../src/utils/logger';

jest.mock('../../src/utils/logger');

describe('retry utility', () => {
  const noBreaker = { enableCircuitBreaker: false };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    circuitBreakerRegistry.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('withRetry', () => {
    it('should return result on successful operation', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      
      const result = await withRetry(operation, noBreaker);
      
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on a transient server error', async () => {
      const serverError = new Error('Internal Server Error');
      
      const operation = jest.fn()
        .mockRejectedValueOnce(serverError)
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce('success');
      
      const promise = withRetry(operation, noBreaker);
      
      // First retry after 1000ms
      await jest.advanceTimersByTimeAsync(1000);
      // Second retry after 2000ms (1000 * 2^1)
      await jest.advanceTimersByTimeAsync(2000);
      
      const result = await promise;
      
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
      expect(logger.debug).toHaveBeenCalledTimes(2);
    });

    it('should retry on transient network error', async () => {
      const networkError = new Error('ECONNRESET: connection reset');
      
      const operation = jest.fn()
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce('success');
      
      const promise = withRetry(operation, noBreaker);
      
      await jest.advanceTimersByTimeAsync(1000);
      
      const result = await promise;
      
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should throw after max retries', async () => {
      const serverError = new Error('Internal Server Error');
      
      const operation = jest.fn().mockRejectedValue(serverError);
      
      const promise = withRetry(operation, { ...noBreaker, maxRetries: 2 });
      
      // Handle the rejection to avoid unhandled promise rejection
      promise.catch(() => {});
      
      // First retry
      await jest.advanceTimersByTimeAsync(1000);
      // Second retry
      await jest.advanceTimersByTimeAsync(2000);
      
      await expect(promise).rejects.toThrow('Internal Server Error');
      expect(operation).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should not retry on non-retryable error', async () => {
      const validationError = new Error('Invalid input');
      
      const operation = jest.fn().mockRejectedValue(validationError);
      
      await expect(withRetry(operation, noBreaker)).rejects.toThrow('Invalid input');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should use custom retry options', async () => {
      const error = new Error('Custom error');
      const customShouldRetry = jest.fn().mockReturnValue(true);
      
      const operation = jest.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce('success');
      
      const promise = withRetry(operation, {
        ...noBreaker,
        maxRetries: 1,
        initialDelay: 500,
        maxDelay: 5000,
        backoffFactor: 3,
        shouldRetry: customShouldRetry
      });
      
      await jest.advanceTimersByTimeAsync(500);
      
      const result = await promise;
      
      expect(result).toBe('success');
      expect(customShouldRetry).toHaveBeenCalledWith(error);
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should respect max delay', async () => {
      const error = new Error('Network error');
      
      const operation = jest.fn().mockRejectedValue(error);
      
      const promise = withRetry(operation, {
        ...noBreaker,
        maxRetries: 5,
        initialDelay: 1000,
        maxDelay: 3000,
        backoffFactor: 2
      });
      
      // Handle the rejection to avoid unhandled promise rejection
      promise.catch(() => {});
      
      // Delays should be: 1000, 2000, 3000 (capped), 3000 (capped), 3000 (capped)
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(3000);
      
      await expect(promise).rejects.toThrow('Network error');
      expect(operation).toHaveBeenCalledTimes(6); // initial + 5 retries
    });

    it('should handle non-Error objects', async () => {
      const stringError = 'String error';
      
      const operation = jest.fn()
        .mockRejectedValueOnce(stringError)
        .mockResolvedValueOnce('success');
      
      // String errors are not retryable by default
      await expect(withRetry(operation, noBreaker)).rejects.toBe('String error');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should calculate exponential backoff correctly', async () => {
      const error = new Error('Network error');
      
      const operation = jest.fn().mockRejectedValue(error);
      const debugCalls: any[] = [];
      
      (logger.debug as jest.Mock).mockImplementation((msg, data) => {
        debugCalls.push({ msg, data });
      });
      
      const promise = withRetry(operation, {
        ...noBreaker,
        maxRetries: 3,
        initialDelay: 100,
        backoffFactor: 2
      });
      
      // Handle the rejection to avoid unhandled promise rejection
      promise.catch(() => {});
      
      // First retry: 100ms
      await jest.advanceTimersByTimeAsync(100);
      expect(debugCalls[0].msg).toContain('Retrying operation after 100ms');
      
      // Second retry: 200ms (100 * 2^1)
      await jest.advanceTimersByTimeAsync(200);
      expect(debugCalls[1].msg).toContain('Retrying operation after 200ms');
      
      // Third retry: 400ms (100 * 2^2)
      await jest.advanceTimersByTimeAsync(400);
      expect(debugCalls[2].msg).toContain('Retrying operation after 400ms');
      
      await expect(promise).rejects.toThrow('Network error');
    });

    it('should not retry when maxRetries is 0', async () => {
      const error = new Error('Internal Server Error');
      (error as Error & { status: number }).status = 500;
      const operation = jest.fn().mockRejectedValue(error);

      await expect(
        withRetry(operation, { ...noBreaker, maxRetries: 0 }),
      ).rejects.toThrow('Internal Server Error');
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('isTransientError', () => {
    it('should identify timeout errors', () => {
      expect(isTransientError(new Error('Request timeout'))).toBe(true);
      expect(isTransientError(new Error('Operation timed out'))).toBe(true);
      expect(isTransientError(new Error('ETIMEDOUT'))).toBe(true);
    });

    it('should identify connection reset errors', () => {
      expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
      expect(isTransientError(new Error('Connection reset by peer'))).toBe(true);
    });

    it('should identify socket errors', () => {
      expect(isTransientError(new Error('socket hang up'))).toBe(true);
      expect(isTransientError(new Error('Socket closed unexpectedly'))).toBe(true);
    });

    it('should identify network errors', () => {
      expect(isTransientError(new Error('Network error'))).toBe(true);
      expect(isTransientError(new Error('Unable to connect to network'))).toBe(true);
    });

    it('should identify SQLite lock and HTTP 5xx as transient', () => {
      expect(isTransientError(new Error('database is locked'))).toBe(true);
      expect(isTransientError(new Error('Internal Server Error'))).toBe(true);
      const statusError = new Error('server boom');
      (statusError as Error & { statusCode: number }).statusCode = 503;
      expect(isTransientError(statusError)).toBe(true);
    });

    it('should not identify non-transient errors', () => {
      expect(isTransientError(new Error('Invalid input'))).toBe(false);
      expect(isTransientError(new Error('Authentication failed'))).toBe(false);
      expect(isTransientError(new Error('Not found'))).toBe(false);
    });

    it('should handle non-Error objects', () => {
      expect(isTransientError('string error')).toBe(false);
      expect(isTransientError(null)).toBe(false);
      expect(isTransientError(undefined)).toBe(false);
      expect(isTransientError({})).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(isTransientError(new Error('TIMEOUT'))).toBe(true);
      expect(isTransientError(new Error('Network Error'))).toBe(true);
      expect(isTransientError(new Error('SOCKET HANG UP'))).toBe(true);
    });
  });

  describe('isRetryableError', () => {
    it.each([400, 401, 403, 404, 405, 409, 422])(
      'should not retry or classify HTTP %i as transient, regardless of message',
      statusCode => {
        const error = Object.assign(new Error('Network timeout: database is locked'), {
          statusCode,
        });
        expect(isRetryableError(error)).toBe(false);
        expect(isTransientError(error)).toBe(false);
      },
    );

    it.each(['Unauthorized', '403 Forbidden', 'Authentication failed', 'invalid token'])(
      'should not retry an authentication failure without a status: %s',
      message => {
        expect(isRetryableError(new Error(message))).toBe(false);
      },
    );

    it.each([408, 429, 500, 503])('should retain transient HTTP %i handling', status => {
      const error = Object.assign(new Error('upstream failure'), { status });
      expect(isRetryableError(error)).toBe(true);
      expect(isTransientError(error)).toBe(true);
    });

    it('should retry Internal Server Error and SQLite lock messages', () => {
      expect(isRetryableError(new Error('Internal Server Error'))).toBe(true);
      expect(isRetryableError(new Error('database is locked'))).toBe(true);
      expect(isRetryableError(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
    });

    it('should retry HTTP 5xx and 429 via status fields', () => {
      const locked = new Error('write failed');
      (locked as Error & { status: number }).status = 500;
      expect(isRetryableError(locked)).toBe(true);

      const rateLimited = new Error('slow down');
      (rateLimited as Error & { statusCode: number }).statusCode = 429;
      expect(isRetryableError(rateLimited)).toBe(true);

      const nested = new Error('upstream');
      (nested as Error & { response: { status: number } }).response = { status: 502 };
      expect(isRetryableError(nested)).toBe(true);

      const nonNumeric = new Error('weird status');
      (nonNumeric as Error & { status: string }).status = '500';
      expect(isRetryableError(nonNumeric)).toBe(false);

      const infinite = new Error('infinite');
      (infinite as Error & { statusCode: number }).statusCode = Number.POSITIVE_INFINITY;
      expect(isRetryableError(infinite)).toBe(false);
    });

    it('should not retry client validation errors', () => {
      expect(isRetryableError(new Error('Invalid input'))).toBe(false);
      const notFound = new Error('missing');
      (notFound as Error & { statusCode: number }).statusCode = 404;
      expect(isRetryableError(notFound)).toBe(false);
    });

    it('should retry when withRetry sees a lock error then succeeds', async () => {
      const lockError = new Error('Internal Server Error');
      (lockError as Error & { status: number }).status = 500;
      const operation = jest.fn()
        .mockRejectedValueOnce(lockError)
        .mockResolvedValueOnce('created');

      const promise = withRetry(operation, { ...noBreaker, initialDelay: 100 });
      await jest.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBe('created');
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('RETRY_CONFIG', () => {
    it('should have AUTH_ERRORS configuration', () => {
      expect(RETRY_CONFIG.AUTH_ERRORS).toEqual({
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 10000,
        backoffFactor: 2,
        enableCircuitBreaker: true,
        circuitBreakerName: 'vikunja-auth-connect'
      });
    });

    it('should have NETWORK_ERRORS configuration', () => {
      expect(RETRY_CONFIG.NETWORK_ERRORS).toEqual({
        maxRetries: 5,
        initialDelay: 500,
        maxDelay: 30000,
        backoffFactor: 1.5,
        enableCircuitBreaker: true,
        circuitBreakerName: 'vikunja-api-operations'
      });
    });

    it('should have BULK_WRITES configuration without a shared breaker', () => {
      expect(RETRY_CONFIG.BULK_WRITES).toEqual({
        maxRetries: 3,
        initialDelay: 200,
        maxDelay: 5000,
        backoffFactor: 2,
        enableCircuitBreaker: false,
      });
    });
  });
});
