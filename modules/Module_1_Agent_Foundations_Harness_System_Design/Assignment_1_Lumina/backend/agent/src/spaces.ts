import { COLLECTIONS, newId, type ListSpacesResponse, type SpaceDoc } from '@lumina/contract';
import { db } from './db.js';

const spaces = async () => (await db()).collection<SpaceDoc>(COLLECTIONS.spaces);

/** The function owns id + timestamp; the caller supplies what the user typed. */
export async function createSpace(userId: string, name: string): Promise<SpaceDoc> {
  const doc: SpaceDoc = { _id: newId('spc'), userId, name, createdAt: new Date() };
  await (await spaces()).insertOne(doc);
  return doc;
}

/** null when the id does not exist OR belongs to someone else: both are a 404 to the caller. */
export async function findSpace(userId: string, spaceId: string): Promise<SpaceDoc | null> {
  return (await spaces()).findOne({ _id: spaceId, userId });
}

/** Contract shape for GET /spaces: newest first, createdAt as ISO. */
export async function listSpaces(userId: string): Promise<ListSpacesResponse['spaces']> {
  const rows = await (await spaces()).find({ userId }).sort({ createdAt: -1 }).limit(100).toArray();
  return rows.map((s) => ({
    spaceId: s._id,
    name: s.name,
    createdAt: new Date(s.createdAt).toISOString()
  }));
}
