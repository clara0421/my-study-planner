"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, readdir, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

test("Vercel import serves the original UI without disk initialization; missing database fails explicitly", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "planner-vercel-"));
  const child = spawn(process.execPath, ["-e", `
    const app = require('./server');
    const server = app.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, VERCEL: "1", DATABASE_URL: "", POSTGRES_URL: "", STUDY_PLANNER_DATA_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Server exited: ${code}`)));
      child.stdout.once("data", (chunk) => resolve(Number(chunk.toString().trim())));
    });
    const base = `http://127.0.0.1:${port}`;
    for (const route of ["/", "/script.js", "/style.css"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200);
      assert.ok((await response.text()).length > 100);
    }
    for (const route of ["/api/schedules", "/api/health"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /DATABASE_URL/);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const response = await fetch(base + "/api/schedules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "수학", content: "복습", deadline: "2026-12-01" }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    if (child.exitCode === null) await new Promise((resolve) => { child.once("exit", resolve); child.kill(); });
    await rm(directory, { recursive: true, force: true });
  }
});
