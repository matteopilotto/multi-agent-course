import type { Response } from 'express';
import type { SseEventName } from '@lumina/contract';

/** Turn a normal HTTP response into an open event stream. Call once, before the first event. */
export function openStream(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // tells nginx-style proxies not to buffer
  res.flushHeaders(); // send the 200 + headers NOW, not with the first body byte
}

/** One SSE frame: "event: name\ndata: <json>\n\n". */
export function send(res: Response, event: SseEventName, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
