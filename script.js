"use strict";

const STORAGE_KEY = "study-planner-schedules";
const scheduleForm = document.querySelector("#schedule-form");
const scheduleList = document.querySelector("#schedule-list");
const progressFill = document.querySelector("#progress-fill");
const progressTrack = document.querySelector("#progress-track");
const progressCount = document.querySelector("#progress-count");
const progressMessage = document.querySelector("#progress-message");
const scheduleTotal = document.querySelector("#schedule-total");
const todayLabel = document.querySelector("#today-label");
const subjectInput = document.querySelector("#subject");
const courseColorFieldset = document.querySelector("#course-color-fieldset");
const courseColorHelp = document.querySelector("#course-color-help");
const storageStatus = document.querySelector("#storage-status");
const serverCheckButton = document.querySelector("#server-check-button");
const serverCheckMessage = document.querySelector("#server-check-message");

const COURSE_COLORS = {
  blue: { color: "#8ecae6", tint: "#eaf7fd", text: "#397b9d", label: "파스텔 블루" },
  pink: { color: "#f2a7c3", tint: "#fff0f5", text: "#b65f80", label: "파스텔 핑크" },
  green: { color: "#9bcfae", tint: "#eff9f1", text: "#4e8a61", label: "파스텔 그린" },
  yellow: { color: "#f0d27d", tint: "#fff9e8", text: "#9b7a24", label: "파스텔 옐로" },
  purple: { color: "#b7a5e8", tint: "#f5f1ff", text: "#725da8", label: "파스텔 퍼플" },
};

// Keep dates in YYYY-MM-DD format so sorting and date comparisons are reliable.
function getTodayString() {
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

let schedules = [];
let courses = [];
let actionPending = false;
let serverReady = false;

function showDataError(message, error) {
  storageStatus.textContent = message;
  storageStatus.hidden = false;
  if (error) console.error(message, error);
}

function clearDataError() {
  storageStatus.hidden = true;
  storageStatus.textContent = "";
}

async function requestApi(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `서버 응답 오류 (${response.status})`);
  }
  return result;
}

function applyServerData(data) {
  schedules = data.schedules;
  courses = data.courses;
  renderSchedules();
  syncCourseColorPicker();
}

async function initializePlanner() {
  const submitButton = scheduleForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  storageStatus.hidden = false;
  storageStatus.textContent = "서버에서 학습 일정을 불러오는 중...";
  let migrationWarning = "";

  try {
    let data = await requestApi("/api/schedules");
    if (!data.migrationCompleted) {
      let legacySchedules = [];
      let legacyStorageReadable = true;
      try {
        const savedSchedules = localStorage.getItem(STORAGE_KEY);
        if (savedSchedules) {
          const parsedSchedules = JSON.parse(savedSchedules);
          if (!Array.isArray(parsedSchedules)) {
            throw new TypeError("이전 일정 데이터가 목록 형식이 아닙니다.");
          }
          legacySchedules = parsedSchedules;
        }
      } catch (error) {
        legacyStorageReadable = false;
        migrationWarning = "이전 브라우저 일정을 읽지 못해 서버로 가져오지 못했습니다.";
        console.error(migrationWarning, error);
      }

      if (legacyStorageReadable && legacySchedules.length > 0) {
        try {
          const migration = await requestApi("/api/migrate", {
            method: "POST",
            body: JSON.stringify({ schedules: legacySchedules }),
          });
          data = migration.data;
          if (data.migrationCompleted) {
            try {
              localStorage.removeItem(STORAGE_KEY);
            } catch (error) {
              migrationWarning = "서버 이전은 완료했지만 브라우저의 이전 데이터 정리에 실패했습니다.";
              console.error(migrationWarning, error);
            }
          }
        } catch (error) {
          migrationWarning = "이전 브라우저 일정을 가져오지 못했습니다. 서버에 저장된 일정을 표시합니다.";
          console.error(migrationWarning, error);
        }
      }
    }

    serverReady = true;
    applyServerData(data);
    if (migrationWarning) showDataError(migrationWarning);
    else clearDataError();
  } catch (error) {
    serverReady = false;
    showDataError(`서버에서 일정을 불러오지 못했습니다: ${error.message}`, error);
    renderSchedules();
  } finally {
    submitButton.disabled = !serverReady;
  }
}

async function runServerAction(action) {
  if (!serverReady) {
    showDataError("서버에 연결된 뒤 다시 시도해 주세요.");
    return false;
  }

  if (actionPending) return false;
  actionPending = true;
  scheduleList.querySelectorAll("button, input, textarea").forEach((control) => { control.disabled = true; });
  try {
    clearDataError();
    const data = await action();
    applyServerData(data);
    return true;
  } catch (error) {
    showDataError(`변경 사항을 저장하지 못했습니다: ${error.message}`, error);
    renderSchedules();
    syncCourseColorPicker();
    return false;
  } finally {
    actionPending = false;
  }
}

function normalizeSubject(subject) {
  return subject.trim().toLocaleLowerCase();
}

function getCourseColor(subject) {
  const normalizedSubject = normalizeSubject(subject);
  const course = courses.find(
    (course) => normalizeSubject(course.subject) === normalizedSubject
  );
  return COURSE_COLORS[course?.color] ? course.color : "blue";
}

function setSelectedCourseColor(color) {
  const option = courseColorFieldset.querySelector(`input[value="${color}"]`);
  if (option) option.checked = true;
}

function syncCourseColorPicker() {
  const subject = subjectInput.value.trim();
  const existingCourse = subject
    ? courses.find((course) => normalizeSubject(course.subject) === normalizeSubject(subject))
    : null;

  if (existingCourse) {
    setSelectedCourseColor(getCourseColor(subject));
    courseColorFieldset.disabled = true;
    courseColorHelp.textContent = "등록된 과목은 기존 색상을 사용합니다. 색상은 일정 카드에서 변경할 수 있어요.";
  } else {
    courseColorFieldset.disabled = false;
    courseColorHelp.textContent = "새 과목에 사용할 색상을 선택하세요.";
  }
}

function applyCourseColor(element, colorName) {
  const color = COURSE_COLORS[colorName] || COURSE_COLORS.blue;
  element.style.setProperty("--course-color", color.color);
  element.style.setProperty("--course-tint", color.tint);
  element.style.setProperty("--course-text", color.text);
}

function formatDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function updateProgress() {
  const completedCount = schedules.filter((schedule) => schedule.completed).length;
  const percentage = schedules.length === 0
    ? 0
    : Math.round((completedCount / schedules.length) * 100);

  progressFill.style.width = `${percentage}%`;
  progressTrack.setAttribute("aria-valuenow", String(percentage));
  progressCount.textContent = `${completedCount} / ${schedules.length} 완료`;
  progressMessage.textContent = schedules.length === 0
    ? "첫 번째 학습 일정을 추가해 보세요!"
    : percentage === 100
      ? "모든 일정을 완료했어요. 정말 잘했어요!"
      : `전체 일정의 ${percentage}%를 완료했어요. 조금만 더 힘내요!`;
}

function createActionButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderSchedules() {
  scheduleList.replaceChildren();
  scheduleTotal.textContent = `${schedules.length}개`;

  if (schedules.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";

    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "📚";

    const title = document.createElement("strong");
    title.textContent = "아직 등록된 일정이 없어요";
    const message = document.createElement("p");
    message.textContent = "왼쪽에서 첫 학습 계획을 추가해 보세요.";

    emptyState.append(icon, title, message);
    scheduleList.append(emptyState);
    updateProgress();
    return;
  }

  const groupedSchedules = new Map();
  schedules.forEach((schedule) => {
    const courseKey = normalizeSubject(schedule.subject);
    if (!groupedSchedules.has(courseKey)) groupedSchedules.set(courseKey, []);
    groupedSchedules.get(courseKey).push(schedule);
  });

  const sortedGroups = [...groupedSchedules.values()]
    .map((courseSchedules) => courseSchedules.sort((first, second) =>
      first.deadline.localeCompare(second.deadline)
    ))
    .sort((first, second) => first[0].deadline.localeCompare(second[0].deadline));

  sortedGroups.forEach((courseSchedules) => {
    scheduleList.append(createCourseCard(courseSchedules));
  });
  updateProgress();
}

function createCourseCard(courseSchedules) {
  const subjectName = courseSchedules[0].subject;
  const colorName = getCourseColor(subjectName);
  const completedCount = courseSchedules.filter((schedule) => schedule.completed).length;
  const card = document.createElement("article");
  card.className = "course-card";
  applyCourseColor(card, colorName);

  const subjectRow = document.createElement("div");
  subjectRow.className = "course-heading";
  const subject = document.createElement("h3");
  subject.className = "item-subject";
  subject.textContent = subjectName;
  applyCourseColor(subject, colorName);
  const colorButton = createActionButton("", "course-color-trigger", () => {
    const palette = card.querySelector(".course-color-palette");
    const isOpen = palette.hidden;
    palette.hidden = !isOpen;
    colorButton.setAttribute("aria-expanded", String(isOpen));
  });
  colorButton.setAttribute("aria-label", `${subjectName} 과목 색상 변경`);
  colorButton.setAttribute("aria-expanded", "false");
  colorButton.title = `${subjectName} 과목 색상 변경`;
  applyCourseColor(colorButton, colorName);

  const courseCount = document.createElement("span");
  courseCount.className = "course-count";
  courseCount.textContent = `${completedCount} / ${courseSchedules.length} 완료`;
  subjectRow.append(subject, colorButton, courseCount);

  const palette = document.createElement("div");
  palette.className = "course-color-palette";
  palette.setAttribute("aria-label", `${subjectName} 과목 색상 선택`);
  palette.hidden = true;
  Object.entries(COURSE_COLORS).forEach(([colorName, color]) => {
    const colorOption = document.createElement("button");
    colorOption.type = "button";
    colorOption.className = "course-color-option";
    colorOption.setAttribute("aria-label", color.label);
    colorOption.setAttribute("aria-pressed", String(getCourseColor(subjectName) === colorName));
    colorOption.title = color.label;
    colorOption.style.setProperty("--course-color", color.color);
    colorOption.addEventListener("click", () => {
      runServerAction(() => changeCourseColor(subjectName, colorName));
    });
    palette.append(colorOption);
  });

  const taskList = document.createElement("div");
  taskList.className = "course-task-list";
  courseSchedules.forEach((schedule) => {
    taskList.append(createScheduleItem(schedule));
  });
  card.append(subjectRow, palette, taskList);
  return card;
}

function createScheduleItem(schedule) {
  const item = document.createElement("div");
  item.className = `schedule-task${schedule.completed ? " is-complete" : ""}`;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "complete-checkbox";
  checkbox.checked = schedule.completed;
  checkbox.setAttribute("aria-label", `${schedule.subject}: ${schedule.content} 완료 표시`);
  checkbox.addEventListener("change", () => {
    runServerAction(() => updateSchedule(schedule.id, { completed: checkbox.checked }));
  });

  const main = document.createElement("div");
  main.className = "item-main";
  const content = document.createElement("p");
  content.className = "item-content";
  content.textContent = schedule.content;
  main.append(content);

  const deadline = document.createElement("p");
  deadline.className = "item-deadline";
  deadline.textContent = `마감 ${formatDate(schedule.deadline)}`;
  if (!schedule.completed && schedule.deadline <= getTodayString()) {
    deadline.classList.add("is-soon");
  }

  const actions = document.createElement("div");
  actions.className = "item-actions";
  actions.append(
    createActionButton("수정", "edit-button", () => showEditFields(schedule, item)),
    createActionButton("삭제", "delete-button", () => {
      runServerAction(() => deleteSchedule(schedule.id));
    })
  );
  main.append(actions);
  item.append(checkbox, main, deadline);
  return item;
}

function showEditFields(schedule, card) {
  const main = card.querySelector(".item-main");
  main.replaceChildren();

  const fields = document.createElement("div");
  fields.className = "edit-fields";
  const subjectInput = document.createElement("input");
  subjectInput.type = "text";
  subjectInput.maxLength = 60;
  subjectInput.value = schedule.subject;
  subjectInput.setAttribute("aria-label", "과목명 수정");
  subjectInput.required = true;

  const contentInput = document.createElement("textarea");
  contentInput.maxLength = 240;
  contentInput.value = schedule.content;
  contentInput.setAttribute("aria-label", "학습 내용 수정");
  contentInput.required = true;

  const deadlineInput = document.createElement("input");
  deadlineInput.type = "date";
  deadlineInput.value = schedule.deadline;
  deadlineInput.setAttribute("aria-label", "마감일 수정");
  deadlineInput.required = true;
  fields.append(subjectInput, contentInput, deadlineInput);

  const actions = document.createElement("div");
  actions.className = "item-actions";
  actions.append(
    createActionButton("저장", "save-button", () => {
      if (!subjectInput.value.trim() || !contentInput.value.trim() || !deadlineInput.value) {
        subjectInput.reportValidity();
        contentInput.reportValidity();
        deadlineInput.reportValidity();
        return;
      }
      runServerAction(() => updateSchedule(schedule.id, {
        subject: subjectInput.value.trim(),
        content: contentInput.value.trim(),
        deadline: deadlineInput.value,
      }));
    }),
    createActionButton("취소", "cancel-button", renderSchedules)
  );
  main.append(fields, actions);
  subjectInput.focus();
}

async function updateSchedule(id, changes) {
  return requestApi(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

async function changeCourseColor(subject, color) {
  if (!COURSE_COLORS[color]) return;

  return requestApi(`/api/courses/${encodeURIComponent(subject)}/color`, {
    method: "PATCH",
    body: JSON.stringify({ color }),
  });
}

async function deleteSchedule(id) {
  return requestApi(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

subjectInput.addEventListener("input", syncCourseColorPicker);

serverCheckButton.addEventListener("click", async () => {
  serverCheckButton.disabled = true;
  serverCheckMessage.hidden = false;
  serverCheckMessage.textContent = "서버에 연결 중...";

  try {
    const response = await fetch("/api/health");
    if (!response.ok) {
      throw new Error(`서버 응답 오류 (${response.status})`);
    }

    serverCheckMessage.textContent = await response.text();
    if (!serverReady) await initializePlanner();
  } catch (error) {
    console.error("서버 확인 요청에 실패했습니다.", error);
    serverCheckMessage.textContent = "서버에 연결할 수 없습니다. 서버가 실행 중인지 확인해 주세요.";
  } finally {
    serverCheckButton.disabled = false;
  }
});

scheduleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!serverReady) return;
  const submitButton = scheduleForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  const formData = new FormData(scheduleForm);
  const newSchedule = {
    subject: formData.get("subject").trim(),
    content: formData.get("content").trim(),
    deadline: formData.get("deadline"),
    color: getCourseColor(formData.get("subject")),
  };

  const existingCourse = courses.find(
    (course) => normalizeSubject(course.subject) === normalizeSubject(newSchedule.subject)
  );
  if (!existingCourse) newSchedule.color = formData.get("subjectColor") || "blue";

  const saved = await runServerAction(() => requestApi("/api/schedules", {
    method: "POST",
    body: JSON.stringify(newSchedule),
  }));
  submitButton.disabled = !serverReady;
  if (saved) {
    scheduleForm.reset();
    syncCourseColorPicker();
    subjectInput.focus();
  }
});

todayLabel.textContent = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
}).format(new Date());
document.querySelector("#deadline").min = getTodayString();
initializePlanner();
