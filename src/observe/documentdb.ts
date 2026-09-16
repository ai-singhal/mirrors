import { MongoClient } from 'mongodb';
import { normalizeRuns, type IngestOptions } from './normalize.js';
import type { ObservationStore } from './database.js';
export async function ingestDocumentDB(
  store: ObservationStore,
  options: IngestOptions & {
    uriEnv: string;
    database: string;
    collection: string;
    caFile?: string;
    limit?: number;
    query?: Record<string, unknown>;
  },
) {
  const uri = process.env[options.uriEnv];
  if (!uri) throw Error(`Set the read-only URI in ${options.uriEnv}`);
  const client = new MongoClient(uri, {
    retryWrites: false,
    serverSelectionTimeoutMS: 10000,
    ...(options.caFile ? { tls: true, tlsCAFile: options.caFile } : {}),
  });
  let imported = 0,
    documents = 0;
  const warnings: string[] = [];
  try {
    await client.connect();
    const cursor = client
      .db(options.database)
      .collection(options.collection)
      .find(options.query ?? {}, { limit: options.limit ?? 10000, batchSize: 100 });
    for await (const doc of cursor) {
      documents++;
      try {
        const rows = normalizeRuns(
          doc,
          `documentdb:${options.database}/${options.collection}`,
          options,
        );
        if (!rows.length) warnings.push(`Document ${documents}: no supported run`);
        for (const run of rows) {
          store.ingest(run);
          imported++;
        }
      } catch {
        warnings.push(`Document ${documents}: could not normalize`);
      }
    }
    store.audit('documentdb-ingest', {
      database: options.database,
      collection: options.collection,
      documents,
      imported,
    });
    return { documents, imported, warnings };
  } catch {
    throw Error(
      'DocumentDB ingestion failed. Check read-only credentials, network access, database/collection and TLS CA. The connection URI is not logged.',
    );
  } finally {
    await client.close();
  }
}
