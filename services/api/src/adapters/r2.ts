import type { R2Bucket, R2Object, R2ObjectBody } from '@cloudflare/workers-types/index';
import type { BlobMeta, BlobStore } from '../deps.js';

const metaOf = (o: R2Object): BlobMeta => ({
  key: o.key,
  size: o.size,
  etag: o.etag,
  contentType: o.httpMetadata?.contentType ?? null,
});

const hasBody = (o: R2Object | R2ObjectBody | null): o is R2ObjectBody => o !== null && 'arrayBuffer' in o;

/** `BlobStore` backed by a Cloudflare R2 bucket binding. */
export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async head(key: string): Promise<BlobMeta | null> {
    const o = await this.bucket.head(key);
    return o ? metaOf(o) : null;
  }

  async get(key: string): Promise<{ meta: BlobMeta; body: ReadableStream<Uint8Array> } | null> {
    const o = await this.bucket.get(key);
    if (!hasBody(o)) return null;
    // Workers' ReadableStream type differs nominally from the lib type used by the app.
    return { meta: metaOf(o), body: o.body as unknown as ReadableStream<Uint8Array> };
  }

  async getRange(key: string, offset: number, length: number): Promise<{ meta: BlobMeta; data: ArrayBuffer } | null> {
    let o: R2Object | R2ObjectBody | null;
    try {
      o = await this.bucket.get(key, { range: { offset, length } });
    } catch (err) {
      // A range past the end of a small object: clamp to the real size and retry once.
      const head = await this.bucket.head(key);
      if (!head) return null;
      if (offset >= head.size) return { meta: metaOf(head), data: new ArrayBuffer(0) };
      if (offset + length <= head.size) throw err;
      o = await this.bucket.get(key, { range: { offset, length: head.size - offset } });
    }
    if (!hasBody(o)) return null;
    return { meta: metaOf(o), data: await o.arrayBuffer() };
  }
}
