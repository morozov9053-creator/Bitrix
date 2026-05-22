const stateEl = document.getElementById("state");
const dashboardEl = document.getElementById("dashboard");
const managerCountEl = document.getElementById("managerCount");
const totalDealsEl = document.getElementById("totalDeals");
const violationDealsEl = document.getElementById("violationDeals");
const paidManagersEl = document.getElementById("paidManagers");
const summaryBodyEl = document.getElementById("summaryBody");
const violationsBodyEl = document.getElementById("violationsBody");
const callsBodyEl = document.getElementById("callsBody");
const manualNotesEl = document.getElementById("manualNotes");
const searchInputEl = document.getElementById("searchInput");
const callsSearchInputEl = document.getElementById("callsSearchInput");
const refreshBtnEl = document.getElementById("refreshBtn");
const exportBtnEl = document.getElementById("exportBtn");
const analysisDateInputEl = document.getElementById("analysisDateInput");
const dateFromInputEl = document.getElementById("dateFromInput");
const dateToInputEl = document.getElementById("dateToInput");
const commentAgeInputEl = document.getElementById("commentAgeInput");
const kpiThresholdInputEl = document.getElementById("kpiThresholdInput");
const managerSelectEl = document.getElementById("managerSelect");
const summaryTabEl = document.getElementById("summaryTab");
const violationsTabEl = document.getElementById("violationsTab");
const callsTabEl = document.getElementById("callsTab");
const summaryPaneEl = document.getElementById("summaryPane");
const violationsPaneEl = document.getElementById("violationsPane");
const callsPaneEl = document.getElementById("callsPane");

const columnWidths = new Map();
let report = null;
let selectedManagerIds = [];
let thresholdTimer = null;
let callsSort = { key: "lastCallAt", direction: "desc" };
let managerOptionsInitialized = false;
let callsLoaded = false;
let callsLoading = false;
const managerOptionsById = new Map();

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function selectedManagers() {
  return [...managerSelectEl.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value);
}

function buildParams(includeManagers = true) {
  const params = new URLSearchParams();
  if (analysisDateInputEl.value) params.set("analysisDate", analysisDateInputEl.value);
  if (dateFromInputEl.value) params.set("dateFrom", dateFromInputEl.value);
  if (dateToInputEl.value) params.set("dateTo", dateToInputEl.value);
  if (commentAgeInputEl.value) params.set("commentMaxAgeDays", commentAgeInputEl.value);
  if (kpiThresholdInputEl.value) params.set("kpiThreshold", kpiThresholdInputEl.value);
  if (includeManagers) {
    const managers = selectedManagers();
    if (managers.length) params.set("managerIds", managers.join(","));
  }
  return params;
}

function kpiLabel(paid) {
  return paid ? "✓" : "✗";
}

function metricCell(value) {
  const number = Number(value || 0);
  return `<td class="${number > 0 ? "bad-number" : ""}">${number}</td>`;
}

function dealUrl(id) {
  return `https://morozoff24.bitrix24.ru/crm/deal/details/${encodeURIComponent(id)}/`;
}

function dealLink(row) {
  return `<a class="deal-link" href="${dealUrl(row.id)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)}</a>`;
}

function renderManagerOptions(managers) {
  for (const manager of managers) {
    managerOptionsById.set(String(manager.managerId), manager.managerName);
  }
  const current = selectedManagerIds.length ? selectedManagerIds : selectedManagers();
  const existing = new Set(
    !managerOptionsInitialized && current.length === 0
      ? [...managerOptionsById.keys()]
      : current
  );
  const options = [...managerOptionsById.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "ru"));
  managerSelectEl.innerHTML = options.map(([managerId, managerName]) => `
    <label class="manager-option">
      <input type="checkbox" value="${escapeHtml(managerId)}" ${existing.has(String(managerId)) ? "checked" : ""} />
      <span>${escapeHtml(managerName)}</span>
    </label>
  `).join("");
  managerOptionsInitialized = true;
}

function renderSummary() {
  const rows = [...report.managers, report.totals];
  summaryBodyEl.innerHTML = rows.map((manager) => {
    const isTotal = manager.managerId === "total";
    const paid = Boolean(manager.kpiPaid);
    return `
      <tr class="${isTotal ? "total-row" : paid ? "paid-row" : "failed-row"}">
        <td class="manager-name" title="${escapeHtml(manager.managerName)}"><strong>${escapeHtml(manager.managerName)}</strong></td>
        <td>${manager.totalDeals}</td>
        ${metricCell(manager.noTask)}
        ${metricCell(manager.noLpr)}
        ${metricCell(manager.noContact)}
        ${metricCell(manager.noPhone)}
        ${metricCell(manager.condition2Total)}
        ${metricCell(manager.noComment)}
        ${metricCell(manager.staleComment)}
        ${metricCell(manager.condition7Total)}
        ${metricCell(manager.totalViolations)}
        <td>${manager.passedParameters} / ${manager.checkedParameters}</td>
        <td class="${manager.compliancePercent < manager.kpiThreshold ? "bad-number" : ""}">${manager.compliancePercent}%</td>
        <td>${manager.kpiThreshold}%</td>
        <td><span class="kpi ${paid ? "paid" : "failed"}">${kpiLabel(paid)}</span></td>
      </tr>
    `;
  }).join("");

  manualNotesEl.innerHTML = `
    <h3>Ручная проверка</h3>
    <p>KPI выплачивается, если доля корректно заполненных автоматизированных параметров не ниже ${escapeHtml(report.kpiThreshold)}%.</p>
    ${report.manualConditions.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
  `;
}

function renderViolations() {
  const query = searchInputEl.value.trim().toLowerCase();
  const rows = report.violations.filter((row) => {
    const haystack = [row.id, row.title, row.managerName, row.stageName, row.reasons.join(" ")]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });

  let currentManager = "";
  const html = [];
  for (const row of rows) {
    if (row.managerName !== currentManager) {
      currentManager = row.managerName;
      html.push(`<tr class="group-row"><td colspan="10">${escapeHtml(currentManager)}</td></tr>`);
    }
    html.push(`
      <tr>
        <td>${escapeHtml(row.id)}</td>
        <td>${dealLink(row)}</td>
        <td>${escapeHtml(row.managerName)}</td>
        <td>${escapeHtml(row.stageName)}</td>
        <td class="mark">${row.noTask ? "✗" : ""}</td>
        <td class="mark">${row.noLpr ? "✗" : ""}</td>
        <td class="mark">${row.noContact ? "✗" : ""}</td>
        <td class="mark">${row.noPhone ? "✗" : ""}</td>
        <td>${escapeHtml(row.condition7Text)}</td>
        <td>${escapeHtml(row.reasons.join("; "))}</td>
      </tr>
    `);
  }
  violationsBodyEl.innerHTML = html.join("") || '<tr><td colspan="10" class="empty">Нарушений не найдено</td></tr>';
}

function renderCalls() {
  if (!callsLoaded) {
    callsBodyEl.innerHTML = '<tr><td colspan="8" class="empty">Откройте вкладку, чтобы загрузить звонки</td></tr>';
    updateCallsSortButtons();
    return;
  }
  const query = callsSearchInputEl.value.trim().toLowerCase();
  const rows = (report.calls || []).filter((row) => {
    const haystack = [
      row.id,
      row.title,
      row.managerName,
      row.stageName,
      row.callCount,
      row.lastCallAtText,
      row.lastCallDurationText,
      row.lastCallSubject
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  }).sort(compareCallRows);

  callsBodyEl.innerHTML = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.id)}</td>
      <td>${dealLink(row)}</td>
      <td>${escapeHtml(row.managerName)}</td>
      <td>${escapeHtml(row.stageName)}</td>
      <td class="${row.callCount > 0 ? "" : "bad-number"}">${row.callCount}</td>
      <td>${escapeHtml(row.lastCallAtText || "—")}</td>
      <td>${escapeHtml(row.lastCallDurationText || "—")}</td>
      <td>${escapeHtml(row.lastCallSubject || "—")}</td>
    </tr>
  `).join("") || '<tr><td colspan="8" class="empty">Сделок не найдено</td></tr>';
  updateCallsSortButtons();
}

function callSortValue(row, key) {
  if (["id", "callCount", "lastCallDurationSeconds"].includes(key)) return Number(row[key] || 0);
  if (key === "lastCallAt") return row.lastCallAt ? new Date(row.lastCallAt).getTime() : 0;
  return String(row[key] || "").toLowerCase();
}

function compareCallRows(a, b) {
  const left = callSortValue(a, callsSort.key);
  const right = callSortValue(b, callsSort.key);
  let result = 0;
  if (typeof left === "number" && typeof right === "number") {
    result = left - right;
  } else {
    result = String(left).localeCompare(String(right), "ru");
  }
  return callsSort.direction === "asc" ? result : -result;
}

function updateCallsSortButtons() {
  document.querySelectorAll("[data-calls-sort]").forEach((button) => {
    const active = button.dataset.callsSort === callsSort.key;
    button.classList.toggle("active", active);
    button.classList.toggle("asc", active && callsSort.direction === "asc");
    button.classList.toggle("desc", active && callsSort.direction === "desc");
  });
}

function setCallsSort(key) {
  if (callsSort.key === key) {
    callsSort = { key, direction: callsSort.direction === "asc" ? "desc" : "asc" };
  } else {
    const numericOrDate = ["id", "callCount", "lastCallAt", "lastCallDurationSeconds"].includes(key);
    callsSort = { key, direction: numericOrDate ? "desc" : "asc" };
  }
  renderCalls();
}

function renderReport(data) {
  report = data;
  managerCountEl.textContent = data.managers.length;
  totalDealsEl.textContent = data.totalDeals;
  violationDealsEl.textContent = data.totals.totalViolations;
  paidManagersEl.textContent = data.managers.filter((manager) => manager.kpiPaid).length;
  renderManagerOptions(data.managers);
  renderSummary();
  renderViolations();
  renderCalls();
  setupResizableTables();
}

function tableKey(table) {
  return table.closest(".panel")?.id || table.className || "table";
}

function applyColumnWidth(table, columnIndex, width) {
  const safeWidth = Math.max(56, Math.round(width));
  table.querySelectorAll("tr").forEach((row) => {
    const cell = row.children[columnIndex];
    if (!cell) return;
    cell.style.width = `${safeWidth}px`;
    cell.style.minWidth = `${safeWidth}px`;
  });
}

function setupResizableTables() {
  document.querySelectorAll(".report-table").forEach((table) => {
    const key = tableKey(table);
    const saved = columnWidths.get(key) || {};
    table.querySelectorAll("th").forEach((th, index) => {
      th.querySelector(".column-resizer")?.remove();
      if (saved[index]) applyColumnWidth(table, index, saved[index]);

      const handle = document.createElement("span");
      handle.className = "column-resizer";
      handle.setAttribute("aria-hidden", "true");
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const startWidth = th.getBoundingClientRect().width;
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add("resizing-columns");

        const onMove = (moveEvent) => {
          const nextWidth = startWidth + moveEvent.clientX - startX;
          const tableWidths = columnWidths.get(key) || {};
          tableWidths[index] = Math.max(56, Math.round(nextWidth));
          columnWidths.set(key, tableWidths);
          applyColumnWidth(table, index, tableWidths[index]);
        };
        const onUp = () => {
          document.body.classList.remove("resizing-columns");
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          handle.removeEventListener("pointercancel", onUp);
        };

        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
        handle.addEventListener("pointercancel", onUp);
      });
      th.appendChild(handle);
    });
  });
}

async function loadAudit() {
  selectedManagerIds = selectedManagers();
  callsLoaded = false;
  stateEl.classList.remove("hidden");
  dashboardEl.classList.add("hidden");
  stateEl.textContent = "Загрузка данных из Битрикс24...";
  try {
    const data = await fetchJson(`/api/audit?${buildParams(true).toString()}`);
    renderReport(data);
    stateEl.classList.add("hidden");
    dashboardEl.classList.remove("hidden");
  } catch (error) {
    stateEl.textContent = error.message;
  }
}

async function loadCalls() {
  if (callsLoaded || callsLoading || !report) return;
  callsLoading = true;
  callsBodyEl.innerHTML = '<tr><td colspan="8" class="empty">Загрузка звонков из Битрикс24...</td></tr>';
  try {
    const data = await fetchJson(`/api/calls?${buildParams(true).toString()}`);
    report.calls = data.calls || [];
    callsLoaded = true;
    renderCalls();
  } catch (error) {
    callsBodyEl.innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(error.message)}</td></tr>`;
  } finally {
    callsLoading = false;
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("Сервер вернул не JSON. Обновите страницу и попробуйте ещё раз.");
  }
  if (!res.ok || data?.success === false) throw new Error(data?.error?.message || "Не удалось получить отчет");
  return data;
}

function switchTab(name) {
  summaryTabEl.classList.toggle("active", name === "summary");
  violationsTabEl.classList.toggle("active", name === "violations");
  callsTabEl.classList.toggle("active", name === "calls");
  summaryPaneEl.classList.toggle("hidden", name !== "summary");
  violationsPaneEl.classList.toggle("hidden", name !== "violations");
  callsPaneEl.classList.toggle("hidden", name !== "calls");
  if (name === "calls") loadCalls();
}

function exportReport() {
  window.location.href = `/api/export.xlsx?${buildParams(true).toString()}`;
}

function scheduleThresholdReload() {
  window.clearTimeout(thresholdTimer);
  thresholdTimer = window.setTimeout(loadAudit, 500);
}

function handleManagerChange() {
  const checked = selectedManagers();
  if (!checked.length) {
    managerSelectEl.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = true;
    });
  }
  loadAudit();
}

analysisDateInputEl.value = todayIso();
commentAgeInputEl.value = "90";
kpiThresholdInputEl.value = "90";

searchInputEl.addEventListener("input", renderViolations);
callsSearchInputEl.addEventListener("input", renderCalls);
document.querySelectorAll("[data-calls-sort]").forEach((button) => {
  button.addEventListener("click", () => setCallsSort(button.dataset.callsSort));
});
refreshBtnEl.addEventListener("click", loadAudit);
exportBtnEl.addEventListener("click", exportReport);
managerSelectEl.addEventListener("change", handleManagerChange);
kpiThresholdInputEl.addEventListener("input", scheduleThresholdReload);
kpiThresholdInputEl.addEventListener("change", loadAudit);
summaryTabEl.addEventListener("click", () => switchTab("summary"));
violationsTabEl.addEventListener("click", () => switchTab("violations"));
callsTabEl.addEventListener("click", () => switchTab("calls"));

loadAudit();
