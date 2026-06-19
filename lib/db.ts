import "server-only";

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  extractTitle,
  normalizeTitle,
  stripHtmlExtension,
} from "@/lib/doc-utils";
import type {
  AppUser,
  DocMeta,
  DocRecord,
  TranslationStatus,
} from "@/lib/types";

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "mobile-reader.sqlite");
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface UserRow {
  id: string;
  conductor_user_id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  display_name: string;
  conductor_base_url: string | null;
  encrypted_conductor_token: string;
  created_at: number;
  updated_at: number;
}

interface DocRow {
  id: string;
  user_id: string;
  title: string;
  source: string;
  added_at: number;
  size: number;
  html: string;
  html_zh: string | null;
  translation_status: TranslationStatus;
}

const globalForDb = globalThis as unknown as {
  mobileReaderDb?: Database.Database;
};

function getDbPath(): string {
  return process.env.MOBILE_READER_DB_PATH || DEFAULT_DB_PATH;
}

function migrate(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      conductor_user_id TEXT NOT NULL UNIQUE,
      email TEXT,
      phone TEXT,
      name TEXT,
      display_name TEXT NOT NULL,
      conductor_base_url TEXT,
      encrypted_conductor_token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      size INTEGER NOT NULL,
      html TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_docs_user_added_at ON docs(user_id, added_at DESC);
  `);

  // Incremental migration: translation columns (added after initial release).
  const docCols = new Set(
    (db.prepare("PRAGMA table_info(docs)").all() as { name: string }[]).map(
      (c) => c.name
    )
  );
  if (!docCols.has("html_zh")) {
    db.exec("ALTER TABLE docs ADD COLUMN html_zh TEXT");
  }
  if (!docCols.has("translation_status")) {
    db.exec(
      "ALTER TABLE docs ADD COLUMN translation_status TEXT NOT NULL DEFAULT 'none'"
    );
  }
}

function getDb(): Database.Database {
  if (!globalForDb.mobileReaderDb) {
    const dbPath = getDbPath();
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
    globalForDb.mobileReaderDb = db;
  }
  return globalForDb.mobileReaderDb;
}

function mapUser(row: UserRow): AppUser {
  return {
    id: row.id,
    conductorUserId: row.conductor_user_id,
    email: row.email,
    phone: row.phone,
    name: row.name,
    displayName: row.display_name,
    conductorBaseUrl: row.conductor_base_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDocMeta(row: DocRow): DocMeta {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    addedAt: row.added_at,
    size: row.size,
    translationStatus: row.translation_status ?? "none",
  };
}

function mapDocRecord(row: DocRow): DocRecord {
  return {
    ...mapDocMeta(row),
    html: row.html,
    htmlZh: row.html_zh ?? null,
  };
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function userDisplayName(input: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  conductorUserId: string;
}): string {
  return (
    input.name?.trim() ||
    input.email?.trim() ||
    input.phone?.trim() ||
    `用户 ${input.conductorUserId.slice(0, 8)}`
  );
}

export function upsertUserFromConductor(input: {
  conductorUserId: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  encryptedConductorToken: string;
  conductorBaseUrl?: string | null;
}): AppUser {
  const db = getDb();
  const now = Date.now();
  const displayName = userDisplayName(input);
  const existing = db
    .prepare("SELECT * FROM users WHERE conductor_user_id = ?")
    .get(input.conductorUserId) as UserRow | undefined;

  if (existing) {
    db.prepare(
      `
        UPDATE users
        SET email = ?, phone = ?, name = ?, display_name = ?,
            conductor_base_url = ?, encrypted_conductor_token = ?, updated_at = ?
        WHERE id = ?
      `
    ).run(
      input.email ?? null,
      input.phone ?? null,
      input.name ?? null,
      displayName,
      input.conductorBaseUrl ?? null,
      input.encryptedConductorToken,
      now,
      existing.id
    );
    return mapUser(
      db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id) as UserRow
    );
  }

  const id = randomUUID();
  db.prepare(
    `
      INSERT INTO users (
        id, conductor_user_id, email, phone, name, display_name,
        conductor_base_url, encrypted_conductor_token, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    id,
    input.conductorUserId,
    input.email ?? null,
    input.phone ?? null,
    input.name ?? null,
    displayName,
    input.conductorBaseUrl ?? null,
    input.encryptedConductorToken,
    now,
    now
  );

  return mapUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow);
}

export function createSession(userId: string): {
  token: string;
  expiresAt: number;
} {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  getDb()
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
    )
    .run(tokenHash, userId, now, expiresAt);

  return { token, expiresAt };
}

export function deleteSession(token: string): void {
  getDb()
    .prepare("DELETE FROM sessions WHERE token_hash = ?")
    .run(hashSessionToken(token));
}

export function getUserBySessionToken(token: string): AppUser | null {
  const now = Date.now();
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);

  const row = db
    .prepare(
      `
        SELECT users.*
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
          AND sessions.expires_at > ?
      `
    )
    .get(hashSessionToken(token), now) as UserRow | undefined;

  return row ? mapUser(row) : null;
}

export function listDocsForUser(userId: string): DocMeta[] {
  const rows = getDb()
    .prepare("SELECT * FROM docs WHERE user_id = ? ORDER BY added_at DESC")
    .all(userId) as DocRow[];
  return rows.map(mapDocMeta);
}

export function getDocForUser(userId: string, id: string): DocRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM docs WHERE user_id = ? AND id = ?")
    .get(userId, id) as DocRow | undefined;
  return row ? mapDocRecord(row) : null;
}

export function addDocForUser(
  userId: string,
  html: string,
  source: string,
  options: { translate?: boolean } = {}
): DocMeta {
  const id = randomUUID();
  const addedAt = Date.now();
  const cleanSource = source.trim().slice(0, 500) || "未命名文档";
  const title = normalizeTitle(
    extractTitle(html, stripHtmlExtension(cleanSource)) || "未命名文档"
  );
  const size = Buffer.byteLength(html, "utf8");
  const translationStatus: TranslationStatus = options.translate
    ? "translating"
    : "none";

  getDb()
    .prepare(
      `
        INSERT INTO docs (id, user_id, title, source, added_at, size, html, translation_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(id, userId, title, cleanSource, addedAt, size, html, translationStatus);

  return { id, title, source: cleanSource, addedAt, size, translationStatus };
}

/** Store a completed translation and flip the doc's status to "translated". */
export function setDocTranslation(
  userId: string,
  id: string,
  htmlZh: string
): boolean {
  const result = getDb()
    .prepare(
      "UPDATE docs SET html_zh = ?, translation_status = 'translated' WHERE user_id = ? AND id = ?"
    )
    .run(htmlZh, userId, id);
  return result.changes > 0;
}

/** Update only the translation status (e.g. to "failed"). */
export function setDocTranslationStatus(
  userId: string,
  id: string,
  status: TranslationStatus
): boolean {
  const result = getDb()
    .prepare(
      "UPDATE docs SET translation_status = ? WHERE user_id = ? AND id = ?"
    )
    .run(status, userId, id);
  return result.changes > 0;
}

export function renameDocForUser(
  userId: string,
  id: string,
  title: string
): DocMeta | null {
  const cleanTitle = normalizeTitle(title);
  if (!cleanTitle) return null;

  const result = getDb()
    .prepare("UPDATE docs SET title = ? WHERE user_id = ? AND id = ?")
    .run(cleanTitle, userId, id);

  if (result.changes === 0) return null;
  const doc = getDocForUser(userId, id);
  if (!doc) return null;
  const { html: _html, ...meta } = doc;
  return meta;
}

export function deleteDocForUser(userId: string, id: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM docs WHERE user_id = ? AND id = ?")
    .run(userId, id);
  return result.changes > 0;
}
