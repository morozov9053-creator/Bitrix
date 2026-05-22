const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const VIBE_URL = process.env.VIBE_URL || "https://vibecode.bitrix24.tech";
const VIBE_API_KEY = process.env.VIBE_API_KEY;

const DEFAULT_CONFIG = {
  dealLimit: 5000,
  pipelineCategoryId: 0,
  commentMaxAgeDays: 90,
  lprField: "ufCrm_1683105491",
  commentTextField: "ufCrm_CN_TL2CRM",
  commentDateField: "ufCrm_CN_TL2CRM_DT",
  earlyStageIds: ["43", "18"],
  activeTaskStatuses: ["2", "3", "4"],
  excludedManagerIds: [],
  excludedManagerNames: ["Алексиков Дмитрий Игоревич"],
  manualConditions: [
    "Условие 3: сделки находятся на актуальных стадиях — требует экспертной оценки РОПа.",
    "Условие 4: перенос сроков задач более 3 раз — история переносов отсутствует в выгрузке.",
    "Условие 5: вся коммуникация зафиксирована — звонки и переписка не экспортируются.",
    "Условие 6: приложены расчёты и КП — вложения в карточках требуют ручной проверки."
  ]
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, "utf8")) };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendBuffer(res, status, buffer, headers = {}) {
  res.writeHead(status, headers);
  res.end(buffer);
}

function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.trim() !== "" && value.trim() !== "0";
  return value !== false;
}

function parseDate(value, endOfDay = false) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateOnly(date) {
  if (!date) return "";
  const parsed = date instanceof Date ? date : new Date(date);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow" });
}

function dateTimeText(date) {
  if (!date) return "";
  const parsed = date instanceof Date ? date : new Date(date);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}

function durationText(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function normalizeId(value) {
  if (value === null || value === undefined || value === "" || value === 0 || value === "0") return null;
  return String(value);
}

function fullName(user) {
  if (!user) return "";
  return [user.lastName || user.LAST_NAME, user.name || user.NAME, user.secondName || user.SECOND_NAME]
    .filter(Boolean)
    .join(" ")
    .trim() || `Пользователь #${user.id || user.ID}`;
}

function normalizePersonName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isExcludedManager(row, config) {
  const excludedIds = new Set((config.excludedManagerIds || []).map(String));
  const excludedNames = new Set((config.excludedManagerNames || []).map(normalizePersonName));
  return excludedIds.has(String(row.managerId)) || excludedNames.has(normalizePersonName(row.managerName));
}

function stageEntityId(categoryId) {
  return Number(categoryId) === 0 ? "DEAL_STAGE" : `DEAL_STAGE_${categoryId}`;
}

function phoneCandidates(entity) {
  if (!entity) return [];
  const candidates = [];
  const visit = (value, key = "") => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) return value.forEach((item) => visit(item, key));
    if (typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
      return;
    }
    const name = key.toLowerCase();
    if (name.includes("phone") || name.includes("mobile") || name === "value") {
      candidates.push(String(value));
    }
  };
  visit(entity);
  return candidates;
}

function hasPhone(...entities) {
  return entities
    .flatMap((entity) => phoneCandidates(entity))
    .some((value) => value.replace(/\D/g, "").length >= 6);
}

function linkTokensForDeal(dealId) {
  const id = String(dealId);
  return new Set([id, `D_${id}`, `DEAL_${id}`, `CRM_DEAL_${id}`, `2_${id}`]);
}

function collectPrimitiveValues(value, result = []) {
  if (value === null || value === undefined) return result;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPrimitiveValues(item, result));
    return result;
  }
  if (typeof value === "object") {
    Object.values(value).forEach((item) => collectPrimitiveValues(item, result));
    return result;
  }
  result.push(String(value));
  return result;
}

function taskLinksDeal(task, dealId) {
  const tokens = linkTokensForDeal(dealId);
  const links = collectPrimitiveValues([
    task.ufCrmTask,
    task.UF_CRM_TASK,
    task.crm,
    task.CRM,
    task.deal,
    task.DEAL
  ]);
  if (links.some((link) => tokens.has(String(link)))) return true;

  const searchable = [
    task.title,
    task.TITLE,
    task.description,
    task.DESCRIPTION
  ].filter(Boolean).join(" ");
  const match = searchable.match(/(^|\D)(\d{2,})\.\s+/);
  return Boolean(match && String(match[2]) === String(dealId));
}

function isActiveFutureTask(task, analysisDate, activeStatuses) {
  if (!activeStatuses.has(String(task.status || task.STATUS))) return false;
  const deadline = parseDate(task.deadline || task.DEADLINE);
  return Boolean(deadline && deadline > analysisDate);
}

function buildTaskFilter(analysisDate) {
  return {
    deadline: { $gt: analysisDate.toISOString() }
  };
}

function buildDealFilter(query, config) {
  const filter = { categoryId: Number(config.pipelineCategoryId), closed: "N" };
  const dateFrom = parseDate(query.searchParams.get("dateFrom"));
  const dateTo = parseDate(query.searchParams.get("dateTo"), true);
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = dateFrom.toISOString();
    if (dateTo) filter.createdAt.$lte = dateTo.toISOString();
  }
  const managerIds = parseManagerIds(query);
  if (managerIds.length) filter.assignedById = { $in: managerIds.map(Number) };
  return filter;
}

function parseManagerIds(query) {
  return (query.searchParams.get("managerIds") || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function vibe(pathname, options = {}) {
  if (!VIBE_API_KEY) {
    const error = new Error("VIBE_API_KEY is not set");
    error.statusCode = 500;
    throw error;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.VIBE_TIMEOUT_MS || 120000));
  const res = await fetch(`${VIBE_URL}${pathname}`, {
    ...options,
    signal: controller.signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": VIBE_API_KEY,
      ...(options.headers || {})
    }
  }).finally(() => clearTimeout(timeout));
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok || data?.success === false) {
    const error = new Error(data?.error?.message || `VibeCode request failed: ${res.status}`);
    error.statusCode = res.status;
    error.details = data?.error || data;
    throw error;
  }
  return data?.data ?? data;
}

async function searchEntity(entity, body) {
  return vibe(`/v1/${entity}/search`, { method: "POST", body: JSON.stringify(body) });
}

async function fetchByIds(entity, ids, select = null) {
  const uniqueIds = [...new Set(ids.map(normalizeId).filter(Boolean))];
  if (!uniqueIds.length) return new Map();
  const body = {
    filter: { id: { $in: uniqueIds } },
    limit: Math.min(uniqueIds.length, 5000)
  };
  if (select) body.select = select;
  const data = await searchEntity(entity, body).catch(() => []);
  return new Map((Array.isArray(data) ? data : []).map((item) => [String(item.id), item]));
}

function dealSelect(config) {
  return [
    "id",
    "title",
    "createdAt",
    "assignedById",
    "companyId",
    "contactId",
    "contactIds",
    "categoryId",
    "stageId",
    "stageSemanticId",
    "closed",
    config.lprField,
    config.commentTextField,
    config.commentDateField
  ];
}

function taskSelect() {
  return [
    "id",
    "title",
    "description",
    "status",
    "deadline",
    "ufCrmTask"
  ];
}

function contactSelect() {
  return ["id", "phone", "hasPhone"];
}

function companySelect() {
  return ["id", "title", "phone", "hasPhone"];
}

function userSelect() {
  return ["id", "name", "lastName", "secondName"];
}

async function fetchStageMap(config) {
  const statuses = await vibe("/v1/statuses?limit=500");
  const entityId = stageEntityId(config.pipelineCategoryId);
  return new Map(
    statuses
      .filter((status) => status.entityId === entityId && String(status.CATEGORY_ID ?? "0") === String(config.pipelineCategoryId))
      .map((status) => [String(status.statusId), status])
  );
}

function callTimestamp(call) {
  return parseDate(call.startTime || call.START_TIME || call.createdAt || call.CREATED || call.deadline || call.DEADLINE);
}

function callDurationSeconds(call) {
  const start = parseDate(call.startTime || call.START_TIME);
  const end = parseDate(call.endTime || call.END_TIME);
  if (start && end && end >= start) return Math.round((end - start) / 1000);
  const numeric = [
    call.duration,
    call.DURATION,
    call.durationSeconds,
    call.DURATION_SECONDS,
    call.SETTINGS?.DURATION,
    call.SETTINGS?.duration,
    call.PROVIDER_PARAMS?.DURATION,
    call.PROVIDER_PARAMS?.duration
  ].find((value) => Number(value) > 0);
  return Number(numeric || 0);
}

async function fetchCallStats(deals) {
  const dealIds = [...new Set(deals.map((deal) => Number(deal.id)).filter(Boolean))];
  const stats = new Map(dealIds.map((id) => [String(id), {
    callCount: 0,
    lastCallAt: "",
    lastCallAtText: "",
    lastCallDurationSeconds: 0,
    lastCallDurationText: "",
    lastCallSubject: ""
  }]));
  if (!dealIds.length) return stats;

  const calls = await searchEntity("activities", {
    filter: { ownerTypeId: 2, ownerId: { $in: dealIds }, typeId: 2 },
    order: { startTime: "desc" },
    select: [
      "id",
      "ownerId",
      "typeId",
      "subject",
      "startTime",
      "endTime",
      "deadline",
      "createdAt",
      "direction",
      "SETTINGS",
      "PROVIDER_PARAMS"
    ],
    limit: 5000
  }).catch(() => []);

  for (const call of Array.isArray(calls) ? calls : []) {
    const dealId = normalizeId(call.ownerId || call.OWNER_ID);
    if (!dealId || !stats.has(dealId)) continue;
    const item = stats.get(dealId);
    const timestamp = callTimestamp(call);
    item.callCount += 1;
    const currentLast = parseDate(item.lastCallAt);
    if (timestamp && (!currentLast || timestamp > currentLast)) {
      const seconds = callDurationSeconds(call);
      item.lastCallAt = timestamp.toISOString();
      item.lastCallAtText = dateTimeText(timestamp);
      item.lastCallDurationSeconds = seconds;
      item.lastCallDurationText = durationText(seconds);
      item.lastCallSubject = call.subject || call.SUBJECT || "";
    }
  }

  return stats;
}

function evaluateDeal(deal, context) {
  const {
    tasks,
    contactsById,
    companiesById,
    usersById,
    stagesById,
    callStatsByDealId,
    config,
    analysisDate,
    activeTaskStatuses
  } = context;
  const stage = stagesById.get(String(deal.stageId));
  const stageName = stage?.name || String(deal.stageId || "");
  const contactIds = [...new Set([deal.contactId, ...(deal.contactIds || [])].map(normalizeId).filter(Boolean))];
  const contacts = contactIds.map((id) => contactsById.get(id)).filter(Boolean);
  const company = companiesById.get(String(deal.companyId));
  const linkedTasks = tasks.filter((task) => taskLinksDeal(task, deal.id));
  const activeFutureTasks = linkedTasks.filter((task) => isActiveFutureTask(task, analysisDate, activeTaskStatuses));
  const isEarlyStage = config.earlyStageIds.includes(String(deal.stageId));
  const hasLpr = isFilled(deal[config.lprField]);
  const hasContact = contactIds.length > 0;
  const phoneOk = hasPhone(...contacts, company);
  const commentText = deal[config.commentTextField];
  const commentDate = parseDate(deal[config.commentDateField]);
  const commentMaxAgeDays = Number(context.commentMaxAgeDays || config.commentMaxAgeDays);
  const commentMaxAgeMs = commentMaxAgeDays * 24 * 60 * 60 * 1000;
  const noTask = activeFutureTasks.length === 0;
  const noContact = isEarlyStage && !hasContact;
  const noLpr = !isEarlyStage && !hasLpr;
  const noPhone = !phoneOk;
  const noComment = !isFilled(commentText) && !commentDate;
  const staleComment = !noComment && (!commentDate || analysisDate - commentDate > commentMaxAgeMs);
  const noParty = isEarlyStage ? noContact : noLpr;
  const checkResults = [!noTask, !noParty, !noPhone, !(noComment || staleComment)];
  const checkedParameters = checkResults.length;
  const passedParameters = checkResults.filter(Boolean).length;
  const callStats = callStatsByDealId.get(String(deal.id)) || {};
  const reasons = [];

  if (noTask) reasons.push("Нет активной задачи с будущим сроком");
  if (noLpr) reasons.push("Нет ЛПР/ЛВПР");
  if (noContact) reasons.push("Нет контакта");
  if (noPhone) reasons.push("Нет телефона");
  if (noComment) reasons.push("Комментарий отсутствует");
  if (staleComment) reasons.push(`Последний комментарий: ${dateOnly(commentDate)}`);

  const managerId = normalizeId(deal.assignedById) || "unknown";
  return {
    id: deal.id,
    title: deal.title || "",
    managerId,
    managerName: fullName(usersById.get(managerId)) || `Менеджер #${managerId}`,
    stageId: deal.stageId,
    stageName,
    createdAt: deal.createdAt,
    company: company?.title || company?.TITLE || "",
    callCount: callStats.callCount || 0,
    lastCallAt: callStats.lastCallAt || "",
    lastCallAtText: callStats.lastCallAtText || "",
    lastCallDurationSeconds: callStats.lastCallDurationSeconds || 0,
    lastCallDurationText: callStats.lastCallDurationText || "",
    lastCallSubject: callStats.lastCallSubject || "",
    noTask,
    noLpr,
    noContact,
    noPhone,
    noCondition2: noLpr || noContact || noPhone,
    noComment,
    staleComment,
    noCondition7: noComment || staleComment,
    checkedParameters,
    passedParameters,
    failedParameters: checkedParameters - passedParameters,
    violationCount: reasons.length,
    hasViolation: reasons.length > 0,
    condition7Text: noComment ? "Комментарий отсутствует" : staleComment ? `Последний: ${dateOnly(commentDate)}` : "",
    reasons
  };
}

function emptySummary(managerId, managerName) {
  return {
    managerId,
    managerName,
    totalDeals: 0,
    noTask: 0,
    noLpr: 0,
    noContact: 0,
    noPhone: 0,
    condition2Total: 0,
    noComment: 0,
    staleComment: 0,
    condition7Total: 0,
    totalViolations: 0,
    checkedParameters: 0,
    passedParameters: 0,
    failedParameters: 0,
    compliancePercent: 0,
    kpiPaid: true
  };
}

function applyKpi(summary, threshold) {
  summary.compliancePercent = summary.checkedParameters > 0
    ? Number(((summary.passedParameters / summary.checkedParameters) * 100).toFixed(1))
    : 0;
  summary.kpiThreshold = threshold;
  summary.kpiPaid = summary.checkedParameters > 0 && summary.compliancePercent >= threshold;
  return summary;
}

function aggregateManagers(rows, threshold) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.managerId)) map.set(row.managerId, emptySummary(row.managerId, row.managerName));
    const item = map.get(row.managerId);
    item.totalDeals += 1;
    item.noTask += row.noTask ? 1 : 0;
    item.noLpr += row.noLpr ? 1 : 0;
    item.noContact += row.noContact ? 1 : 0;
    item.noPhone += row.noPhone ? 1 : 0;
    item.condition2Total += row.noCondition2 ? 1 : 0;
    item.noComment += row.noComment ? 1 : 0;
    item.staleComment += row.staleComment ? 1 : 0;
    item.condition7Total += row.noCondition7 ? 1 : 0;
    item.totalViolations += row.hasViolation ? 1 : 0;
    item.checkedParameters += row.checkedParameters;
    item.passedParameters += row.passedParameters;
    item.failedParameters += row.failedParameters;
  }
  return [...map.values()]
    .map((manager) => applyKpi(manager, threshold))
    .sort((a, b) => a.managerName.localeCompare(b.managerName, "ru"));
}

function buildTotals(managers, threshold) {
  const total = emptySummary("total", "ИТОГО");
  for (const manager of managers) {
    for (const key of Object.keys(total)) {
      if (typeof total[key] === "number") total[key] += manager[key] || 0;
    }
  }
  return applyKpi(total, threshold);
}

function parseThreshold(query) {
  const raw = Number(query.searchParams.get("kpiThreshold") || 90);
  if (!Number.isFinite(raw)) return 90;
  return Math.min(Math.max(raw, 0), 100);
}

async function buildAudit(query) {
  const config = loadConfig();
  const limit = Math.min(Number(query.searchParams.get("limit") || config.dealLimit || 5000), 5000);
  const analysisDate = parseDate(query.searchParams.get("analysisDate"), true) || new Date();
  const commentMaxAgeDays = Number(query.searchParams.get("commentMaxAgeDays") || config.commentMaxAgeDays);
  const kpiThreshold = parseThreshold(query);
  const includeCalls = query.searchParams.get("includeCalls") === "1";
  const dealFilter = buildDealFilter(query, config);
  const activeTaskStatuses = new Set(config.activeTaskStatuses.map(String));

  const [deals, tasks, stagesById] = await Promise.all([
    searchEntity("deals", { filter: dealFilter, sort: "assignedById,-createdAt", select: dealSelect(config), limit }),
    searchEntity("tasks", {
      filter: buildTaskFilter(analysisDate),
      sort: "deadline",
      select: taskSelect(),
      limit: 5000
    }),
    fetchStageMap(config)
  ]);

  const activeDeals = deals.filter((deal) => {
    const stage = stagesById.get(String(deal.stageId));
    const semantics = stage?.semantics || stage?.EXTRA?.SEMANTICS || deal.stageSemanticId;
    return !["S", "F", "success", "failure", "apology"].includes(String(semantics));
  });

  const [contactsById, companiesById, usersById, callStatsByDealId] = await Promise.all([
    fetchByIds("contacts", activeDeals.flatMap((deal) => [deal.contactId, ...(deal.contactIds || [])]), contactSelect()),
    fetchByIds("companies", activeDeals.map((deal) => deal.companyId), companySelect()),
    fetchByIds("users", activeDeals.map((deal) => deal.assignedById), userSelect()),
    includeCalls ? fetchCallStats(activeDeals) : Promise.resolve(new Map())
  ]);

  const rows = activeDeals.map((deal) => evaluateDeal(deal, {
    tasks,
    contactsById,
    companiesById,
    usersById,
    stagesById,
    callStatsByDealId,
    config,
    analysisDate,
    commentMaxAgeDays,
    activeTaskStatuses
  })).filter((row) => !isExcludedManager(row, config));
  const managers = aggregateManagers(rows, kpiThreshold);
  const violations = rows.filter((row) => row.hasViolation)
    .sort((a, b) => a.managerName.localeCompare(b.managerName, "ru") || Number(b.id) - Number(a.id));
  const calls = includeCalls ? sortCallRows(rows) : [];

  return {
    generatedAt: new Date().toISOString(),
    analysisDate: analysisDate.toISOString(),
    commentMaxAgeDays,
    kpiThreshold,
    filters: {
      dateFrom: query.searchParams.get("dateFrom") || "",
      dateTo: query.searchParams.get("dateTo") || "",
      managerIds: parseManagerIds(query),
      kpiThreshold,
      pipelineCategoryId: config.pipelineCategoryId
    },
    manualConditions: config.manualConditions,
    totalDeals: rows.length,
    managers,
    totals: buildTotals(managers, kpiThreshold),
    rows,
    violations,
    calls
  };
}

function sortCallRows(rows) {
  return [...rows].sort((a, b) =>
    a.managerName.localeCompare(b.managerName, "ru") ||
    Number(b.callCount) - Number(a.callCount) ||
    Number(b.id) - Number(a.id)
  );
}

async function buildCallsReport(query) {
  const config = loadConfig();
  const limit = Math.min(Number(query.searchParams.get("limit") || config.dealLimit || 5000), 5000);
  const dealFilter = buildDealFilter(query, config);
  const [deals, stagesById] = await Promise.all([
    searchEntity("deals", { filter: dealFilter, sort: "assignedById,-createdAt", select: dealSelect(config), limit }),
    fetchStageMap(config)
  ]);
  const activeDeals = deals.filter((deal) => {
    const stage = stagesById.get(String(deal.stageId));
    const semantics = stage?.semantics || stage?.EXTRA?.SEMANTICS || deal.stageSemanticId;
    return !["S", "F", "success", "failure", "apology"].includes(String(semantics));
  });
  const [usersById, callStatsByDealId] = await Promise.all([
    fetchByIds("users", activeDeals.map((deal) => deal.assignedById), userSelect()),
    fetchCallStats(activeDeals)
  ]);
  const calls = activeDeals.map((deal) => {
    const managerId = normalizeId(deal.assignedById) || "unknown";
    const stage = stagesById.get(String(deal.stageId));
    const callStats = callStatsByDealId.get(String(deal.id)) || {};
    return {
      id: deal.id,
      title: deal.title || "",
      managerId,
      managerName: fullName(usersById.get(managerId)) || `Менеджер #${managerId}`,
      stageId: deal.stageId,
      stageName: stage?.name || String(deal.stageId || ""),
      callCount: callStats.callCount || 0,
      lastCallAt: callStats.lastCallAt || "",
      lastCallAtText: callStats.lastCallAtText || "",
      lastCallDurationSeconds: callStats.lastCallDurationSeconds || 0,
      lastCallDurationText: callStats.lastCallDurationText || "",
      lastCallSubject: callStats.lastCallSubject || ""
    };
  }).filter((row) => !isExcludedManager(row, config));
  return { generatedAt: new Date().toISOString(), calls: sortCallRows(calls) };
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1F4E78" } };
    cell.font = { color: { argb: "FFFFFF" }, bold: true };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = thinBorder();
  });
}

function thinBorder() {
  return {
    top: { style: "thin", color: { argb: "D9E0E8" } },
    left: { style: "thin", color: { argb: "D9E0E8" } },
    bottom: { style: "thin", color: { argb: "D9E0E8" } },
    right: { style: "thin", color: { argb: "D9E0E8" } }
  };
}

function markViolationCells(row, indexes) {
  for (const index of indexes) {
    const cell = row.getCell(index);
    if (Number(cell.value || 0) > 0) cell.font = { bold: true, color: { argb: "C00000" } };
  }
}

async function buildWorkbook(report) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Дисциплинарный отчёт № 1";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Сводная");
  summary.columns = [
    { header: "Менеджер", key: "managerName", width: 28 },
    { header: "Всего сделок", key: "totalDeals", width: 12 },
    { header: "Усл.1 Нет задачи", key: "noTask", width: 16 },
    { header: "Усл.2 Нет ЛПР", key: "noLpr", width: 15 },
    { header: "Усл.2 Нет контакта", key: "noContact", width: 18 },
    { header: "Усл.2 Нет телефона", key: "noPhone", width: 18 },
    { header: "Усл.2 Итого", key: "condition2Total", width: 14 },
    { header: "Усл.7 Без комментария", key: "noComment", width: 22 },
    { header: "Усл.7 Устарел", key: "staleComment", width: 16 },
    { header: "Усл.7 Итого", key: "condition7Total", width: 14 },
    { header: "Всего нарушений", key: "totalViolations", width: 17 },
    { header: "Выполнено", key: "passedRatio", width: 15 },
    { header: "Корректно, %", key: "compliancePercent", width: 15 },
    { header: "Порог, %", key: "kpiThreshold", width: 12 },
    { header: "KPI", key: "kpi", width: 9 }
  ];
  styleHeader(summary.getRow(1));

  for (const manager of report.managers) {
    const row = summary.addRow({
      ...manager,
      passedRatio: `${manager.passedParameters} / ${manager.checkedParameters}`,
      kpi: manager.kpiPaid ? "✓" : "✗"
    });
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: manager.kpiPaid ? "E2EFDA" : "FCE4D6" } };
    row.eachCell((cell) => { cell.border = thinBorder(); });
    markViolationCells(row, [3, 4, 5, 6, 7, 8, 9, 10, 11]);
    if (manager.compliancePercent < manager.kpiThreshold) row.getCell(13).font = { bold: true, color: { argb: "C00000" } };
    const kpiCell = row.getCell(15);
    kpiCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: manager.kpiPaid ? "70AD47" : "C00000" } };
    kpiCell.font = { bold: true, color: { argb: "FFFFFF" } };
  }

  const totalRow = summary.addRow({
    ...report.totals,
    passedRatio: `${report.totals.passedParameters} / ${report.totals.checkedParameters}`,
    kpi: report.totals.kpiPaid ? "✓" : "✗"
  });
  totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F4B183" } };
  totalRow.font = { bold: true };
  totalRow.eachCell((cell) => { cell.border = thinBorder(); });

  summary.addRow([]);
  const noteTitle = summary.addRow(["Условия 3, 4, 5, 6 требуют ручной проверки"]);
  noteTitle.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "1F4E78" } };
  noteTitle.getCell(1).font = { bold: true, color: { argb: "FFFFFF" } };
  for (const note of report.manualConditions) {
    const row = summary.addRow([note]);
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2CC" } };
  }

  const details = workbook.addWorksheet("Нарушения");
  details.columns = [
    { header: "ID", key: "id", width: 10 },
    { header: "Название сделки", key: "title", width: 45 },
    { header: "Менеджер", key: "managerName", width: 28 },
    { header: "Стадия сделки", key: "stageName", width: 26 },
    { header: "Нет задачи (усл.1)", key: "noTask", width: 18 },
    { header: "Нет ЛПР (усл.2)", key: "noLpr", width: 16 },
    { header: "Нет контакта (усл.2)", key: "noContact", width: 20 },
    { header: "Нет телефона (усл.2)", key: "noPhone", width: 20 },
    { header: "Нарушение усл.7", key: "condition7Text", width: 24 },
    { header: "Причины (сводно)", key: "reasons", width: 55 }
  ];
  styleHeader(details.getRow(1));

  let currentManager = null;
  for (const item of report.violations) {
    if (item.managerName !== currentManager) {
      currentManager = item.managerName;
      const groupRow = details.addRow([currentManager]);
      groupRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "D9EAF7" } };
      groupRow.font = { bold: true };
    }
    const row = details.addRow({
      id: item.id,
      title: item.title,
      managerName: item.managerName,
      stageName: item.stageName,
      noTask: item.noTask ? "✗" : "",
      noLpr: item.noLpr ? "✗" : "",
      noContact: item.noContact ? "✗" : "",
      noPhone: item.noPhone ? "✗" : "",
      condition7Text: item.condition7Text,
      reasons: item.reasons.join("; ")
    });
    row.eachCell((cell) => {
      cell.border = thinBorder();
      cell.alignment = { vertical: "top", wrapText: true };
    });
  }

  const calls = workbook.addWorksheet("Звонки");
  calls.columns = [
    { header: "ID", key: "id", width: 10 },
    { header: "Название сделки", key: "title", width: 45 },
    { header: "Менеджер", key: "managerName", width: 28 },
    { header: "Стадия сделки", key: "stageName", width: 26 },
    { header: "Разговоров", key: "callCount", width: 12 },
    { header: "Дата последнего разговора", key: "lastCallAtText", width: 24 },
    { header: "Длительность", key: "lastCallDurationText", width: 14 },
    { header: "Последний разговор", key: "lastCallSubject", width: 36 }
  ];
  styleHeader(calls.getRow(1));
  for (const item of report.calls) {
    const row = calls.addRow({
      id: item.id,
      title: item.title,
      managerName: item.managerName,
      stageName: item.stageName,
      callCount: item.callCount,
      lastCallAtText: item.lastCallAtText,
      lastCallDurationText: item.lastCallDurationText,
      lastCallSubject: item.lastCallSubject
    });
    row.eachCell((cell) => {
      cell.border = thinBorder();
      cell.alignment = { vertical: "top", wrapText: true };
    });
    if (!item.callCount) row.getCell(5).font = { bold: true, color: { argb: "C00000" } };
  }

  return workbook.xlsx.writeBuffer();
}

async function buildExport(query) {
  const exportQuery = new URL(query.toString());
  exportQuery.searchParams.set("includeCalls", "1");
  const report = await buildAudit(exportQuery);
  return buildWorkbook(report);
}

function serveStatic(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const safePath = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const filePath = path.join(__dirname, "public", path.normalize(safePath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (parsed.pathname === "/health") return sendJson(res, 200, { ok: true });
    if (parsed.pathname === "/api/config") return sendJson(res, 200, loadConfig());
    if (parsed.pathname === "/api/audit") return sendJson(res, 200, await buildAudit(parsed));
    if (parsed.pathname === "/api/calls") return sendJson(res, 200, await buildCallsReport(parsed));
    if (parsed.pathname === "/api/export.xlsx") {
      const buffer = await buildExport(parsed);
      return sendBuffer(res, 200, buffer, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": "attachment; filename=\"disciplinary-report-1.xlsx\""
      });
    }
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      success: false,
      error: {
        message: error.message,
        details: error.details
      }
    });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Disciplinary report #1 listening on ${PORT}`);
  });
}

module.exports = { buildAudit, buildExport, evaluateDeal, loadConfig };
