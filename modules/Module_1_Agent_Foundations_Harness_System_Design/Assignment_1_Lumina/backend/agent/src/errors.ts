/**
 * A provider refused us, as opposed to one page or one document failing. This ends a run
 * (rule A1) and, in the worker, decides whether the job is worth retrying. It lives here
 * rather than in an adapter because three modules that do different jobs all need it.
 */
export class ProviderError extends Error {
    /** The provider's HTTP status, or undefined when the call never got a reply at all. */
    readonly status: number | undefined;
  
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'ProviderError';
      this.status = status;
    }
  
    /** Rate limited, overloaded, or no reply: worth another go. A bad key or a bad request: never. */
    get retryable(): boolean {
      return this.status === undefined || this.status === 408 || this.status === 429 || this.status >= 500;
    }
  }
  