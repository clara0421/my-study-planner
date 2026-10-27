"use strict";

const express = require("express");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const app = express();
const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const host = "127.0.0.1";
const dataDirectory = process.env.STUDY_PLANNER_DATA_DIR || path.join(__dirname, "data");
const dataFile = path.join(dataDirectory, "study-planner.json");
const allowedColors = new Set(["blue", "pink", "green", "yellow", "purple"]);
const maxHistoryEntries = 1000;

let store;
let mutationQueue = Promise.resolve();

app.use(express.json({ limit: "1mb" }));

function normalizeSubject(subject) {
  return subject.trim().toLocaleLowerCase();
}

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

function addHistory(targetStore, action, details) {
  targetStore.history.push({
    id: randomUUID(),
    action,
    timestamp: new Date().toISOString(),
    ...details,
  });
  if (targetStore.history.length > maxHistoryEntries) {
    targetStore.history.splice(0, targetStore.history.length - maxHistoryEntries);
  }
}

function findCourse(targetStore, subject) {
  return targetStore.courses.find(
    (course) => normalizeSubject(course.subject) === normalizeSubject(subject)
  );
}

function ensureCourse(targetStore, subject, color = "blue") {
  let course = findCourse(targetStore, subject);
  if (!course) {
    course = {
      id: randomUUID(),
      subject: subject.trim(),
      color: allowedColors.has(color) ? color : "blue",
      createdAt: new Date().toISOString(),
    };
    targetStore.courses.push(course);
  }
  return course;
}

function publicData(targetStore) {
  return {
    schedules: targetStore.schedules.map((schedule) => ({
      ...schedule,
      color: findCourse(targetStore, schedule.subject)?.color || "blue",
    })),
    courses: targetStore.courses,
    migrationCompleted: targetStore.migrationCompleted,
  };
}

function validateScheduleFields(body, { includeCompleted = false } = {}) {
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const deadline = typeof body.deadline === "string" ? body.deadline : "";
  const dateIsValid = /^\d{4}-\d{2}-\d{2}$/.test(deadline)
    && !Number.isNaN(Date.parse(`${deadline}T00:00:00Z`))
    && new Date(`${deadline}T00:00:00Z`).toISOString().slice(0, 10) === deadline;

  if (!subject || subject.length > 60) {
    return { error: "과목명은 1자 이상 60자 이하로 입력해 주세요." };
  }
  if (!content || content.length > 240) {
    return { error: "학습 내용은 1자 이상 240자 이하로 입력해 주세요." };
  }
  if (!dateIsValid) return { error: "올바른 마감일을 입력해 주세요." };

  const fields = { subject, content, deadline };
  if (includeCompleted && typeof body.completed === "boolean") {
    fields.completed = body.completed;
  }
  return { fields };
}

function normalizeLegacySchedules(legacySchedules) {
  if (!Array.isArray(legacySchedules)) {
    throw new TypeError("이전 일정 데이터는 목록 형식이어야 합니다.");
  }

  const seenIds = new Set();
  const seenEntries = new Set();
  const schedules = [];
  const courses = new Map();

  legacySchedules.forEach((legacySchedule) => {
    const validated = validateScheduleFields(legacySchedule);
    if (validated.error) throw new TypeError(validated.error);

    const { subject, content, deadline } = validated.fields;
    const legacyId = typeof legacySchedule.id === "string" && legacySchedule.id.trim()
      ? legacySchedule.id.trim()
      : randomUUID();
    const entryKey = `${normalizeSubject(subject)}\u0000${content}\u0000${deadline}`;
    if (seenIds.has(legacyId) || seenEntries.has(entryKey)) return;
    seenIds.add(legacyId);
    seenEntries.add(entryKey);

    const color = allowedColors.has(legacySchedule.color) ? legacySchedule.color : "blue";
    const courseKey = normalizeSubject(subject);
    if (!courses.has(courseKey)) {
      courses.set(courseKey, { subject, color });
    }

    schedules.push({
      id: legacyId,
      subject,
      content,
      deadline,
      completed: Boolean(legacySchedule.completed),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  return { schedules, courses: [...courses.values()] };
}

function runMutation(mutator) {
  const operation = mutationQueue.then(async () => {
    const nextStore = structuredClone(store);
    const result = mutator(nextStore);
    await persistStore(nextStore);
    store = nextStore;
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

function sendError(response, status, message) {
  response.status(status).json({ error: message });
}

app.get("/api/health", (request, response) => {
  response.type("text/plain; charset=utf-8").send("서버가 정상적으로 작동하고 있습니다.");
});

app.get("/api/schedules", async (request, response) => {
  await mutationQueue;
  response.set("Cache-Control", "no-store").json(publicData(store));
});

app.post("/api/schedules", async (request, response) => {
  const validated = validateScheduleFields(request.body || {});
  if (validated.error) return sendError(response, 400, validated.error);

  await runMutation((nextStore) => {
    const { subject, content, deadline } = validated.fields;
    const requestedColor = request.body.color;
    ensureCourse(
      nextStore,
      subject,
      allowedColors.has(requestedColor) ? requestedColor : "blue"
    );
    const now = new Date().toISOString();
    const schedule = {
      id: randomUUID(),
      subject,
      content,
      deadline,
      completed: false,
      createdAt: now,
      updatedAt: now,
    };
    nextStore.schedules.push(schedule);
    addHistory(nextStore, "schedule-created", { schedule: { ...schedule } });
    return schedule.id;
  });

  await mutationQueue;
  response.status(201).json(publicData(store));
});

app.patch("/api/schedules/:id", async (request, response) => {
  const { id } = request.params;
  const body = request.body || {};
  const allowedFields = ["subject", "content", "deadline", "completed"];
  if (Object.keys(body).some((field) => !allowedFields.includes(field))) {
    return sendError(response, 400, "수정할 수 없는 일정 정보가 포함되어 있습니다.");
  }
  if (Object.hasOwn(body, "completed") && typeof body.completed !== "boolean") {
    return sendError(response, 400, "완료 상태는 true 또는 false여야 합니다.");
  }

  await runMutation((nextStore) => {
    const schedule = nextStore.schedules.find((item) => item.id === id);
    if (!schedule) throw Object.assign(new Error("해당 학습 일정을 찾을 수 없습니다."), { status: 404 });
    const validated = validateScheduleFields({ ...schedule, ...body });
    if (validated.error) throw Object.assign(new Error(validated.error), { status: 400 });
    const before = { ...schedule };
    const { subject, content, deadline } = validated.fields;
    if (normalizeSubject(subject) !== normalizeSubject(schedule.subject)) {
      const currentCourse = findCourse(nextStore, schedule.subject);
      ensureCourse(nextStore, subject, currentCourse?.color || "blue");
    }
    schedule.subject = subject;
    schedule.content = content;
    schedule.deadline = deadline;
    if (Object.hasOwn(body, "completed")) {
      schedule.completed = body.completed;
    }
    schedule.updatedAt = new Date().toISOString();
    addHistory(nextStore, "schedule-updated", {
      scheduleId: id,
      before,
      after: { ...schedule },
    });
  });

  await mutationQueue;
  response.json(publicData(store));
});

app.delete("/api/schedules/:id", async (request, response) => {
  const { id } = request.params;
  await runMutation((nextStore) => {
    const index = nextStore.schedules.findIndex((item) => item.id === id);
    if (index < 0) throw Object.assign(new Error("해당 학습 일정을 찾을 수 없습니다."), { status: 404 });
    const [deletedSchedule] = nextStore.schedules.splice(index, 1);
    addHistory(nextStore, "schedule-deleted", {
      scheduleId: id,
      schedule: { ...deletedSchedule },
    });
  });

  await mutationQueue;
  response.json(publicData(store));
});

app.patch("/api/courses/:subject/color", async (request, response) => {
  const subject = request.params.subject.trim();
  const { color } = request.body || {};
  if (!subject) return sendError(response, 400, "과목명이 필요합니다.");
  if (!allowedColors.has(color)) return sendError(response, 400, "지원하지 않는 과목 색상입니다.");

  await runMutation((nextStore) => {
    const targetCourse = findCourse(nextStore, subject);
    if (!targetCourse) throw Object.assign(new Error("해당 과목을 찾을 수 없습니다."), { status: 404 });
    const previousColor = targetCourse.color;
    targetCourse.color = color;
    targetCourse.updatedAt = new Date().toISOString();
    addHistory(nextStore, "course-color-changed", {
      subject: targetCourse.subject,
      before: previousColor,
      after: color,
    });
  });

  await mutationQueue;
  response.json(publicData(store));
});

app.post("/api/migrate", async (request, response) => {
  const legacySchedules = request.body?.schedules ?? [];
  let migrationResult = { migrated: false, importedCount: 0 };

  await runMutation((nextStore) => {
    if (nextStore.migrationCompleted) {
      migrationResult = { ...migrationResult, reason: "already-completed" };
      return;
    }

    nextStore.migrationCompleted = true;
    let imported;
    try {
      imported = normalizeLegacySchedules(legacySchedules);
    } catch (error) {
      throw Object.assign(error, { status: 400 });
    }
    const existingScheduleCount = nextStore.schedules.length;
    const existingIds = new Set(nextStore.schedules.map((schedule) => schedule.id));
    const existingEntries = new Set(nextStore.schedules.map((schedule) =>
      `${normalizeSubject(schedule.subject)}\u0000${schedule.content}\u0000${schedule.deadline}`
    ));

    imported.schedules.forEach((schedule) => {
      const entryKey = `${normalizeSubject(schedule.subject)}\u0000${schedule.content}\u0000${schedule.deadline}`;
      if (existingIds.has(schedule.id) || existingEntries.has(entryKey)) return;
      existingIds.add(schedule.id);
      existingEntries.add(entryKey);
      nextStore.schedules.push(schedule);
    });

    imported.courses.forEach(({ subject, color }) => {
      ensureCourse(nextStore, subject, color);
    });
    nextStore.schedules.forEach((schedule) => {
      ensureCourse(nextStore, schedule.subject, schedule.color);
    });
    migrationResult.importedCount = nextStore.schedules.length - existingScheduleCount;
    migrationResult.migrated = migrationResult.importedCount > 0;
    if (migrationResult.importedCount > 0) {
      addHistory(nextStore, "legacy-data-imported", {
        importedCount: migrationResult.importedCount,
      });
    }
  });

  await mutationQueue;
  response.json({ ...migrationResult, data: publicData(store) });
});

app.get("/", (request, response, next) => {
  response.sendFile(path.join(__dirname, "index.html"), (error) => {
    if (error) next(error);
  });
});

app.get("/style.css", (request, response, next) => {
  response.sendFile(path.join(__dirname, "style.css"), (error) => {
    if (error) next(error);
  });
});

app.get("/script.js", (request, response, next) => {
  response.sendFile(path.join(__dirname, "script.js"), (error) => {
    if (error) next(error);
  });
});

app.use((error, request, response, next) => {
  console.error("요청 처리 중 오류가 발생했습니다.", error);
  if (response.headersSent) return next(error);
  const status = error.status >= 400 && error.status < 500 ? error.status : 500;
  response.status(status).json({ error: status === 500 ? "서버에서 요청을 처리하지 못했습니다." : error.message });
});

async function startServer() {
  store = await loadStore();
  const server = app.listen(port, host, () => {
    console.log(`Study Planner is running at http://${host}:${server.address().port}`);
    console.log(`Persistent data file: ${dataFile}`);
  });
}

startServer().catch((error) => {
  console.error("Study Planner 서버를 시작하지 못했습니다.", error);
  process.exitCode = 1;
});
