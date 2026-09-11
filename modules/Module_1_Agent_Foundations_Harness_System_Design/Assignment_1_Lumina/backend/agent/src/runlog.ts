import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RunLog } from '@lumina/contract';
import { env } from './env.js';

/** One runs/<requestId>.json per answer. Validated against the contract first: drift fails here, not in the grader. */
export function writeRunLog(requestId: string, log: RunLog): void {
  RunLog.parse(log);
  writeFileSync(resolve(env.runsDir, `${requestId}.json`), JSON.stringify(log, null, 2));
}
