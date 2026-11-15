# Architecture

The Vikunja MCP project follows MCP SDK best practices:

- **MCP Server**: Built with `@modelcontextprotocol/sdk`
- **Transport**: StdIO for Claude Desktop integration
- **Tools**: Zod-validated parameters with subcommand pattern
- **Authentication**: Session-based with AuthManager
- **Error Handling**: Custom MCPError with proper error codes
- **Type Safety**: Full TypeScript with strict mode

## Component Overview

### AuthManager
Handles session management and authentication state:
- Supports both API tokens and JWT authentication
- Maintains single instance throughout server lifetime
- Automatic token refresh for JWT sessions

### Tool Pattern
Each tool follows a consistent subcommand pattern:
- Main command with subcommands for related operations
- Zod validation for all parameters
- Standardized response formats
- Comprehensive error handling

### Client Management
Uses singleton pattern for Vikunja client:
- Single client instance per session
- Automatic cleanup on disconnect
- Thread-safe authentication state

### Error Hierarchy
- `MCPError` - Base error class with proper error codes
- Tool-specific error handling with helpful messages
- API error translation to user-friendly messages

### Retry Logic
Implements exponential backoff for transient failures:
- Deterministic HTTP 401/403 and other permanent 4xx errors fail immediately,
  even with a custom retry predicate; the same credentials/request are not repaired by retrying
- Network errors: 5 retries with 500ms initial delay, 1.5x backoff factor
- HTTP 408/429, 5xx and transient network/SQLite lock errors remain retryable
- Maximum delay capped at 30s for network errors
- Non-retryable errors (validation, not found) fail immediately
- Error messages include retry count for transparency

### Application availability breaker

`src/utils/retry.ts` uses Opossum with a 50% error-rate threshold and a minimum
volume of 5 attempts, a 30s operation timeout and a 30s reset timeout. After the
reset timeout, a half-open probe can close the breaker on success. Retries are
separate attempts for breaker accounting. Permanent HTTP 4xx errors (except
408/429) and status-less authentication errors are filtered from failure
accounting but still rejected to the caller.

The registry is process-wide, keyed by **breaker name**, not session or resource.
Named configurations share state across callers using that name (for example,
`vikunja-auth-connect`); task helpers use operation names such as
`vikunja-task-get`. Anonymous `withRetry` calls get a unique per-call key.
Authentication/session changes do not clear this registry.

This describes the application's retry helper, not any resilience policy inside
`node-vikunja`. Comment operations call the SDK directly; their end-to-end
availability behavior also depends on that dependency.
