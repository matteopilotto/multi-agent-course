import { COLLECTIONS, newId, type MessageDoc, type ThreadDoc, type ThreadMessage } from '@lumina/contract';
import { db } from './db.js';
import { randomUUID } from 'node:crypto';

const threads = async () => (await db()).collection<ThreadDoc>(COLLECTIONS.threads);
const messages = async () => (await db()).collection<MessageDoc>(COLLECTIONS.messages);

/** Insert one thread row and return its id. `createdAt` is a real Date so Mongo can sort on it. */
export async function createThread(userId: string, title?: string): Promise<string> {
  const doc: ThreadDoc = {
    _id: newId('thr'),
    userId,
    title: title ?? 'New thread',
    createdAt: new Date()
  };
  await (await threads()).insertOne(doc);
  return doc._id;
}

/** null when the thread does not exist or belongs to someone else: both are a 404 to the caller. */
export async function findThread(userId: string, threadId: string): Promise<ThreadDoc | null> {
  return (await threads()).findOne({ _id: threadId, userId });
}

export async function listThreads(userId: string) {
  const rows = await (await threads()).find({ userId }).sort({ createdAt: -1 }).limit(50).toArray();
  return rows.map((t) => ({
    threadId: t._id,
    title: t.title,
    createdAt: new Date(t.createdAt).toISOString()
  }));
}

/** Oldest first, so the array reads top to bottom like the conversation. */
export async function threadMessages(threadId: string): Promise<ThreadMessage[]> {
  const rows = await (await messages()).find({ threadId }).sort({ createdAt: 1 }).toArray();
  return rows.map((m) => ({
    role: m.role,
    content: m.content,
    sources: m.sources,
    answerId: m.answerId,
    done: m.done,
    createdAt: new Date(m.createdAt).toISOString()
  }));
}

/**
 * The last `n` messages, role and content only, oldest first: all an answer reads of its thread.
 * The whole thread with its sources grew to 118 KB and 1.6-2.0 s from Atlas on the bench thread,
 * all of it paid before the stream opened. `threadMessages` stays for the UI, which shows it all.
 */
export async function recentMessages(threadId: string, n: number): Promise<ThreadMessage[]> {
  const rows = await (await messages())
    .find({ threadId }, { projection: { role: 1, content: 1 } })
    .sort({ createdAt: -1 })
    .limit(n)
    .toArray();
  return rows.reverse().map((m) => ({ role: m.role, content: m.content }));
}

/** The UI lists threads by title, so the first question becomes the title. */
export async function titleFromFirstQuery(threadId: string, query: string): Promise<void> {
  await (
    await threads()
  ).updateOne({ _id: threadId, title: 'New thread' }, { $set: { title: query.slice(0, 80) } });
}

export async function appendMessage(doc: Omit<MessageDoc, '_id' | 'createdAt'>): Promise<void> {
  await (await messages()).insertOne({ _id: randomUUID(), ...doc, createdAt: new Date() });
}
