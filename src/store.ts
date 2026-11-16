import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sceneSchema, type Scene } from './engine.ts';

export type DocumentSnapshot = {
  documentId: string;
  scene: Scene;
  revision: number;
  updatedAt: string;
};

export type DocumentSummary = {
  id: string;
  name: string;
  width: number;
  height: number;
  revision: number;
  updatedAt: string;
};

export type HistoryEntry = {
  revision: number;
  createdAt: string;
  summary: string;
};

export class StoreError extends Error {
  constructor(public status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreError';
  }
}

type DocumentRow = {
  id: string;
  scene: string;
  revision: number;
  updatedAt: string;
};

const schemaVersion = 1;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateDocumentId(documentId: string) {
  if (typeof documentId !== 'string' || !uuid.test(documentId)) {
    throw new StoreError(400, 'Document ID must be a UUID.');
  }
}

function validateRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new StoreError(400, 'Revision must be a positive safe integer.');
  }
}

function readStoredScene(json: string): Scene {
  try {
    return sceneSchema.parse(JSON.parse(json));
  } catch (cause) {
    throw new StoreError(500, 'The stored scene cannot be read.', { cause });
  }
}

export function createStore({ path, initialScene }: { path: string; initialScene: Scene }) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path, { timeout: 5000 });

  function transaction<T>(run: () => T): T {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  let workspaceId: string;
  let defaultDocumentId: string;
  try {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = FULL');
    const identity = transaction(() => {
      const version = database.prepare('PRAGMA user_version').get()?.user_version;
      if (typeof version !== 'number' || version > schemaVersion) {
        throw new StoreError(500, 'This workspace was created by a newer version of Grapher.');
      }
      if (version === 0) {
        database.exec(`
          CREATE TABLE metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          ) STRICT;
          CREATE TABLE documents (
            id TEXT PRIMARY KEY,
            scene TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision > 0),
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE revisions (
            document_id TEXT NOT NULL REFERENCES documents(id),
            revision INTEGER NOT NULL CHECK (revision > 0),
            scene TEXT NOT NULL,
            created_at TEXT NOT NULL,
            summary TEXT NOT NULL,
            PRIMARY KEY (document_id, revision)
          ) STRICT;
          PRAGMA user_version = 1;
        `);
      }

      const readMetadata = database.prepare('SELECT value FROM metadata WHERE key = ?');
      const workspace = readMetadata.get('workspace_id')?.value;
      const defaultDocument = readMetadata.get('default_document_id')?.value;
      if (workspace !== undefined || defaultDocument !== undefined) {
        if (typeof workspace !== 'string' || !uuid.test(workspace)
          || typeof defaultDocument !== 'string' || !uuid.test(defaultDocument)) {
          throw new StoreError(500, 'The workspace identity is invalid.');
        }
        if (!database.prepare('SELECT id FROM documents WHERE id = ?').get(defaultDocument)) {
          throw new StoreError(500, 'The workspace default document is missing.');
        }
        return { workspaceId: workspace, defaultDocumentId: defaultDocument };
      }

      const workspaceId = randomUUID();
      const defaultDocumentId = randomUUID();
      const scene = JSON.stringify(sceneSchema.parse(initialScene));
      const timestamp = new Date().toISOString();
      database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('workspace_id', workspaceId);
      database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('default_document_id', defaultDocumentId);
      database.prepare('INSERT INTO documents (id, scene, revision, updated_at) VALUES (?, ?, 1, ?)')
        .run(defaultDocumentId, scene, timestamp);
      database.prepare('INSERT INTO revisions (document_id, revision, scene, created_at, summary) VALUES (?, 1, ?, ?, ?)')
        .run(defaultDocumentId, scene, timestamp, 'Created workspace');
      return { workspaceId, defaultDocumentId };
    });
    workspaceId = identity.workspaceId;
    defaultDocumentId = identity.defaultDocumentId;
  } catch (error) {
    database.close();
    throw error;
  }

  const selectDocument = database.prepare('SELECT id, scene, revision, updated_at AS updatedAt FROM documents WHERE id = ?');
  const selectDocuments = database.prepare('SELECT id, scene, revision, updated_at AS updatedAt FROM documents ORDER BY updated_at DESC, id');
  const insertDocument = database.prepare('INSERT INTO documents (id, scene, revision, updated_at) VALUES (?, ?, 1, ?)');
  const updateDocument = database.prepare('UPDATE documents SET scene = ?, revision = ?, updated_at = ? WHERE id = ?');
  const insertRevision = database.prepare('INSERT INTO revisions (document_id, revision, scene, created_at, summary) VALUES (?, ?, ?, ?, ?)');
  const selectHistory = database.prepare('SELECT revision, created_at AS createdAt, summary FROM revisions WHERE document_id = ? ORDER BY revision DESC');
  const selectRevision = database.prepare('SELECT scene FROM revisions WHERE document_id = ? AND revision = ?');

  function snapshot(row: DocumentRow): DocumentSnapshot {
    return {
      documentId: row.id,
      scene: readStoredScene(row.scene),
      revision: row.revision,
      updatedAt: row.updatedAt,
    };
  }

  function get(documentId = defaultDocumentId): DocumentSnapshot {
    validateDocumentId(documentId);
    const row = selectDocument.get(documentId) as DocumentRow | undefined;
    if (!row) throw new StoreError(404, 'Document was not found.');
    return snapshot(row);
  }

  function update(
    documentId: string,
    expectedRevision: number | undefined,
    change: (scene: Scene) => Scene,
    summary = 'Updated document',
  ): DocumentSnapshot {
    validateDocumentId(documentId);
    if (expectedRevision !== undefined) validateRevision(expectedRevision);
    return transaction(() => {
      const current = get(documentId);
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw new StoreError(409, 'The document changed. Inspect the latest revision and try again.');
      }
      const previous = JSON.stringify(current.scene);
      const scene = sceneSchema.parse(change(current.scene));
      const json = JSON.stringify(scene);
      if (json === previous) return current;
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new StoreError(409, 'The document has reached its revision limit.');
      }
      const revision = current.revision + 1;
      const updatedAt = new Date().toISOString();
      updateDocument.run(json, revision, updatedAt, documentId);
      insertRevision.run(documentId, revision, json, updatedAt, summary);
      return { documentId, scene, revision, updatedAt };
    });
  }

  return {
    workspaceId,
    defaultDocumentId,
    get,
    list(): DocumentSummary[] {
      return (selectDocuments.all() as DocumentRow[]).map((row) => {
        const { scene, revision, updatedAt } = snapshot(row);
        return { id: row.id, name: scene.name, width: scene.width, height: scene.height, revision, updatedAt };
      });
    },
    create(input: Scene): DocumentSnapshot {
      const scene = sceneSchema.parse(input);
      const documentId = randomUUID();
      const updatedAt = new Date().toISOString();
      const json = JSON.stringify(scene);
      return transaction(() => {
        insertDocument.run(documentId, json, updatedAt);
        insertRevision.run(documentId, 1, json, updatedAt, 'Created document');
        return { documentId, scene, revision: 1, updatedAt };
      });
    },
    update,
    history(documentId: string): HistoryEntry[] {
      get(documentId);
      return selectHistory.all(documentId).map((row) => ({
        revision: Number(row.revision),
        createdAt: String(row.createdAt),
        summary: String(row.summary),
      }));
    },
    restore(documentId: string, targetRevision: number, expectedRevision: number | undefined): DocumentSnapshot {
      validateRevision(targetRevision);
      return update(documentId, expectedRevision, () => {
        const entry = selectRevision.get(documentId, targetRevision);
        if (!entry) throw new StoreError(404, 'Document revision was not found.');
        return readStoredScene(String(entry.scene));
      }, `Restored revision ${targetRevision}`);
    },
    close() {
      if (database.isOpen) database.close();
    },
  };
}

export type DocumentStore = ReturnType<typeof createStore>;
