import { fetchPage } from './tools.js';
import { ProviderError } from './errors.js';

try {
  const text = await fetchPage('https://example.com');
  console.log({ threw: false, chars: text.length });
} catch (e) {
  console.log({
    threw: true,
    isProviderError: e instanceof ProviderError,
    status: e instanceof ProviderError ? e.status : undefined,
    message: (e as Error).message.slice(0, 80)
  });
}
process.exit(0);
