import "./load-env";
import { QdrantClient } from "@qdrant/js-client-rest";

const client = new QdrantClient({
  url: process.env.QDRANT_URL!,
  apiKey: process.env.QDRANT_API_KEY,
});

const COLLECTION = process.env.QDRANT_COLLECTION ?? "leads_docs";
const VECTOR_SIZE = 1024; // text-embedding-3-small at 1024 dimensions (lib/cohere.ts)

async function main() {
  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION);

  if (exists) {
    console.log(`Collection "${COLLECTION}" already exists.`);
    return;
  }

  await client.createCollection(COLLECTION, {
    vectors: {
      size: VECTOR_SIZE,
      distance: "Cosine",
      hnsw_config: {
        m: 16,
        ef_construct: 100,
      },
    },
    optimizers_config: {
      default_segment_number: 2,
    },
    replication_factor: 1,
  });

  // Create payload index for doc_id filtering
  await client.createPayloadIndex(COLLECTION, {
    field_name: "doc_id",
    field_schema: "keyword",
  });

  console.log(`Collection "${COLLECTION}" created with HNSW (dim=${VECTOR_SIZE}, Cosine)`);
  console.log(`Payload index created on "doc_id"`);
}

main().catch((err) => {
  console.error("Init failed:", err);
  process.exit(1);
});
