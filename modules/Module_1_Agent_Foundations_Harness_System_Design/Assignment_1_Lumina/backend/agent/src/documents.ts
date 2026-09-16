import { randomUUID } from 'node:crypto';
import { GridFSBucket, ObjectId, type UpdateFilter } from 'mongodb';
import {
  COLLECTIONS,
  GRIDFS_BUCKETS,
  newId,
  type DocumentDoc,
  type DocumentRow,
  type JobDoc
} from '@lumina/contract';
import { db } from './db.js';
import { enqueueJob } from './jobs.js';

const documents = async () => (await db()).collection<DocumentDoc>(COLLECTIONS.documents);
let bucket: GridFSBucket | null = null;
/** One bucket per process: the driver verifies GridFS's own indexes once per instance, and that is round trips. */
export async function uploads(): Promise<GridFSBucket> {
  bucket ??= new GridFSBucket(await db(), { bucketName: GRIDFS_BUCKETS.uploads });
  return bucket;
}

/** Write the raw bytes to GridFS under an id we chose, so the document row can reference it before the write lands. */
async function storeUpload(
  buffer: Buffer,
  fileId: ObjectId,
  filename: string,
  mimeType: string
): Promise<void> {
  const stream = (await uploads()).openUploadStreamWithId(fileId, filename, { metadata: { mimeType } });
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
    stream.end(buffer);
  });
}

/** The raw bytes back out of GridFS, for the worker. */
export async function readUpload(fileId: string): Promise<Buffer> {
  const stream = (await uploads()).openDownloadStream(new ObjectId(fileId));
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/**
 * The receipt: bytes to GridFS and a `pending` document row in parallel, then the `pending`
 * job row. The job is the trigger, so it is written last: a worker must never claim work
 * whose inputs are not there yet.
 */
export async function createDocument(input: {
  userId: string;
  spaceId: string;
  title: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<string> {
  const createdAt = new Date();
  const fileId = new ObjectId();
  const doc: DocumentDoc = {
    _id: newId('doc'),
    spaceId: input.spaceId,
    userId: input.userId,
    title: input.title,
    mimeType: input.mimeType,
    bytes: input.buffer.length,
    status: 'pending',
    pct: 0,
    fileId: fileId.toHexString(),
    createdAt
  };
  const job: JobDoc = {
    _id: randomUUID(),
    kind: 'index_document',
    status: 'pending',
    payload: { docId: doc._id, spaceId: doc.spaceId, userId: doc.userId },
    userId: input.userId,
    attempts: 0,
    createdAt
  };
  await Promise.all([
    storeUpload(input.buffer, fileId, input.title, input.mimeType),
    (await documents()).insertOne(doc)
  ]);
  await enqueueJob(job);
  return doc._id;
}

/** Contract shape for GET /spaces/:id/documents, oldest first so the list is stable while uploads land. */
export async function listDocuments(userId: string, spaceId: string): Promise<DocumentRow[]> {
  const rows = await (await documents()).find({ userId, spaceId }).sort({ createdAt: 1 }).toArray();
  return rows.map((d) => ({
    docId: d._id,
    title: d.title,
    status: d.status,
    pct: d.pct,
    ...(d.pages !== undefined ? { pages: d.pages } : {}),
    ...(d.chunks !== undefined ? { chunks: d.chunks } : {}),
    ...(d.error ? { error: d.error } : {})
  }));
}

/** The worker's only write to `documents`. Every status change goes through here so it is one place to grep. */
export async function setDocumentStatus(
  docId: string,
  patch: Partial<Pick<DocumentDoc, 'status' | 'pct' | 'pages' | 'chunks' | 'error'>>
): Promise<void> {
  const { error, ...rest } = patch;
  // `error: undefined` means "clear it": the driver drops undefined from $set, so clearing needs $unset.
  const clearError = error === undefined && 'error' in patch;
  const fields = clearError ? rest : patch;
  const update: UpdateFilter<DocumentDoc> = {};
  if (Object.keys(fields).length) update.$set = fields;
  if (clearError) update.$unset = { error: '' };
  // Mongo rejects an update with no operators, and nothing legitimately asks to write nothing.
  if (!update.$set && !update.$unset) throw new Error(`setDocumentStatus(${docId}) got an empty patch`);
  await (await documents()).updateOne({ _id: docId }, update);
}

export async function findDocument(docId: string): Promise<DocumentDoc | null> {
  return (await documents()).findOne({ _id: docId });
}
