import Database from "better-sqlite3";

const db = new Database("consultations.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS consultations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    transcript TEXT NOT NULL,
    differentials TEXT NOT NULL,
    suggested_questions TEXT NOT NULL,
    red_flags TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO consultations
    (started_at, ended_at, duration_seconds, transcript, differentials, suggested_questions, red_flags)
  VALUES (@started_at, @ended_at, @duration_seconds, @transcript, @differentials, @suggested_questions, @red_flags)
`);

const listStmt = db.prepare(`
  SELECT id, started_at, ended_at, duration_seconds, transcript, differentials, red_flags
  FROM consultations
  ORDER BY id DESC
`);

const getStmt = db.prepare(`SELECT * FROM consultations WHERE id = ?`);
const deleteStmt = db.prepare(`DELETE FROM consultations WHERE id = ?`);

function parseRow(row) {
  return {
    ...row,
    transcript: JSON.parse(row.transcript),
    differentials: JSON.parse(row.differentials),
    suggested_questions: JSON.parse(row.suggested_questions ?? "[]"),
    red_flags: JSON.parse(row.red_flags),
  };
}

export function insertConsultation({
  started_at,
  ended_at,
  duration_seconds,
  transcript,
  differentials,
  suggested_questions,
  red_flags,
}) {
  const result = insertStmt.run({
    started_at,
    ended_at,
    duration_seconds,
    transcript: JSON.stringify(transcript ?? []),
    differentials: JSON.stringify(differentials ?? []),
    suggested_questions: JSON.stringify(suggested_questions ?? []),
    red_flags: JSON.stringify(red_flags ?? []),
  });
  return result.lastInsertRowid;
}

export function listConsultations() {
  // Summary list: full transcript/differentials/red_flags included so the
  // dashboard can show turn/flag counts, but callers should use getConsultation
  // for the full detail view including suggested_questions.
  return listStmt.all().map((row) => ({
    id: row.id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_seconds: row.duration_seconds,
    turn_count: JSON.parse(row.transcript).length,
    differential_count: JSON.parse(row.differentials).length,
    red_flag_count: JSON.parse(row.red_flags).length,
  }));
}

export function getConsultation(id) {
  const row = getStmt.get(id);
  return row ? parseRow(row) : null;
}

export function deleteConsultation(id) {
  const result = deleteStmt.run(id);
  return result.changes > 0;
}
