"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const dataDirectory = process.env.STUDY_PLANNER_DATA_DIR || path.join(__dirname, "data");
const dataFile = path.join(dataDirectory, "study-planner.json");
const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const pool = connectionString ? new Pool({
  connectionString,
  max: 3,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000,
  allowExitOnIdle: true,
}) : null;
if (pool) pool.on("error", (error) => console.error("Database connection error:", error.code));
let initialization;
let store;
let mutationQueue = Promise.resolve();

function createEmptyStore() {
  return {
    version: 1,
    courses: [],
    schedules: [],
    history: [],
    migrationCompleted: false,
  };
}

async function persistStore(nextStore) {
  await fs.mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(nextStore, null, 2)}\n`, "utf8");
  await fs.rename(temporaryFile, dataFile);
}

async function loadStore() {
  try {
    const savedData = await fs.readFile(dataFile, "utf8");
    const parsedData = JSON.parse(savedData);
    if (
      !parsedData
      || parsedData.version !== 1
      || !Array.isArray(parsedData.courses)
      || !Array.isArray(parsedData.schedules)
      || !Array.isArray(parsedData.history)
    ) {
      throw new TypeError("저장된 데이터 파일 형식이 올바르지 않습니다.");
    }

    return {
      ...parsedData,
      migrationCompleted: Boolean(parsedData.migrationCompleted),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;

    const initialStore = createEmptyStore();
    await persistStore(initialStore);
    return initialStore;
  }
}

function requireStorage() {
  if (process.env.VERCEL && !pool) {
    throw Object.assign(new Error("영구 저장소가 연결되지 않았습니다. Vercel에 PostgreSQL을 연결하고 DATABASE_URL 또는 POSTGRES_URL을 설정한 뒤 다시 배포해 주세요."), { status: 503 });
  }
}

async function initialize() {
  requireStorage();
  if (!initialization) {
    initialization = (async () => {
      if (pool) {
        await pool.query(`CREATE TABLE IF NOT EXISTS study_planner_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          data JSONB NOT NULL
        )`);
        await pool.query("INSERT INTO study_planner_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING", [JSON.stringify(createEmptyStore())]);
      } else {
        store = await loadStore();
      }
    })().catch((error) => { initialization = undefined; throw error; });
  }
  await initialization;
}

async function readStore() {
  await initialize();
  if (pool) {
    const result = await pool.query("SELECT data FROM study_planner_state WHERE id = 1");
    return result.rows[0].data;
  }
  await mutationQueue;
  return structuredClone(store);
}

async function mutateStore(mutator) {
  await initialize();
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A database row lock serializes writes across Vercel instances as well.
      const result = await client.query("SELECT data FROM study_planner_state WHERE id = 1 FOR UPDATE");
      const nextStore = result.rows[0].data;
      mutator(nextStore);
      await client.query("UPDATE study_planner_state SET data = $1 WHERE id = 1", [JSON.stringify(nextStore)]);
      await client.query("COMMIT");
      return nextStore;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const operation = mutationQueue.then(async () => {
    const nextStore = structuredClone(store);
    mutator(nextStore);
    await persistStore(nextStore);
    store = nextStore;
    return structuredClone(nextStore);
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

module.exports = { readStore, mutateStore };
