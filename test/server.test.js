"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('server persists schedules and course settings across restarts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'study-planner-'));
  let child;
  let base;
  async function start() {
    let errors = "";
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, VERCEL: "", DATABASE_URL: "", POSTGRES_URL: "", PORT: '0', STUDY_PLANNER_DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Server exited: ${code}: ${errors}`)));
      child.stdout.on('data', (chunk) => {
        const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { base = match[0]; resolve(); }
      });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
  }
  async function api(route, method = 'GET', body, status = 200) {
    const response = await fetch(`${base}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, status);
    return response.json();
  }
  try {
    await start();
    assert.deepEqual((await api('schedules')).schedules, []);
    const fields = { subject: '수학', content: '미분 공부', deadline: '2026-12-01', color: 'pink' };
    let data = await api('schedules', 'POST', fields, 201);
    const id = data.schedules[0].id;
    await api('schedules', 'POST', { ...fields, content: '적분 공부' }, 201);
    await Promise.all([
      api(`schedules/${id}`, 'PATCH', { content: '미분 복습', deadline: '2026-12-02' }),
      api(`schedules/${id}`, 'PATCH', { completed: true }),
    ]);
    await api(`courses/${encodeURIComponent('수학')}/color`, 'PATCH', { color: 'purple' });
    await api('schedules', 'POST', { ...fields, deadline: '2026-02-30' }, 400);
    await api(`schedules/${id}`, 'PATCH', { completed: 'yes' }, 400);
    await stop();
    await start();
    data = await api('schedules');
    assert.equal(data.schedules.length, 2);
    const schedule = data.schedules.find((item) => item.id === id);
    assert.equal(schedule.content, '미분 복습');
    assert.equal(schedule.deadline, '2026-12-02');
    assert.equal(schedule.completed, true);
    assert.ok(data.schedules.every((item) => item.color === 'purple'));
    await Promise.all([
      api(`schedules/${id}`, 'DELETE'),
      api(`schedules/${id}`, 'DELETE', undefined, 404),
    ]);
    data = await api('schedules');
    assert.equal(data.schedules.length, 1);
    await api(`schedules/${data.schedules[0].id}`, 'DELETE');
    await stop();
    await start();
    data = await api('schedules');
    assert.equal(data.schedules.length, 0);
    assert.equal(data.courses[0].color, 'purple');
    data = await api('schedules', 'POST', fields, 201);
    assert.equal(data.schedules[0].color, 'purple');
    const legacy = [{ id: 'legacy', ...fields, content: '이전 일정', completed: true }];
    const migration = await api('migrate', 'POST', { schedules: legacy });
    assert.equal(migration.importedCount, 1);
    assert.equal(migration.data.schedules.find((item) => item.id === "legacy").completed, true);
    assert.equal((await api('migrate', 'POST', { schedules: legacy })).reason, 'already-completed');
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
