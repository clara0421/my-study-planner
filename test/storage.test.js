"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

test("Postgres storage reads fresh state, commits writes under a row lock, and rolls back failed mutations", async () => {
  let saved;
  let pending;
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push(sql);
      if (sql === "BEGIN") pending = structuredClone(saved);
      if (sql.startsWith("SELECT")) return { rows: [{ data: structuredClone(pending) }] };
      if (sql.startsWith("UPDATE")) pending = JSON.parse(parameters[0]);
      if (sql === "COMMIT") saved = pending;
    },
    release() { calls.push("RELEASE"); },
  };
  class Pool {
    on() {}
    async query(sql, parameters) {
      if (sql.startsWith("INSERT") && !saved) saved = JSON.parse(parameters[0]);
      if (sql.startsWith("SELECT")) return { rows: [{ data: structuredClone(saved) }] };
    }
    async connect() { return client; }
  }
  const context = {
    require: (name) => name === "pg" ? { Pool } : require(name),
    process: { env: { VERCEL: "1", DATABASE_URL: "postgres://test" } },
    module: { exports: {} }, __dirname: path.join(__dirname, ".."), console, structuredClone,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../storage.js"), "utf8"), context);
  const { readStore, mutateStore } = context.module.exports;
  assert.equal((await readStore()).schedules.length, 0);
  await mutateStore((store) => { store.schedules.push({ id: "one", completed: true }); });
  assert.equal((await readStore()).schedules[0].completed, true);
  assert.deepEqual(calls.slice(0, 5), [
    "BEGIN", "SELECT data FROM study_planner_state WHERE id = 1 FOR UPDATE",
    "UPDATE study_planner_state SET data = $1 WHERE id = 1", "COMMIT", "RELEASE",
  ]);
  await assert.rejects(mutateStore((store) => { store.schedules = []; throw new Error("invalid"); }), /invalid/);
  assert.deepEqual(calls.slice(-2), ["ROLLBACK", "RELEASE"]);
  assert.equal((await readStore()).schedules.length, 1);
  saved.schedules.push({ id: "external" });
  assert.equal((await readStore()).schedules.length, 2);
});
