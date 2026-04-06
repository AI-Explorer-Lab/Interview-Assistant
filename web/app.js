const UI_PREF_STORAGE_KEY = "interviewAssistant.ui.v2";

function normalizeIdList(list) {
  return Array.from(
    new Set(
      (Array.isArray(list) ? list : [])
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
    )
  );
}

function defaultUiPreferences() {
  return {
    lastView: "dashboard",
    assetSearch: "",
    historySearch: "",
    forms: {
      resumeAnalysis: { resumeId: "", providerId: "", projectIds: [] },
      mockInterview: { resumeId: "", providerId: "", projectIds: [], analysisRunId: "" },
      review: { interviewId: "", providerId: "" },
      learning: { reviewRunId: "", providerId: "", projectIds: [] },
      openSource: { projectId: "", providerId: "" },
      generalChat: { providerId: "" },
    },
  };
}

function sanitizeUiPreferences(raw = {}) {
  const defaults = defaultUiPreferences();
  const forms = raw.forms || {};
  return {
    lastView: typeof raw.lastView === "string" ? raw.lastView : defaults.lastView,
    assetSearch: typeof raw.assetSearch === "string" ? raw.assetSearch : defaults.assetSearch,
    historySearch: typeof raw.historySearch === "string" ? raw.historySearch : defaults.historySearch,
    forms: {
      resumeAnalysis: {
        ...defaults.forms.resumeAnalysis,
        ...(forms.resumeAnalysis || {}),
        projectIds: normalizeIdList(forms.resumeAnalysis?.projectIds),
      },
      mockInterview: {
        ...defaults.forms.mockInterview,
        ...(forms.mockInterview || {}),
        projectIds: normalizeIdList(forms.mockInterview?.projectIds),
      },
      review: {
        ...defaults.forms.review,
        ...(forms.review || {}),
      },
      learning: {
        ...defaults.forms.learning,
        ...(forms.learning || {}),
        projectIds: normalizeIdList(forms.learning?.projectIds),
      },
      openSource: {
        ...defaults.forms.openSource,
        ...(forms.openSource || {}),
      },
      generalChat: {
        ...defaults.forms.generalChat,
        ...(forms.generalChat || {}),
      },
    },
  };
}

function loadUiPreferences() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(UI_PREF_STORAGE_KEY) || "{}");
    return sanitizeUiPreferences(raw);
  } catch {
    return defaultUiPreferences();
  }
}

const state = {
  bootstrap: null,
  currentInterview: null,
  interviewMessages: [],
  interviewRequestPending: false,
  interviewAutoScroll: true,
  generalChatMessages: [],
  generalChatRunId: "",
  workspaceOverride: window.localStorage.getItem("workspaceOverride") || "",
  selectedHistoryEntryKeys: [],
  resumeCoachMessages: [],
  ui: {
    currentView: "dashboard",
    sidebarOpen: false,
    preferences: loadUiPreferences(),
  },
  speech: {
    recognition: null,
    supported: false,
    listening: false,
    baseText: "",
    finalText: "",
  },
  resultDocs: {
    resumeAnalysis: { path: "", content: "", mode: "preview" },
    review: { path: "", content: "", mode: "preview" },
    learning: { path: "", content: "", mode: "preview" },
    openSource: { path: "", content: "", mode: "preview" },
    history: { path: "", content: "", mode: "preview" },
  },
};

function newProviderId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `provider-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function blankProvider(overrides = {}) {
  return {
    id: newProviderId(),
    provider_label: "",
    provider_type: "demo",
    base_url: "",
    api_key: "",
    model_name: "",
    temperature: "",
    max_tokens: "",
    reasoning_effort: "",
    timeout_seconds: "",
    stream: false,
    anthropic_version: "2023-06-01",
    ...overrides,
  };
}

function persistUiPreferences() {
  try {
    window.localStorage.setItem(UI_PREF_STORAGE_KEY, JSON.stringify(state.ui.preferences));
  } catch {}
}

function updateFormPreference(formKey, patch) {
  state.ui.preferences.forms[formKey] = {
    ...state.ui.preferences.forms[formKey],
    ...patch,
  };
  if ("projectIds" in patch) {
    state.ui.preferences.forms[formKey].projectIds = normalizeIdList(patch.projectIds);
  }
  persistUiPreferences();
}

function providerDisplayName(provider) {
  const label = provider.provider_label || "未命名供应商";
  const rawModelName = (provider.model_name || "").trim();
  const displayModelName = rawModelName.replace(/^gpt-/i, "GPT-");
  const modelSuffix = provider.reasoning_effort ? `-${provider.reasoning_effort}` : "";
  const model = displayModelName ? ` / ${displayModelName}${modelSuffix}` : "";
  const type = provider.provider_type ? ` [${provider.provider_type}]` : "";
  return `${label}${model}${type}`;
}

const viewMeta = {
  dashboard: {
    title: "总览",
    subtitle: "把素材、分析和面试结果串成一条清晰、可靠、可回看的工作流。",
  },
  config: {
    title: "模型配置",
    subtitle: "统一维护模型供应商和 Workspace，让后续所有模块直接复用。",
  },
  assets: {
    title: "素材库",
    subtitle: "先把简历和项目证据整理好，后续各模块都会基于这里的素材工作。",
  },
  "resume-analysis": {
    title: "简历分析",
    subtitle: "围绕候选人简历与项目证据做一轮结构化分析，后续可继续互动迭代。",
  },
  "mock-interview": {
    title: "模拟面试",
    subtitle: "复用简历、项目和分析结果，进入持续追问式的面试训练。",
  },
  "interview-review": {
    title: "面试评价",
    subtitle: "把面试过程转成结构化反馈，方便定位强项、短板和补强方向。",
  },
  learning: {
    title: "学习总结",
    subtitle: "把评价结果沉淀成可复用的知识总结，减少下一次重复踩坑。",
  },
  "open-source": {
    title: "开源项目阅读",
    subtitle: "围绕选定项目生成结构化解读，帮助你快速建立项目讲解素材。",
  },
  "general-chat": {
    title: "普通对话",
    subtitle: "处理非模块化问题、补充提问或临时讨论，保持上下文仍然在同一工作台里。",
  },
  history: {
    title: "历史记录",
    subtitle: "集中查看所有结果文档与面试记录，支持批量管理和快速回看。",
  },
};

function qs(selector) {
  return document.querySelector(selector);
}

function qsa(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function normalizeSearch(value) {
  return (value || "").trim().toLowerCase();
}

function matchesSearch(text, query) {
  return !query || (text || "").toLowerCase().includes(query);
}

function selectHasOption(select, value) {
  return Array.from(select?.options || []).some((option) => option.value === value);
}

function applySelectValue(selector, candidates) {
  const select = qs(selector);
  if (!select) return "";
  for (const candidate of candidates) {
    const normalized = typeof candidate === "string" ? candidate : `${candidate || ""}`;
    if (selectHasOption(select, normalized)) {
      select.value = normalized;
      return normalized;
    }
  }
  if (select.options.length) {
    select.value = select.options[0].value;
    return select.value;
  }
  return "";
}

function sameIdSet(left, right) {
  const leftIds = normalizeIdList(left);
  const rightIds = normalizeIdList(right);
  if (leftIds.length !== rightIds.length) return false;
  const rightSet = new Set(rightIds);
  return leftIds.every((value) => rightSet.has(value));
}

function resolveInitialView() {
  const hashView = window.location.hash.replace(/^#/, "");
  if (viewMeta[hashView]) return hashView;
  const preferredView = state.ui.preferences.lastView;
  if (viewMeta[preferredView]) return preferredView;
  return "dashboard";
}

function toggleSidebar(open) {
  state.ui.sidebarOpen = open;
  document.body.classList.toggle("sidebar-open", open);
  const backdrop = qs("#navBackdrop");
  if (backdrop) {
    backdrop.hidden = !open;
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function inlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inCode = false;
  let codeLines = [];
  let listType = "";
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType) return;
    html.push(listType === "ol" ? "</ol>" : "</ul>");
    listType = "";
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      flushList();
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      if (listType !== "ul") {
        flushList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${inlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      if (listType !== "ol") {
        flushList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  return `<div class="markdown-body">${html.join("")}</div>`;
}

function showToast(message, isError = false) {
  const toast = qs("#toast");
  toast.textContent = message;
  toast.style.background = isError ? "rgba(150, 36, 25, 0.94)" : "rgba(28, 26, 22, 0.92)";
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function setStatus(selector, message, isError = false) {
  const node = qs(selector);
  if (!node) return;
  node.textContent = message;
  node.style.color = isError ? "#962419" : "";
}

function setSubmitLoading(formSelector, loading) {
  const form = qs(formSelector);
  if (!form) return;
  const button = form.querySelector('button[type="submit"]');
  if (button) {
    button.disabled = loading;
  }
}

function setElementDisabled(selector, disabled) {
  const element = qs(selector);
  if (element) {
    element.disabled = disabled;
  }
}

function setOptionalText(selector, value) {
  const element = qs(selector);
  if (element) {
    element.textContent = value;
  }
}

function refreshInterviewActionAvailability() {
  const disabled = state.interviewRequestPending || !state.currentInterview || state.currentInterview.status !== "active";
  setElementDisabled('#interviewReplyForm button[type="submit"]', disabled);
  setElementDisabled("#endInterviewBtn", disabled);
}

function setInterviewBusy(loading) {
  state.interviewRequestPending = loading;
  setSubmitLoading("#mockInterviewForm", loading);
  refreshInterviewActionAvailability();
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const requestUrl = new URL(path, window.location.origin);
  if (state.workspaceOverride.trim()) {
    requestUrl.searchParams.set("workspace_override", state.workspaceOverride.trim());
  }
  const response = await fetch(`${requestUrl.pathname}${requestUrl.search}`, {
    headers,
    ...options,
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `请求失败: ${response.status}`);
  }
  return data.data;
}

async function streamApi(path, options = {}, onEvent) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const requestUrl = new URL(path, window.location.origin);
  if (state.workspaceOverride.trim()) {
    requestUrl.searchParams.set("workspace_override", state.workspaceOverride.trim());
  }
  const response = await fetch(`${requestUrl.pathname}${requestUrl.search}`, {
    headers,
    ...options,
  });
  if (!response.ok) {
    const fallback = await response.text();
    try {
      const parsed = JSON.parse(fallback);
      throw new Error(parsed.error || `请求失败: ${response.status}`);
    } catch {
      throw new Error(fallback || `请求失败: ${response.status}`);
    }
  }
  if (!response.body) {
    throw new Error("浏览器不支持流式响应");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        onEvent(JSON.parse(line));
      }
      newlineIndex = buffer.indexOf("\n");
    }
    if (done) break;
  }
  const tail = buffer.trim();
  if (tail) {
    onEvent(JSON.parse(tail));
  }
}

function persistWorkspaceOverride(value) {
  state.workspaceOverride = value.trim();
  if (state.workspaceOverride) {
    window.localStorage.setItem("workspaceOverride", state.workspaceOverride);
  } else {
    window.localStorage.removeItem("workspaceOverride");
  }
}

function globalWorkspacePath() {
  return (state.bootstrap?.config?.workspace_path || "").trim();
}

async function getDocument(path, options = {}) {
  const params = new URLSearchParams({ path });
  if (options.activate) {
    params.set("activate", "1");
  }
  return api(`/api/document?${params.toString()}`);
}

function setView(viewKey) {
  const meta = viewMeta[viewKey] || viewMeta.dashboard;
  qsa(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewKey);
  });
  qsa(".view").forEach((view) => {
    view.classList.toggle("active", view.dataset.view === viewKey);
  });
  state.ui.currentView = viewKey;
  state.ui.preferences.lastView = viewKey;
  persistUiPreferences();
  qs("#viewTitle").textContent = meta.title;
  qs("#viewSubtitle").textContent = meta.subtitle;
  document.title = `${meta.title} · Interview-Assistant`;
  if (window.location.hash !== `#${viewKey}`) {
    window.history.replaceState(null, "", `#${viewKey}`);
  }
  if (window.innerWidth <= 1080) {
    toggleSidebar(false);
  }
  updateContextSummary();
}

function renderEmpty(target, text) {
  target.innerHTML = `<div class="empty">${text}</div>`;
}

function renderDoc(target, docState, options = {}) {
  if (!docState.content) {
    renderEmpty(target, "暂无内容");
    return;
  }
  if (docState.mode === "edit") {
    const editorId = options.editorId || target.dataset.editorId || "historyEditor";
    target.innerHTML = `<textarea id="${editorId}" class="history-editor"></textarea>`;
    qs(`#${editorId}`).value = docState.content;
    return;
  }
  if (docState.mode === "source") {
    target.innerHTML = `<div class="markdown-body"><pre><code>${escapeHtml(docState.content)}</code></pre></div>`;
    return;
  }
  target.innerHTML = markdownToHtml(docState.content);
}

function renderHistoryDoc() {
  if (state.resultDocs.history.mode === "edit") {
    state.resultDocs.history.mode = "source";
  }
  renderDoc(qs("#historyDocument"), state.resultDocs.history);
}

function renderManagedResultDoc(resultKey, containerSelector, saveBtnSelector, editorId, applyBtnSelector = "") {
  renderDoc(qs(containerSelector), state.resultDocs[resultKey], { editorId });
  const saveBtn = qs(saveBtnSelector);
  if (saveBtn) {
    saveBtn.disabled = state.resultDocs[resultKey].mode !== "edit" || !state.resultDocs[resultKey].path;
  }
  const applyBtn = applyBtnSelector ? qs(applyBtnSelector) : null;
  if (applyBtn) {
    applyBtn.disabled = state.resultDocs[resultKey].mode !== "edit" || !state.resultDocs[resultKey].path;
  }
}

function wireModeButtons(previewSelector, sourceSelector, resultKey, containerSelector) {
  qs(previewSelector).addEventListener("click", () => {
    state.resultDocs[resultKey].mode = "preview";
    if (resultKey === "history") {
      renderHistoryDoc();
      return;
    }
    renderDoc(qs(containerSelector), state.resultDocs[resultKey]);
  });
  qs(sourceSelector).addEventListener("click", () => {
    state.resultDocs[resultKey].mode = "source";
    if (resultKey === "history") {
      renderHistoryDoc();
      return;
    }
    renderDoc(qs(containerSelector), state.resultDocs[resultKey]);
  });
}

async function runButtonWithFeedback(buttonSelector, pendingText, action) {
  const button = qs(buttonSelector);
  const originalText = button?.textContent || "";
  if (button) {
    button.textContent = pendingText;
  }
  try {
    return await action();
  } finally {
    if (button) {
      button.textContent = originalText;
    }
  }
}

function wireEditableResultButtons(previewSelector, sourceSelector, saveSelector, resultKey, containerSelector, editorId, applyBtnSelector = "", statusSelector = "") {
  qs(previewSelector).addEventListener("click", () => {
    state.resultDocs[resultKey].mode = "preview";
    renderManagedResultDoc(resultKey, containerSelector, saveSelector, editorId, applyBtnSelector);
  });
  qs(sourceSelector).addEventListener("click", () => {
    if (!state.resultDocs[resultKey].path) throw new Error("请先生成一份文档");
    state.resultDocs[resultKey].mode = "edit";
    renderManagedResultDoc(resultKey, containerSelector, saveSelector, editorId, applyBtnSelector);
  });
  qs(saveSelector).addEventListener("click", async () => {
    if (!state.resultDocs[resultKey].path) throw new Error("请先生成一份文档");
    if (state.resultDocs[resultKey].mode !== "edit") throw new Error("请先进入源码编辑模式");
    const editor = qs(`#${editorId}`);
    if (!editor) throw new Error("未找到编辑器");
    if (statusSelector) {
      setStatus(statusSelector, "正在保存你的修改...");
    }
    try {
      await runButtonWithFeedback(saveSelector, "保存中...", async () => {
        const result = await api("/api/document", {
          method: "POST",
          body: JSON.stringify({ path: state.resultDocs[resultKey].path, content: editor.value }),
        });
        state.resultDocs[resultKey] = { path: result.path, content: result.content, mode: "edit" };
        renderManagedResultDoc(resultKey, containerSelector, saveSelector, editorId, applyBtnSelector);
        await refreshBootstrap();
      });
      if (statusSelector) {
        setStatus(statusSelector, "修改已保存。");
      }
      showToast("修改已保存");
    } catch (error) {
      if (statusSelector) {
        setStatus(statusSelector, `保存失败：${error.message}`, true);
      }
      showToast(`保存失败：${error.message}`, true);
    }
  });
}

function formatDate(value) {
  return value ? value.replace("T", " ") : "-";
}

function moduleLabel(moduleKey) {
  const map = {
    resume_analysis: "简历分析",
    mock_interview: "模拟面试",
    interview_review: "面试评价",
    learning: "学习总结",
    open_source_reading: "开源项目阅读",
    general_chat: "普通对话",
  };
  return map[moduleKey] || moduleKey;
}

function historyEntries(filter = "") {
  const runEntries = (state.bootstrap?.runs || []).map((run) => ({
    key: `run:${run.id}`,
    record_type: "run",
    record_id: run.id,
    module_key: run.module_key,
    title: run.title,
    path: run.path,
    updated_at: run.updated_at || run.created_at,
  }));
  const interviewEntries = (state.bootstrap?.interviews || []).map((interview) => ({
    key: `interview:${interview.id}`,
    record_type: "interview",
    record_id: interview.id,
    module_key: "mock_interview",
    title: interview.title,
    path: interview.transcript_path,
    updated_at: interview.updated_at,
  }));
  return [...runEntries, ...interviewEntries]
    .filter((entry) => !filter || entry.module_key === filter)
    .sort((left, right) => parseDateSafe(right.updated_at) - parseDateSafe(left.updated_at));
}

function defaultProvider() {
  const providers = state.bootstrap?.config?.providers || [];
  const defaultProviderId = state.bootstrap?.config?.default_provider_id || "";
  return providers.find((provider) => provider.id === defaultProviderId) || providers[0] || null;
}

function workflowStats() {
  const resumes = state.bootstrap?.assets?.resumes || [];
  const projects = state.bootstrap?.assets?.projects || [];
  const runs = state.bootstrap?.runs || [];
  const interviews = state.bootstrap?.interviews || [];
  return {
    resumes,
    projects,
    runs,
    interviews,
    analysisRuns: runs.filter((run) => run.module_key === "resume_analysis"),
    reviewRuns: runs.filter((run) => run.module_key === "interview_review"),
    learningRuns: runs.filter((run) => run.module_key === "learning"),
    activeInterview: interviews.find((interview) => interview.status === "active") || null,
  };
}

function buildDashboardActions(stats) {
  const actions = [];
  if (!stats.resumes.length) {
    actions.push({
      title: "先导入一份候选人简历",
      copy: "简历是后续分析、模拟面试和评价的起点。没有简历，整个链路无法复用上下文。",
      view: "assets",
      cta: "上传简历",
    });
  }
  if (!stats.projects.length) {
    actions.push({
      title: "补齐项目证据库",
      copy: "把项目目录或本地路径导入后，分析与面试都会更贴近真实经历，而不是空泛泛问答。",
      view: "assets",
      cta: "导入项目",
    });
  }
  if (!stats.analysisRuns.length) {
    actions.push({
      title: "生成第一份简历分析",
      copy: "建议先用简历分析把卖点、风险点和可追问项目梳理出来，再进入面试。",
      view: "resume-analysis",
      cta: "开始分析",
    });
  }
  if (!stats.interviews.length) {
    actions.push({
      title: "开始一场模拟面试",
      copy: "当素材和分析已准备好，就可以进入连续追问式训练，验证表达是否站得住。",
      view: "mock-interview",
      cta: "进入面试",
    });
  }
  if (!stats.reviewRuns.length) {
    actions.push({
      title: "产出结构化面试评价",
      copy: "把面试过程转成结构化评价后，才能形成稳定的复盘闭环，而不是凭感觉回忆。",
      view: "interview-review",
      cta: "生成评价",
    });
  }
  if (!stats.learningRuns.length) {
    actions.push({
      title: "沉淀学习总结",
      copy: "把评价结果转成长期知识资产，下一次就不需要重新从零整理问题清单。",
      view: "learning",
      cta: "开始沉淀",
    });
  }
  return actions.slice(0, 3);
}

function nextReadinessHint(stats) {
  if (!stats.resumes.length) return "建议先导入简历素材。";
  if (!stats.projects.length) return "建议补充至少一个项目素材。";
  if (!stats.analysisRuns.length) return "建议先完成一轮简历分析。";
  if (!stats.interviews.length) return "建议开始一场模拟面试。";
  if (!stats.reviewRuns.length) return "建议生成一份面试评价。";
  if (!stats.learningRuns.length) return "建议把评价沉淀为学习总结。";
  return "链路已经跑通，可以继续优化材料或回看历史记录。";
}

function updateContextSummary() {
  const workspace = state.bootstrap?.workspace_path || "-";
  const provider = defaultProvider();
  const stats = workflowStats();
  const readyCount = [
    stats.resumes.length > 0,
    stats.projects.length > 0,
    stats.analysisRuns.length > 0,
    stats.reviewRuns.length > 0 || stats.learningRuns.length > 0 || stats.interviews.length > 0,
  ].filter(Boolean).length;
  const activeDocumentPath = state.bootstrap?.active_document || state.resultDocs.history.path || "";

  setOptionalText("#contextWorkspace", workspace);
  setOptionalText(
    "#contextWorkspaceHint",
    state.workspaceOverride ? "当前页面使用了本地覆盖的 Workspace。" : "当前页面沿用全局默认 Workspace。"
  );
  setOptionalText("#contextProvider", provider ? providerDisplayName(provider) : "暂无供应商");
  setOptionalText(
    "#contextProviderHint",
    provider
      ? provider.provider_type === "demo"
        ? "当前仍可用 Demo 模式直接体验全链路。"
        : "这里显示的是默认供应商，模块里也可以单独切换。"
      : "还没有可用供应商配置。"
  );
  setOptionalText("#contextActiveDoc", activeDocumentPath ? PathBasename(activeDocumentPath) : "暂无");
  setOptionalText(
    "#contextActiveDocHint",
    activeDocumentPath ? activeDocumentPath : "生成或打开结果后，会在这里保留上下文。"
  );
  setOptionalText("#contextReadiness", `${readyCount} / 4`);
  setOptionalText("#contextReadinessHint", nextReadinessHint(stats));
  setOptionalText("#sidebarProgress", `${readyCount} / 4`);
  setOptionalText("#sidebarProgressHint", nextReadinessHint(stats));
  setElementDisabled("#jumpToActiveDocBtn", !activeDocumentPath);
}

function syncPreferencesFromDom() {
  if (!qs("#resumeAnalysisResume")) return;
  updateFormPreference("resumeAnalysis", {
    resumeId: qs("#resumeAnalysisResume").value,
    providerId: qs("#resumeAnalysisProvider").value,
    projectIds: selectedProjectIds("#resumeAnalysisProjects"),
  });
  updateFormPreference("mockInterview", {
    resumeId: qs("#mockInterviewResume").value,
    providerId: qs("#mockInterviewProvider").value,
    projectIds: selectedProjectIds("#mockInterviewProjects"),
    analysisRunId: qs("#mockInterviewAnalysis").value,
  });
  updateFormPreference("review", {
    interviewId: qs("#reviewInterviewSelect").value,
    providerId: qs("#reviewProvider").value,
  });
  updateFormPreference("learning", {
    reviewRunId: qs("#learningReviewSelect").value,
    providerId: qs("#learningProvider").value,
    projectIds: selectedProjectIds("#learningProjects"),
  });
  updateFormPreference("openSource", {
    projectId: qs("#openSourceProject").value,
    providerId: qs("#openSourceProvider").value,
  });
  updateFormPreference("generalChat", {
    providerId: qs("#generalChatProvider").value,
  });
}

function setBootstrap(bootstrap) {
  state.bootstrap = bootstrap;
  const validHistoryKeys = new Set([
    ...bootstrap.runs.map((run) => `run:${run.id}`),
    ...bootstrap.interviews.map((interview) => `interview:${interview.id}`),
  ]);
  state.selectedHistoryEntryKeys = state.selectedHistoryEntryKeys.filter((key) => validHistoryKeys.has(key));
  qs("#workspacePath").textContent = bootstrap.workspace_path || "-";

  qs("#metricResumes").textContent = `${bootstrap.assets.resumes.length}`;
  qs("#metricProjects").textContent = `${bootstrap.assets.projects.length}`;
  qs("#metricRuns").textContent = `${bootstrap.runs.length}`;
  qs("#metricInterviews").textContent = `${bootstrap.interviews.length}`;

  updateContextSummary();
  renderDashboard();
  fillConfigForm();
  fillAssetLists();
  fillSelectors();
  renderHistoryList();
  syncPreferencesFromDom();
}

function renderDashboard() {
  const stats = workflowStats();
  const runsTarget = qs("#recentRuns");
  const interviewsTarget = qs("#recentInterviews");
  const runs = state.bootstrap.runs.slice(0, 5);
  const interviews = state.bootstrap.interviews.slice(0, 5);
  const workflowTarget = qs("#workflowSteps");
  const actionsTarget = qs("#recommendedActions");
  const insightsTarget = qs("#dashboardInsights");

  const workflowItems = [
    {
      label: "准备简历素材",
      detail: stats.resumes.length ? `已上传 ${stats.resumes.length} 份简历` : "还没有候选人简历",
      ready: stats.resumes.length > 0,
      view: "assets",
    },
    {
      label: "沉淀项目证据",
      detail: stats.projects.length ? `已导入 ${stats.projects.length} 个项目` : "还没有项目素材",
      ready: stats.projects.length > 0,
      view: "assets",
    },
    {
      label: "生成结构化分析",
      detail: stats.analysisRuns.length ? `已生成 ${stats.analysisRuns.length} 份分析` : "建议先完成一轮简历分析",
      ready: stats.analysisRuns.length > 0,
      view: "resume-analysis",
    },
    {
      label: "完成面试闭环",
      detail:
        stats.reviewRuns.length || stats.learningRuns.length
          ? `已有 ${stats.reviewRuns.length} 份评价 / ${stats.learningRuns.length} 份总结`
          : stats.interviews.length
            ? `已有 ${stats.interviews.length} 场面试记录，下一步可生成评价`
            : "还没有面试记录和复盘结果",
      ready: stats.reviewRuns.length > 0 || stats.learningRuns.length > 0,
      view: stats.interviews.length ? "interview-review" : "mock-interview",
    },
  ];

  workflowTarget.innerHTML = workflowItems
    .map(
      (item) => `
        <button type="button" class="workflow-step ${item.ready ? "ready" : "pending"}" data-go-view="${item.view}">
          <span class="workflow-state">${item.ready ? "已就绪" : "待完成"}</span>
          <strong>${item.label}</strong>
          <span>${item.detail}</span>
        </button>
      `
    )
    .join("");

  const recommendedActions = buildDashboardActions(stats);
  if (!recommendedActions.length) {
    actionsTarget.innerHTML = `<div class="empty">主流程已经跑通了。现在更适合继续打磨材料、查看历史记录，或者开始下一轮模拟面试。</div>`;
  } else {
    actionsTarget.innerHTML = recommendedActions
      .map(
        (action) => `
          <article class="action-card">
            <strong>${action.title}</strong>
            <p>${action.copy}</p>
            <button type="button" class="ghost-btn" data-go-view="${action.view}">${action.cta}</button>
          </article>
        `
      )
      .join("");
  }

  const provider = defaultProvider();
  const latestActivity = [...state.bootstrap.runs, ...state.bootstrap.interviews]
    .sort((left, right) => parseDateSafe(right.updated_at || right.created_at) - parseDateSafe(left.updated_at || left.created_at))[0];

  insightsTarget.innerHTML = [
    {
      title: "默认模型",
      copy: provider ? providerDisplayName(provider) : "暂无供应商配置",
    },
    {
      title: "最近活动",
      copy: latestActivity
        ? `${latestActivity.title || PathBasename(latestActivity.path || latestActivity.transcript_path || "")} · ${formatDate(
            latestActivity.updated_at || latestActivity.created_at
          )}`
        : "还没有结果文档或面试记录",
    },
    {
      title: "当前文档",
      copy: state.bootstrap.active_document ? PathBasename(state.bootstrap.active_document) : "尚未打开结果文档",
    },
  ]
    .map(
      (item) => `
        <article class="insight-row">
          <strong>${item.title}</strong>
          <span>${item.copy}</span>
        </article>
      `
    )
    .join("");

  if (!runs.length) {
    renderEmpty(runsTarget, "还没有结果文档。建议先完成一轮简历分析或项目解读。");
  } else {
    runsTarget.innerHTML = runs
      .map(
        (run) => `
          <article class="item-card">
            <div class="item-title">
              <strong>${run.title}</strong>
              <span>${moduleLabel(run.module_key)}</span>
            </div>
            <p>${formatDate(run.updated_at || run.created_at)}</p>
            <p class="item-path">${PathBasename(run.path)}</p>
            <div class="item-actions">
              <button class="ghost-btn" data-open-run="${run.path}">\u6253\u5f00</button>
              <button class="ghost-btn danger" data-delete-dashboard-run="${run.id}">\u5220\u9664</button>
            </div>
          </article>
        `
      )
      .join("");
  }

  if (!interviews.length) {
    renderEmpty(interviewsTarget, "还没有模拟面试记录。准备好素材后，可以直接开始第一场。");
  } else {
    interviewsTarget.innerHTML = interviews
      .map(
        (interview) => `
          <article class="item-card">
            <div class="item-title">
              <strong>${interview.title}</strong>
              <span>${interview.status === "active" ? "\u8fdb\u884c\u4e2d" : "\u5df2\u7ed3\u675f"}</span>
            </div>
            <p>${formatDate(interview.updated_at)}</p>
            <p class="item-path">${PathBasename(interview.transcript_path)}</p>
            <div class="item-actions">
              <button class="ghost-btn" data-open-interview="${interview.id}">\u6253\u5f00</button>
              <button class="ghost-btn danger" data-delete-dashboard-interview="${interview.id}">\u5220\u9664</button>
            </div>
          </article>
        `
      )
      .join("");
  }

  qsa("[data-open-run]").forEach((button) => {
    button.addEventListener("click", async () => {
      const path = button.dataset.openRun;
      await openHistoryDocument(path);
      setView("history");
    });
  });

  qsa("[data-open-interview]").forEach((button) => {
    button.addEventListener("click", async () => {
      const interview = state.bootstrap.interviews.find((item) => item.id === button.dataset.openInterview);
      if (!interview) return;
      const doc = await getDocument(interview.transcript_path, { activate: true });
      state.resultDocs.history = { path: doc.path, content: doc.content, mode: "preview" };
      renderHistoryDoc();
      if (state.bootstrap) {
        state.bootstrap.active_document = doc.path;
      }
      updateContextSummary();
      setView("history");
    });
  });

  qsa("[data-delete-dashboard-run]").forEach((button) => {
    button.addEventListener("click", async () => {
      await deleteRunRecord(button.dataset.deleteDashboardRun);
    });
  });

  qsa("[data-delete-dashboard-interview]").forEach((button) => {
    button.addEventListener("click", async () => {
      await deleteInterviewRecord(button.dataset.deleteDashboardInterview);
    });
  });

  qsa("[data-go-view]").forEach((button) => {
    if (button.classList.contains("nav-item")) return;
    button.addEventListener("click", () => setView(button.dataset.goView));
  });
}

function writeProviderToConfigForm(provider) {
  const form = qs("#configForm");
  form.provider_id.value = provider.id || "";
  form.saved_provider_id.value = provider.id || "";
  form.provider_label.value = provider.provider_label || "";
  form.provider_type.value = provider.provider_type || "demo";
  form.base_url.value = provider.base_url || "";
  form.api_key.value = provider.api_key || "";
  form.model_name.value = provider.model_name || "";
  form.temperature.value = provider.temperature ?? "";
  form.max_tokens.value = provider.max_tokens ?? "";
  form.reasoning_effort.value = provider.reasoning_effort || "";
  form.timeout_seconds.value = provider.timeout_seconds ?? "";
}

function fillConfigForm() {
  const config = state.bootstrap.config;
  const form = qs("#configForm");
  form.workspace_path.value = state.workspaceOverride || config.workspace_path || "";
  const providers = config.providers || [];
  const providerOptions = providers.length
    ? providers.map((provider) => `<option value="${provider.id}">${providerDisplayName(provider)}</option>`).join("")
    : `<option value="">暂无供应商配置</option>`;
  qs("#savedProviderSelect").innerHTML = providerOptions;
  qs("#defaultProviderSelect").innerHTML = providerOptions;
  const currentId = form.provider_id.value;
  const selectedProvider =
    providers.find((provider) => provider.id === currentId) ||
    providers.find((provider) => provider.id === config.default_provider_id) ||
    providers[0] ||
    blankProvider();
  writeProviderToConfigForm(selectedProvider);
  qs("#defaultProviderSelect").value = config.default_provider_id || selectedProvider.id || "";
}

function assetCard(asset, kind) {
  const meta =
    kind === "resume"
      ? `文件：${asset.filename}`
      : `文件数：${asset.file_count || 0} · ${asset.storage_mode === "reference" ? "来源：原始目录引用" : "来源：已复制到 workspace"}`;
  const quickActions =
    kind === "resume"
      ? `
        <button type="button" class="ghost-btn" data-use-resume-analysis="${asset.id}">用于简历分析</button>
        <button type="button" class="ghost-btn" data-use-mock-resume="${asset.id}">用于模拟面试</button>
      `
      : `
        <button type="button" class="ghost-btn" data-use-open-source="${asset.id}">去项目解读</button>
        <button type="button" class="ghost-btn" data-use-resume-project="${asset.id}">加入简历分析</button>
      `;
  return `
    <article class="item-card">
      <div class="item-title">
        <strong>${asset.name}</strong>
        <span>${formatDate(asset.updated_at)}</span>
      </div>
      <p>${meta}</p>
      <p class="item-path">${asset.path}</p>
      <label>
        <span>重命名</span>
        <input type="text" value="${asset.name}" data-rename-input="${kind}:${asset.id}" />
      </label>
      <div class="item-actions">
        ${quickActions}
        <button class="ghost-btn" data-rename-asset="${kind}:${asset.id}">保存名称</button>
        <button class="ghost-btn" data-delete-asset="${kind}:${asset.id}">删除</button>
      </div>
    </article>
  `;
}

function fillAssetLists() {
  const resumes = state.bootstrap.assets.resumes;
  const projects = state.bootstrap.assets.projects;
  const resumeList = qs("#resumeAssetList");
  const projectList = qs("#projectAssetList");
  const query = normalizeSearch(state.ui.preferences.assetSearch);
  const filteredResumes = resumes.filter((asset) => matchesSearch(`${asset.name} ${asset.filename || ""} ${asset.path}`, query));
  const filteredProjects = projects.filter((asset) => matchesSearch(`${asset.name} ${asset.path}`, query));

  setOptionalText(
    "#assetSearchMeta",
    query
      ? `显示 ${filteredResumes.length + filteredProjects.length} / ${resumes.length + projects.length} 项素材`
      : `共 ${resumes.length + projects.length} 项素材`
  );

  resumeList.innerHTML = filteredResumes.length
    ? filteredResumes.map((asset) => assetCard(asset, "resume")).join("")
    : `<div class="empty">${query ? "没有匹配的简历素材。" : "还没有简历素材。"}</div>`;
  projectList.innerHTML = filteredProjects.length
    ? filteredProjects.map((asset) => assetCard(asset, "project")).join("")
    : `<div class="empty">${query ? "没有匹配的项目素材。" : "还没有项目素材。"}</div>`;

  qsa("[data-rename-asset]").forEach((button) => {
    button.addEventListener("click", async () => {
      const [kind, assetId] = button.dataset.renameAsset.split(":");
      const input = qs(`[data-rename-input="${kind}:${assetId}"]`);
      await api("/api/assets/rename", {
        method: "POST",
        body: JSON.stringify({ kind, asset_id: assetId, new_name: input.value }),
      });
      await refreshBootstrap();
      showToast("素材名称已更新");
    });
  });

  qsa("[data-delete-asset]").forEach((button) => {
    button.addEventListener("click", async () => {
      const [kind, assetId] = button.dataset.deleteAsset.split(":");
      if (!window.confirm("确定删除这个素材吗？")) return;
      await api(`/api/assets/${kind}/${assetId}`, { method: "DELETE" });
      await refreshBootstrap();
      showToast("素材已删除");
    });
  });

  qsa("[data-use-resume-analysis]").forEach((button) => {
    button.addEventListener("click", async () => {
      updateFormPreference("resumeAnalysis", { resumeId: button.dataset.useResumeAnalysis });
      fillSelectors();
      setView("resume-analysis");
      await syncResumeAnalysisExistingResult();
      syncResumeCoachAvailability();
      updateActionAvailability();
    });
  });

  qsa("[data-use-mock-resume]").forEach((button) => {
    button.addEventListener("click", () => {
      updateFormPreference("mockInterview", {
        resumeId: button.dataset.useMockResume,
        analysisRunId: "",
      });
      fillSelectors();
      setView("mock-interview");
      updateActionAvailability();
    });
  });

  qsa("[data-use-open-source]").forEach((button) => {
    button.addEventListener("click", async () => {
      updateFormPreference("openSource", { projectId: button.dataset.useOpenSource });
      fillSelectors();
      setView("open-source");
      await syncOpenSourceExistingResult();
      updateActionAvailability();
    });
  });

  qsa("[data-use-resume-project]").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextProjectIds = normalizeIdList([
        ...(state.ui.preferences.forms.resumeAnalysis.projectIds || []),
        button.dataset.useResumeProject,
      ]);
      updateFormPreference("resumeAnalysis", { projectIds: nextProjectIds });
      fillSelectors();
      setView("resume-analysis");
      await syncResumeAnalysisExistingResult();
      updateActionAvailability();
    });
  });
}

function buildProjectChecks(container, projects, selectedIds = []) {
  if (!projects.length) {
    container.innerHTML = `<div class="empty">暂无项目素材</div>`;
    return;
  }
  container.innerHTML = projects
    .map(
      (project) => `
        <label class="check-row">
          <input type="checkbox" value="${project.id}" ${selectedIds.includes(project.id) ? "checked" : ""} />
          <span>${project.name}</span>
        </label>
      `
    )
    .join("");
}

function analysisRunsForResume(resumeAssetId) {
  const runs = (state.bootstrap?.runs || []).filter((run) => run.module_key === "resume_analysis");
  return resumeAssetId ? runs.filter((run) => (run.source?.resume_asset_id || "") === resumeAssetId) : runs;
}

function populateMockInterviewAnalysisOptions(resumeAssetId) {
  const previousValue = qs("#mockInterviewAnalysis").value;
  const preferredValue = state.ui.preferences.forms.mockInterview.analysisRunId || previousValue;
  const matchingRuns = analysisRunsForResume(resumeAssetId);
  qs("#mockInterviewAnalysis").innerHTML = `<option value="">不引用</option>${matchingRuns
    .map((run) => `<option value="${run.id}">${PathBasename(run.path)}</option>`)
    .join("")}`;
  const selectedValue = applySelectValue("#mockInterviewAnalysis", [
    preferredValue,
    latestResumeAnalysisRunId(resumeAssetId),
    "",
  ]);
  updateFormPreference("mockInterview", { analysisRunId: selectedValue });
}

function fillSelectors() {
  const resumes = state.bootstrap.assets.resumes;
  const projects = state.bootstrap.assets.projects;
  const reviewRuns = state.bootstrap.runs.filter((run) => run.module_key === "interview_review");
  const latestReviewRuns = latestReviewRunsByInterview(reviewRuns);
  const providers = state.bootstrap.config.providers || [];
  const prefs = state.ui.preferences.forms;
  const defaultProviderId = state.bootstrap.config.default_provider_id || providers[0]?.id || "";
  const providerOptions = providers.length
    ? providers.map((provider) => `<option value="${provider.id}">${providerDisplayName(provider)}</option>`).join("")
    : `<option value="">暂无供应商配置</option>`;
  const resumeOptions = resumes.length
    ? resumes.map((asset) => `<option value="${asset.id}">${asset.name}</option>`).join("")
    : `<option value="">暂无简历素材</option>`;
  const projectOptions = projects.length
    ? projects.map((project) => `<option value="${project.id}">${project.name}</option>`).join("")
    : `<option value="">暂无项目素材</option>`;

  const previousValues = {
    resumeAnalysisResume: qs("#resumeAnalysisResume").value,
    mockInterviewResume: qs("#mockInterviewResume").value,
    reviewInterview: qs("#reviewInterviewSelect").value,
    learningReview: qs("#learningReviewSelect").value,
    openSourceProject: qs("#openSourceProject").value,
    resumeAnalysisProvider: qs("#resumeAnalysisProvider").value,
    mockInterviewProvider: qs("#mockInterviewProvider").value,
    reviewProvider: qs("#reviewProvider").value,
    learningProvider: qs("#learningProvider").value,
    openSourceProvider: qs("#openSourceProvider").value,
    generalChatProvider: qs("#generalChatProvider").value,
  };

  ["#resumeAnalysisResume", "#mockInterviewResume"].forEach((selector) => {
    qs(selector).innerHTML = resumeOptions;
  });
  qs("#reviewInterviewSelect").innerHTML = state.bootstrap.interviews.length
    ? state.bootstrap.interviews.map((item) => `<option value="${item.id}">${item.title}</option>`).join("")
    : `<option value="">暂无面试记录</option>`;
  qs("#learningReviewSelect").innerHTML = latestReviewRuns.length
    ? latestReviewRuns.map((run) => `<option value="${run.id}">${reviewRunLabel(run)}</option>`).join("")
    : `<option value="">暂无面试评价</option>`;
  qs("#openSourceProject").innerHTML = projectOptions;

  ["#resumeAnalysisProvider", "#mockInterviewProvider", "#reviewProvider", "#learningProvider", "#openSourceProvider", "#generalChatProvider"].forEach((selector) => {
    qs(selector).innerHTML = providerOptions;
  });

  const selectedResumeAnalysisResume = applySelectValue("#resumeAnalysisResume", [
    prefs.resumeAnalysis.resumeId,
    previousValues.resumeAnalysisResume,
    resumes[0]?.id,
    "",
  ]);
  const selectedMockInterviewResume = applySelectValue("#mockInterviewResume", [
    prefs.mockInterview.resumeId,
    previousValues.mockInterviewResume,
    selectedResumeAnalysisResume,
    resumes[0]?.id,
    "",
  ]);
  const selectedReviewInterview = applySelectValue("#reviewInterviewSelect", [
    prefs.review.interviewId,
    previousValues.reviewInterview,
    state.bootstrap.interviews[0]?.id,
    "",
  ]);
  const selectedLearningReview = applySelectValue("#learningReviewSelect", [
    prefs.learning.reviewRunId,
    previousValues.learningReview,
    latestReviewRuns[0]?.id,
    "",
  ]);
  const selectedOpenSourceProject = applySelectValue("#openSourceProject", [
    prefs.openSource.projectId,
    previousValues.openSourceProject,
    projects[0]?.id,
    "",
  ]);

  applySelectValue("#resumeAnalysisProvider", [
    prefs.resumeAnalysis.providerId,
    previousValues.resumeAnalysisProvider,
    defaultProviderId,
  ]);
  applySelectValue("#mockInterviewProvider", [
    prefs.mockInterview.providerId,
    previousValues.mockInterviewProvider,
    defaultProviderId,
  ]);
  applySelectValue("#reviewProvider", [
    prefs.review.providerId,
    previousValues.reviewProvider,
    defaultProviderId,
  ]);
  applySelectValue("#learningProvider", [
    prefs.learning.providerId,
    previousValues.learningProvider,
    defaultProviderId,
  ]);
  applySelectValue("#openSourceProvider", [
    prefs.openSource.providerId,
    previousValues.openSourceProvider,
    defaultProviderId,
  ]);
  applySelectValue("#generalChatProvider", [
    prefs.generalChat.providerId,
    previousValues.generalChatProvider,
    defaultProviderId,
  ]);

  populateMockInterviewAnalysisOptions(selectedMockInterviewResume);
  buildProjectChecks(qs("#resumeAnalysisProjects"), projects, prefs.resumeAnalysis.projectIds.filter((id) => projects.some((project) => project.id === id)));
  buildProjectChecks(qs("#mockInterviewProjects"), projects, prefs.mockInterview.projectIds.filter((id) => projects.some((project) => project.id === id)));
  syncLearningProjectChecks();
  applySelectValue("#learningReviewSelect", [selectedLearningReview]);
  applySelectValue("#openSourceProject", [selectedOpenSourceProject]);
}

function PathBasename(path) {
  return path.split(/[\\/]/).pop();
}

function interviewById(interviewId) {
  return (state.bootstrap?.interviews || []).find((item) => item.id === interviewId) || null;
}

function reviewRunLabel(run) {
  const baseLabel = run.title || PathBasename(run.path || "");
  const interviewId = run?.source?.interview_id || "";
  const interview = interviewById(interviewId);
  return interview ? `${baseLabel}（关联：${interview.title}）` : baseLabel;
}

function latestReviewRunsByInterview(reviewRuns) {
  const sorted = [...(reviewRuns || [])].sort(
    (left, right) => parseDateSafe(right.updated_at || right.created_at) - parseDateSafe(left.updated_at || left.created_at)
  );
  const latestByKey = new Map();
  sorted.forEach((run) => {
    const interviewId = run?.source?.interview_id || "";
    const key = interviewId || run.id;
    if (!latestByKey.has(key)) {
      latestByKey.set(key, run);
    }
  });
  return Array.from(latestByKey.values()).sort(
    (left, right) => parseDateSafe(right.updated_at || right.created_at) - parseDateSafe(left.updated_at || left.created_at)
  );
}

function latestLearningRunByReview(reviewRunId) {
  if (!reviewRunId) return null;
  return (state.bootstrap?.runs || [])
    .filter((run) => run.module_key === "learning")
    .filter((run) => (run.source?.review_run_id || "") === reviewRunId)
    .sort((left, right) => parseDateSafe(right.updated_at || right.created_at) - parseDateSafe(left.updated_at || left.created_at))[0] || null;
}

function reviewRunById(reviewRunId) {
  return (state.bootstrap?.runs || []).find((run) => run.id === reviewRunId && run.module_key === "interview_review") || null;
}

function syncLearningProjectChecks() {
  const reviewRunId = qs("#learningReviewSelect").value;
  const learningRun = latestLearningRunByReview(reviewRunId);
  const reviewRun = reviewRunById(reviewRunId);
  const preferredIds = state.ui.preferences.forms.learning.projectIds;
  const selectedIds = preferredIds.length ? preferredIds : learningRun?.source?.project_asset_ids || reviewRun?.source?.project_asset_ids || [];
  buildProjectChecks(qs("#learningProjects"), state.bootstrap?.assets?.projects || [], selectedIds);
}

async function loadExistingLearningResult() {
  const reviewRunId = qs("#learningReviewSelect").value;
  syncLearningProjectChecks();
  const existingRun = latestLearningRunByReview(reviewRunId);
  if (!existingRun) {
    state.resultDocs.learning = { path: "", content: "", mode: "preview" };
    renderManagedResultDoc("learning", "#learningResult", "#learningSaveBtn", "learningEditor", "#learningApplyCommentsBtn");
    if (reviewRunId) {
      setStatus("#learningStatus", "当前这份面试评价还没有学习总结，可直接点击生成。");
    } else {
      setStatus("#learningStatus", "请先选择一份面试评价。");
    }
    syncPreferencesFromDom();
    return;
  }
  const doc = await getDocument(existingRun.path);
  state.resultDocs.learning = { path: doc.path, content: doc.content, mode: "preview" };
  renderManagedResultDoc("learning", "#learningResult", "#learningSaveBtn", "learningEditor", "#learningApplyCommentsBtn");
  setStatus("#learningStatus", "已加载这份面试评价对应的学习总结。");
  syncPreferencesFromDom();
}

function selectedProjectIds(containerSelector) {
  return qsa(`${containerSelector} input[type="checkbox"]:checked`).map((input) => input.value);
}

async function deleteHistoryEntries(entryKeys, confirmMessage, successMessage) {
  const entries = historyEntries("").filter((entry) => entryKeys.includes(entry.key));
  if (!entries.length) return false;
  if (!window.confirm(confirmMessage)) return false;

  const pathsToDelete = new Set(entries.map((entry) => entry.path));
  const deletedRunIds = new Set(entries.filter((entry) => entry.record_type === "run").map((entry) => entry.record_id));
  const deletedInterviewIds = new Set(entries.filter((entry) => entry.record_type === "interview").map((entry) => entry.record_id));
  for (const entry of entries) {
    if (entry.record_type === "interview") {
      await api(`/api/interviews/${entry.record_id}`, { method: "DELETE" });
      continue;
    }
    await api(`/api/runs/${entry.record_id}`, { method: "DELETE" });
  }

  if (pathsToDelete.has(state.resultDocs.history.path)) {
    state.resultDocs.history = { path: "", content: "", mode: "preview" };
    renderHistoryDoc();
    if (state.bootstrap) {
      state.bootstrap.active_document = "";
    }
    updateContextSummary();
  }
  if (deletedRunIds.has(state.generalChatRunId)) {
    state.generalChatRunId = "";
  }
  if (state.currentInterview && deletedInterviewIds.has(state.currentInterview.id)) {
    state.currentInterview = null;
    renderInterviewChat([]);
  }
  state.selectedHistoryEntryKeys = state.selectedHistoryEntryKeys.filter((key) => !entryKeys.includes(key));
  await refreshBootstrap();
  showToast(successMessage);
  return true;
}

async function deleteRunRecord(runId) {
  const run = state.bootstrap.runs.find((item) => item.id === runId);
  if (!run) return false;
  const fileName = PathBasename(run.path);
  return deleteHistoryEntries(
    [`run:${runId}`],
    `\u786e\u5b9a\u8981\u5220\u9664\u8fd9\u4efd\u6587\u6863\u5417\uff1f\n\n\u6587\u4ef6\u540d\uff1a${fileName}\n\u6807\u9898\uff1a${run.title}\n\n\u6b64\u64cd\u4f5c\u4f1a\u76f4\u63a5\u5220\u9664\u672c\u5730\u6587\u4ef6\uff0c\u4e14\u65e0\u6cd5\u6062\u590d\u3002`,
    "\u6587\u6863\u5df2\u5220\u9664"
  );
}

async function deleteInterviewRecord(interviewId) {
  const interview = state.bootstrap.interviews.find((item) => item.id === interviewId);
  if (!interview) return false;
  return deleteHistoryEntries(
    [`interview:${interviewId}`],
    `\u786e\u5b9a\u8981\u5220\u9664\u8fd9\u573a\u9762\u8bd5\u5417\uff1f\n\n\u6807\u9898\uff1a${interview.title}\n\u65f6\u95f4\uff1a${formatDate(interview.updated_at)}\n\n\u6b64\u64cd\u4f5c\u4f1a\u5220\u9664\u9762\u8bd5\u8bb0\u5f55\u4e0e\u8f6c\u5f55\u6587\u4ef6\uff0c\u4e14\u65e0\u6cd5\u6062\u590d\u3002`,
    "\u9762\u8bd5\u8bb0\u5f55\u5df2\u5220\u9664"
  );
}

function renderHistoryList() {
  const filter = qs("#historyModuleFilter").value;
  const searchQuery = normalizeSearch(state.ui.preferences.historySearch);
  const sourceEntries = historyEntries(filter);
  const entries = sourceEntries.filter((entry) =>
    matchesSearch(`${entry.title} ${PathBasename(entry.path)} ${moduleLabel(entry.module_key)}`, searchQuery)
  );
  const target = qs("#historyList");
  const selectedEntryKeys = new Set(state.selectedHistoryEntryKeys);
  const filteredEntryKeys = entries.map((entry) => entry.key);
  const selectedFilteredCount = filteredEntryKeys.filter((key) => selectedEntryKeys.has(key)).length;
  const allFilteredSelected = filteredEntryKeys.length > 0 && selectedFilteredCount === filteredEntryKeys.length;
  setOptionalText(
    "#historySearchMeta",
    searchQuery ? `显示 ${entries.length} / ${sourceEntries.length} 条记录` : `共 ${sourceEntries.length} 条记录`
  );
  if (!entries.length) {
    renderEmpty(target, searchQuery ? "没有匹配的文档记录。" : "暂无文档。");
    return;
  }
  target.innerHTML = `
    <div class="history-bulk-bar">
      <label class="check-row compact">
        <input type="checkbox" id="historySelectAll" ${allFilteredSelected ? "checked" : ""} />
        <span>\u5168\u9009</span>
      </label>
      <span class="input-hint">\u5df2\u9009 ${selectedFilteredCount} \u9879</span>
      <button class="ghost-btn danger" id="historyDeleteSelectedBtn" ${selectedFilteredCount ? "" : "disabled"}>\u6279\u91cf\u5220\u9664</button>
    </div>
    ${entries
      .map(
        (entry) => `
          <article class="item-card">
            <div class="item-title">
              <label class="check-row compact">
                <input type="checkbox" data-select-history="${entry.key}" ${selectedEntryKeys.has(entry.key) ? "checked" : ""} />
                <strong>${entry.title}</strong>
              </label>
              <span>${moduleLabel(entry.module_key)}</span>
            </div>
            <p>${formatDate(entry.updated_at)}</p>
            <p>${PathBasename(entry.path)}</p>
            <div class="item-actions">
              <button class="ghost-btn" data-history-path="${entry.path}">\u6253\u5f00</button>
              <button class="ghost-btn danger" data-delete-history='${JSON.stringify({ key: entry.key, type: entry.record_type, id: entry.record_id })}'>\u5220\u9664</button>
            </div>
          </article>
        `
      )
      .join("")}
  `;

  qsa("[data-history-path]").forEach((button) => {
    button.addEventListener("click", async () => openHistoryDocument(button.dataset.historyPath));
  });

  qsa("[data-select-history]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const nextSelected = new Set(state.selectedHistoryEntryKeys);
      if (checkbox.checked) {
        nextSelected.add(checkbox.dataset.selectHistory);
      } else {
        nextSelected.delete(checkbox.dataset.selectHistory);
      }
      state.selectedHistoryEntryKeys = Array.from(nextSelected);
      renderHistoryList();
    });
  });

  qs("#historySelectAll")?.addEventListener("change", (event) => {
    const nextSelected = new Set(state.selectedHistoryEntryKeys);
    if (event.currentTarget.checked) {
      filteredEntryKeys.forEach((key) => nextSelected.add(key));
    } else {
      filteredEntryKeys.forEach((key) => nextSelected.delete(key));
    }
    state.selectedHistoryEntryKeys = Array.from(nextSelected);
    renderHistoryList();
  });

  qs("#historyDeleteSelectedBtn")?.addEventListener("click", async () => {
    const selectedKeys = filteredEntryKeys.filter((key) => state.selectedHistoryEntryKeys.includes(key));
    if (!selectedKeys.length) return;
    await deleteHistoryEntries(
      selectedKeys,
      `\u786e\u5b9a\u8981\u6279\u91cf\u5220\u9664 ${selectedKeys.length} \u6761\u8bb0\u5f55\u5417\uff1f\n\n\u6b64\u64cd\u4f5c\u4f1a\u76f4\u63a5\u5220\u9664\u5bf9\u5e94\u6587\u6863\uff0c\u4e14\u65e0\u6cd5\u6062\u590d\u3002`,
      `\u5df2\u6279\u91cf\u5220\u9664 ${selectedKeys.length} \u6761\u8bb0\u5f55`
    );
  });

  qsa("[data-delete-history]").forEach((button) => {
    button.addEventListener("click", async () => {
      const payload = JSON.parse(button.dataset.deleteHistory);
      try {
        if (payload.type === "interview") {
          await deleteInterviewRecord(payload.id);
          return;
        }
        await deleteRunRecord(payload.id);
      } catch (error) {
        showToast(`\u5220\u9664\u5931\u8d25\uff1a${error.message}`, true);
      }
    });
  });
}

async function openHistoryDocument(path) {
  const doc = await getDocument(path, { activate: true });
  state.resultDocs.history = { path: doc.path, content: doc.content, mode: "preview" };
  renderHistoryDoc();
  if (state.bootstrap) {
    state.bootstrap.active_document = doc.path;
  }
  updateContextSummary();
}

async function refreshBootstrap() {
  const bootstrap = await api("/api/bootstrap");
  setBootstrap(bootstrap);
  await loadExistingLearningResult();
  await syncResumeAnalysisExistingResult();
  await syncReviewExistingResult();
  await syncOpenSourceExistingResult();
  if (state.ui.currentView === "history" && state.bootstrap?.active_document && state.resultDocs.history.path !== state.bootstrap.active_document) {
    await openHistoryDocument(state.bootstrap.active_document);
  }
  syncResumeCoachAvailability();
  updateActionAvailability();
  updateContextSummary();
}

async function fileToText(file) {
  return file.text();
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}

function interviewShell() {
  return qs("#interviewChat");
}

function isNearBottom(node, threshold = 24) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

function syncInterviewScrollState() {
  const shell = interviewShell();
  state.interviewAutoScroll = isNearBottom(shell);
  const scrollBtn = qs("#interviewScrollToBottomBtn");
  if (scrollBtn) {
    scrollBtn.hidden = state.interviewAutoScroll;
  }
}

function scrollInterviewToBottom(force = false) {
  const shell = interviewShell();
  if (!shell) return;
  if (force || state.interviewAutoScroll) {
    shell.scrollTop = shell.scrollHeight;
  }
  syncInterviewScrollState();
}

function setInterviewMessages(messages, options = {}) {
  state.interviewMessages = (messages || []).map((message) => ({ ...message }));
  renderInterviewChat(state.interviewMessages, options);
}

function updateStreamingAssistant(delta) {
  if (!state.interviewMessages.length) return;
  const nextMessages = state.interviewMessages.map((message) => ({ ...message }));
  const lastMessage = nextMessages[nextMessages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") return;
  lastMessage.content = `${lastMessage.content || ""}${delta || ""}`;
  lastMessage.pending = false;
  setInterviewMessages(nextMessages);
}

function renderInterviewChat(messages, options = {}) {
  const shell = interviewShell();
  if (!shell) return;
  const follow = options.forceScroll || state.interviewAutoScroll || isNearBottom(shell);
  if (!messages || !messages.length) {
    renderEmpty(shell, "启动面试后，对话会显示在这里。");
    syncInterviewScrollState();
    return;
  }
  shell.innerHTML = messages
    .map((message) => {
      const placeholder = message.pending && !message.content
        ? `<div class="markdown-body"><p class="streaming-placeholder">正在生成问题...</p></div>`
        : markdownToHtml(message.content || "");
      return `
        <article class="chat-message ${message.role}${message.pending ? " pending" : ""}">
          <h4>${message.role === "assistant" ? "面试官" : "候选人"}</h4>
          ${placeholder}
        </article>
      `;
    })
    .join("");
  if (follow) {
    shell.scrollTop = shell.scrollHeight;
  }
  syncInterviewScrollState();
}

function renderSimpleChat(selector, messages, emptyText, assistantLabel = "AI") {
  const shell = qs(selector);
  if (!messages || !messages.length) {
    renderEmpty(shell, emptyText);
    return;
  }
  shell.innerHTML = messages
    .map(
      (message) => `
        <article class="chat-message ${message.role}">
          <h4>${message.role === "assistant" ? assistantLabel : "用户"}</h4>
          ${markdownToHtml(message.content)}
        </article>
      `
    )
    .join("");
  shell.scrollTop = shell.scrollHeight;
}

function parseDateSafe(value) {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function latestResumeAnalysisRunId(resumeAssetId) {
  const runs = state.bootstrap?.runs || [];
  const matched = runs
    .filter((run) => run.module_key === "resume_analysis")
    .filter((run) => !resumeAssetId || (run.metadata && run.metadata.resume_asset_id === resumeAssetId))
    .sort((a, b) => parseDateSafe(b.created_at) - parseDateSafe(a.created_at));
  return matched[0]?.id || "";
}

function latestResumeAnalysisRun(resumeAssetId, projectIds = []) {
  const runs = (state.bootstrap?.runs || [])
    .filter((run) => run.module_key === "resume_analysis")
    .filter((run) => !resumeAssetId || (run.source?.resume_asset_id || run.metadata?.resume_asset_id || "") === resumeAssetId);
  if (!runs.length) return null;
  if (projectIds.length) {
    const exactMatch = runs.find((run) => sameIdSet(run.source?.project_asset_ids || [], projectIds));
    if (exactMatch) return exactMatch;
  }
  return runs[0];
}

function latestReviewRun(interviewId) {
  return (
    (state.bootstrap?.runs || [])
      .filter((run) => run.module_key === "interview_review")
      .find((run) => (run.source?.interview_id || "") === interviewId) || null
  );
}

function latestOpenSourceRun(projectAssetId) {
  return (
    (state.bootstrap?.runs || [])
      .filter((run) => run.module_key === "open_source_reading")
      .find((run) => (run.source?.project_asset_id || "") === projectAssetId) || null
  );
}

async function syncResumeAnalysisExistingResult() {
  const resumeId = qs("#resumeAnalysisResume").value;
  const projectIds = selectedProjectIds("#resumeAnalysisProjects");
  if (!resumeId) {
    state.resultDocs.resumeAnalysis = { path: "", content: "", mode: "preview" };
    renderDoc(qs("#resumeAnalysisResult"), state.resultDocs.resumeAnalysis);
    setStatus("#resumeAnalysisStatus", "请先选择一份简历。");
    return;
  }
  const run = latestResumeAnalysisRun(resumeId, projectIds);
  if (!run) {
    state.resultDocs.resumeAnalysis = { path: "", content: "", mode: "preview" };
    renderDoc(qs("#resumeAnalysisResult"), state.resultDocs.resumeAnalysis);
    setStatus("#resumeAnalysisStatus", "当前这组简历与项目还没有历史分析，点击“生成分析”开始。");
    return;
  }
  if (state.resultDocs.resumeAnalysis.path !== run.path) {
    const doc = await getDocument(run.path);
    state.resultDocs.resumeAnalysis = { path: doc.path, content: doc.content, mode: "preview" };
    renderDoc(qs("#resumeAnalysisResult"), state.resultDocs.resumeAnalysis);
  }
  setStatus(
    "#resumeAnalysisStatus",
    `已自动载入最近一次分析：${formatDate(run.updated_at || run.created_at)}。如果当前项目组合不同，可重新生成。`
  );
}

async function syncReviewExistingResult() {
  const interviewId = qs("#reviewInterviewSelect").value;
  if (!interviewId) {
    state.resultDocs.review = { path: "", content: "", mode: "preview" };
    renderDoc(qs("#reviewResult"), state.resultDocs.review);
    setStatus("#reviewStatus", "请先选择一条面试记录。");
    return;
  }
  const run = latestReviewRun(interviewId);
  if (!run) {
    state.resultDocs.review = { path: "", content: "", mode: "preview" };
    renderDoc(qs("#reviewResult"), state.resultDocs.review);
    setStatus("#reviewStatus", "当前面试记录还没有评价，点击“生成评价”开始。");
    return;
  }
  if (state.resultDocs.review.path !== run.path) {
    const doc = await getDocument(run.path);
    state.resultDocs.review = { path: doc.path, content: doc.content, mode: "preview" };
    renderDoc(qs("#reviewResult"), state.resultDocs.review);
  }
  setStatus("#reviewStatus", `已自动载入最近一次评价：${formatDate(run.updated_at || run.created_at)}。`);
}

async function syncOpenSourceExistingResult() {
  const projectId = qs("#openSourceProject").value;
  if (!projectId) {
    state.resultDocs.openSource = { path: "", content: "", mode: "preview" };
    renderDoc(qs("#openSourceResult"), state.resultDocs.openSource);
    setStatus("#openSourceStatus", "请先选择一个项目素材。");
    return;
  }
  const run = latestOpenSourceRun(projectId);
  if (!run) {
    state.resultDocs.openSource = { path: "", content: "", mode: "preview" };
    renderDoc(qs("#openSourceResult"), state.resultDocs.openSource);
    setStatus("#openSourceStatus", "当前项目还没有历史解读，点击“生成解读”开始。");
    return;
  }
  if (state.resultDocs.openSource.path !== run.path) {
    const doc = await getDocument(run.path);
    state.resultDocs.openSource = { path: doc.path, content: doc.content, mode: "preview" };
    renderDoc(qs("#openSourceResult"), state.resultDocs.openSource);
  }
  setStatus("#openSourceStatus", `已自动载入最近一次项目解读：${formatDate(run.updated_at || run.created_at)}。`);
}

function setButtonAvailability(selector, enabled, tooltip = "") {
  const button = qs(selector);
  if (!button) return;
  button.disabled = !enabled;
  if (enabled) {
    button.removeAttribute("title");
  } else if (tooltip) {
    button.title = tooltip;
  }
}

function updateActionAvailability() {
  const hasResumeForAnalysis = Boolean(qs("#resumeAnalysisResume").value && qs("#resumeAnalysisProvider").value);
  const hasResumeForInterview = Boolean(qs("#mockInterviewResume").value && qs("#mockInterviewProvider").value);
  const hasInterviewForReview = Boolean(qs("#reviewInterviewSelect").value && qs("#reviewProvider").value);
  const hasReviewForLearning = Boolean(qs("#learningReviewSelect").value && qs("#learningProvider").value);
  const hasProjectForOpenSource = Boolean(qs("#openSourceProject").value && qs("#openSourceProvider").value);
  const hasProviderForChat = Boolean(qs("#generalChatProvider").value);
  const hasResumeForCoach = Boolean(qs("#resumeAnalysisResume").value && qs("#resumeAnalysisProvider").value);

  setButtonAvailability('#resumeAnalysisForm button[type="submit"]', hasResumeForAnalysis, "先准备简历和模型配置");
  setButtonAvailability('#mockInterviewForm button[type="submit"]', hasResumeForInterview, "先准备简历和模型配置");
  setButtonAvailability('#reviewForm button[type="submit"]', hasInterviewForReview, "先选择面试记录和模型");
  setButtonAvailability('#learningForm button[type="submit"]', hasReviewForLearning, "先选择面试评价和模型");
  setButtonAvailability('#openSourceForm button[type="submit"]', hasProjectForOpenSource, "先选择项目和模型");
  setButtonAvailability('#generalChatForm button[type="submit"]', hasProviderForChat, "先选择模型配置");
  setButtonAvailability('#resumeCoachForm button[type="submit"]', hasResumeForCoach, "先选择简历和模型配置");
}

function syncResumeCoachAvailability() {
  const resumeAssetId = qs("#resumeAnalysisResume").value;
  if (!resumeAssetId) {
    setStatus("#resumeCoachStatus", "先选择简历，再让 AI 帮你逐轮优化表述。");
    return;
  }
  const latestRunId = latestResumeAnalysisRunId(resumeAssetId);
  if (!latestRunId && !state.resumeCoachMessages.length) {
    setStatus("#resumeCoachStatus", "还没有历史分析，AI 也可以直接提修改建议，但建议先生成一版分析。");
    return;
  }
  if (!state.resumeCoachMessages.length) {
    setStatus("#resumeCoachStatus", "已检测到最近一次简历分析，可直接继续追问并迭代修改。");
  }
}

async function loadInterviewMessages(interview) {
  const doc = await getDocument(interview.transcript_path, { activate: true });
  state.resultDocs.history = { path: doc.path, content: doc.content, mode: "preview" };
  if (state.bootstrap) {
    state.bootstrap.active_document = doc.path;
  }
  updateContextSummary();
}

async function syncInterviewAfterStream(interview, messages, finalStatus) {
  state.currentInterview = interview;
  refreshInterviewActionAvailability();
  setInterviewMessages(messages, { forceScroll: false });
  await loadInterviewMessages(interview);
  await refreshBootstrap();
  setStatus("#mockInterviewStatus", finalStatus);
}

async function runInterviewStream(path, payload) {
  let finalPayload = null;
  await streamApi(path, { method: "POST", body: JSON.stringify(payload) }, (event) => {
    if (event.event === "ack") {
      return;
    }
    if (event.event === "delta") {
      updateStreamingAssistant(event.delta || "");
      return;
    }
    if (event.event === "complete") {
      finalPayload = event;
      return;
    }
    if (event.event === "error") {
      throw new Error(event.error || "流式请求失败");
    }
  });
  if (!finalPayload) {
    throw new Error("流式响应未返回完成结果");
  }
  return finalPayload;
}

function setVoiceStatus(message) {
  qs("#voiceStatus").textContent = message;
}

function refreshVoiceToggleButton() {
  const button = qs("#voiceToggleBtn");
  if (!button) return;
  if (!state.speech.supported) {
    button.textContent = "\u8bed\u97f3\u4e0d\u53ef\u7528";
    button.disabled = true;
    return;
  }
  button.disabled = false;
  button.textContent = state.speech.listening ? "\u505c\u6b62\u5f55\u97f3" : "\u5f00\u59cb\u8bed\u97f3\u8f6c\u6587\u5b57";
}

function getAnswerTextarea() {
  return qs('#interviewReplyForm textarea[name="answer"]');
}

function mergeSpeechText(baseText, appendedText) {
  const base = (baseText || "").trim();
  const extra = (appendedText || "").trim();
  if (!base) return extra;
  if (!extra) return base;
  return `${base}\n${extra}`;
}

function toggleVoiceRecognition() {
  if (!state.speech.supported || !state.speech.recognition) {
    throw new Error("\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u8bed\u97f3\u8bc6\u522b");
  }
  if (state.speech.listening) {
    state.speech.recognition.stop();
    return;
  }
  state.speech.baseText = getAnswerTextarea().value;
  state.speech.finalText = "";
  state.speech.recognition.start();
}

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setVoiceStatus("当前浏览器不支持原生语音识别，推荐使用最新版 Edge / Chrome。");
    refreshVoiceToggleButton();
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  state.speech.recognition = recognition;
  state.speech.supported = true;
  refreshVoiceToggleButton();
  setVoiceStatus("点击“开始语音转文字”后，对着麦克风说话，识别结果会自动写入回答框。");

  recognition.onstart = () => {
    state.speech.listening = true;
    state.speech.finalText = "";
    state.speech.baseText = getAnswerTextarea().value;
    refreshVoiceToggleButton();
    setVoiceStatus("正在监听麦克风并转文字...");
  };

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let i = 0; i < event.results.length; i += 1) {
      const transcript = event.results[i][0]?.transcript || "";
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interimText += transcript;
      }
    }
    state.speech.finalText = finalText.trim();
    getAnswerTextarea().value = mergeSpeechText(state.speech.baseText, `${finalText} ${interimText}`.trim());
  };

  recognition.onerror = (event) => {
    state.speech.listening = false;
    refreshVoiceToggleButton();
    setVoiceStatus(`语音识别失败：${event.error || "未知错误"}`);
  };

  recognition.onend = () => {
    state.speech.listening = false;
    refreshVoiceToggleButton();
    setVoiceStatus("语音识别已停止。可以继续手动编辑文字，或再次开始录音。");
  };
}

function bindEvents() {
  qsa(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  qs("#navToggleBtn")?.addEventListener("click", () => toggleSidebar(true));
  qs("#sidebarCloseBtn")?.addEventListener("click", () => toggleSidebar(false));
  qs("#navBackdrop")?.addEventListener("click", () => toggleSidebar(false));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.ui.sidebarOpen) {
      toggleSidebar(false);
    }
  });
  qs("#refreshBtn").addEventListener("click", async () => {
    await refreshBootstrap();
    showToast("数据已刷新");
  });
  qs("#jumpToActiveDocBtn")?.addEventListener("click", async () => {
    const path = state.bootstrap?.active_document || state.resultDocs.history.path;
    if (!path) return;
    await openHistoryDocument(path);
    setView("history");
  });

  qs("#historyModuleFilter").addEventListener("change", () => {
    renderHistoryList();
  });
  qs("#historySearchInput").addEventListener("input", (event) => {
    state.ui.preferences.historySearch = event.currentTarget.value;
    persistUiPreferences();
    renderHistoryList();
  });
  qs("#assetSearchInput").addEventListener("input", (event) => {
    state.ui.preferences.assetSearch = event.currentTarget.value;
    persistUiPreferences();
    fillAssetLists();
  });
  qs("#applyWorkspaceBtn")?.addEventListener("click", async () => {
    const form = qs("#configForm");
    persistWorkspaceOverride(form?.workspace_path?.value || "");
    await refreshBootstrap();
    showToast(state.workspaceOverride ? "\u5df2\u5e94\u7528\u5f53\u524d Workspace" : "\u5df2\u6062\u590d\u5168\u5c40\u9ed8\u8ba4 Workspace");
  });
  qs("#clearWorkspaceBtn")?.addEventListener("click", async () => {
    const form = qs("#configForm");
    if (form?.workspace_path) {
      form.workspace_path.value = "";
    }
    persistWorkspaceOverride("");
    await refreshBootstrap();
    showToast("\u5df2\u6e05\u9664 Workspace \u8986\u76d6");
  });

  wireModeButtons("#resumeAnalysisPreviewBtn", "#resumeAnalysisSourceBtn", "resumeAnalysis", "#resumeAnalysisResult");
  wireModeButtons("#reviewPreviewBtn", "#reviewSourceBtn", "review", "#reviewResult");
  wireEditableResultButtons(
    "#learningPreviewBtn",
    "#learningSourceBtn",
    "#learningSaveBtn",
    "learning",
    "#learningResult",
    "learningEditor",
    "#learningApplyCommentsBtn",
    "#learningStatus"
  );
  wireModeButtons("#openSourcePreviewBtn", "#openSourceSourceBtn", "openSource", "#openSourceResult");
  wireModeButtons("#historyPreviewBtn", "#historySourceBtn", "history", "#historyDocument");
  qs("#learningReviewSelect").addEventListener("change", async () => {
    updateFormPreference("learning", { reviewRunId: qs("#learningReviewSelect").value, projectIds: [] });
    await loadExistingLearningResult();
    updateActionAvailability();
  });

  qs("#resumeAnalysisResume").addEventListener("change", async () => {
    updateFormPreference("resumeAnalysis", { resumeId: qs("#resumeAnalysisResume").value });
    await syncResumeAnalysisExistingResult();
    syncResumeCoachAvailability();
    updateActionAvailability();
  });
  qs("#resumeAnalysisProvider").addEventListener("change", () => {
    updateFormPreference("resumeAnalysis", { providerId: qs("#resumeAnalysisProvider").value });
    syncResumeCoachAvailability();
    updateActionAvailability();
  });
  qs("#resumeAnalysisProjects").addEventListener("change", async (event) => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    updateFormPreference("resumeAnalysis", { projectIds: selectedProjectIds("#resumeAnalysisProjects") });
    await syncResumeAnalysisExistingResult();
  });

  qs("#mockInterviewResume").addEventListener("change", () => {
    updateFormPreference("mockInterview", {
      resumeId: qs("#mockInterviewResume").value,
      analysisRunId: "",
    });
    populateMockInterviewAnalysisOptions(qs("#mockInterviewResume").value);
    updateActionAvailability();
  });
  qs("#mockInterviewProvider").addEventListener("change", () => {
    updateFormPreference("mockInterview", { providerId: qs("#mockInterviewProvider").value });
    updateActionAvailability();
  });
  qs("#mockInterviewProjects").addEventListener("change", (event) => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    updateFormPreference("mockInterview", { projectIds: selectedProjectIds("#mockInterviewProjects") });
  });
  qs("#mockInterviewAnalysis").addEventListener("change", () => {
    updateFormPreference("mockInterview", { analysisRunId: qs("#mockInterviewAnalysis").value });
  });

  qs("#reviewInterviewSelect").addEventListener("change", async () => {
    updateFormPreference("review", { interviewId: qs("#reviewInterviewSelect").value });
    await syncReviewExistingResult();
    updateActionAvailability();
  });
  qs("#reviewProvider").addEventListener("change", () => {
    updateFormPreference("review", { providerId: qs("#reviewProvider").value });
    updateActionAvailability();
  });

  qs("#learningProvider").addEventListener("change", () => {
    updateFormPreference("learning", { providerId: qs("#learningProvider").value });
    updateActionAvailability();
  });
  qs("#learningProjects").addEventListener("change", (event) => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    updateFormPreference("learning", { projectIds: selectedProjectIds("#learningProjects") });
  });

  qs("#openSourceProject").addEventListener("change", async () => {
    updateFormPreference("openSource", { projectId: qs("#openSourceProject").value });
    await syncOpenSourceExistingResult();
    updateActionAvailability();
  });
  qs("#openSourceProvider").addEventListener("change", () => {
    updateFormPreference("openSource", { providerId: qs("#openSourceProvider").value });
    updateActionAvailability();
  });

  qs("#generalChatProvider").addEventListener("change", () => {
    updateFormPreference("generalChat", { providerId: qs("#generalChatProvider").value });
    updateActionAvailability();
  });

  qs("#voiceToggleBtn").addEventListener("click", () => {
    toggleVoiceRecognition();
  });

  getAnswerTextarea().addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    if (!state.currentInterview || state.interviewRequestPending) return;
    event.preventDefault();
    qs("#interviewReplyForm").requestSubmit();
  });

  qs("#savedProviderSelect").addEventListener("change", () => {
    const providerId = qs("#savedProviderSelect").value;
    const provider = (state.bootstrap.config.providers || []).find((item) => item.id === providerId);
    if (provider) {
      writeProviderToConfigForm(provider);
    }
  });

  qs("#newProviderBtn").addEventListener("click", () => {
    writeProviderToConfigForm(blankProvider({ provider_type: "demo" }));
  });

  qs("#setDefaultProviderBtn")?.addEventListener("click", async () => {
    const form = qs("#configForm");
    const currentId = form.provider_id.value;
    const providers = [...(state.bootstrap.config.providers || [])];
    if (!currentId || !providers.some((provider) => provider.id === currentId)) {
      throw new Error("\u8bf7\u5148\u9009\u62e9\u5df2\u4fdd\u5b58\u7684\u4f9b\u5e94\u5546\u914d\u7f6e");
    }
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        workspace_path: globalWorkspacePath(),
        default_provider_id: currentId,
        providers,
      }),
    });
    await refreshBootstrap();
    qs("#savedProviderSelect").value = currentId;
    qs("#defaultProviderSelect").value = currentId;
    showToast("\u5df2\u8bbe\u4e3a\u9ed8\u8ba4\u4f9b\u5e94\u5546");
  });

  qs("#deleteProviderBtn").addEventListener("click", async () => {
    const form = qs("#configForm");
    const currentId = form.provider_id.value;
    const providers = [...(state.bootstrap.config.providers || [])];
    if (!currentId || !providers.some((provider) => provider.id === currentId)) {
      writeProviderToConfigForm(blankProvider({ provider_type: "demo" }));
      showToast("当前是未保存配置草稿");
      return;
    }
    if (providers.length <= 1) {
      throw new Error("至少保留一个供应商配置，如需替换请直接编辑后保存。");
    }
    const nextProviders = providers.filter((provider) => provider.id !== currentId);
    const nextDefaultId =
      qs("#defaultProviderSelect").value === currentId ? nextProviders[0].id : qs("#defaultProviderSelect").value;
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        workspace_path: globalWorkspacePath(),
        default_provider_id: nextDefaultId,
        providers: nextProviders,
      }),
    });
    await refreshBootstrap();
    showToast("供应商配置已删除");
  });

  qs("#configForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const provider = {
      id: form.provider_id.value || newProviderId(),
      provider_label: form.provider_label.value.trim(),
      provider_type: form.provider_type.value,
      base_url: form.base_url.value.trim(),
      api_key: form.api_key.value.trim(),
      model_name: form.model_name.value.trim(),
      temperature: form.temperature.value.trim(),
      max_tokens: form.max_tokens.value.trim(),
      reasoning_effort: form.reasoning_effort.value,
      timeout_seconds: form.timeout_seconds.value.trim(),
      stream: false,
      anthropic_version: "2023-06-01",
    };
    const providers = [...(state.bootstrap.config.providers || [])];
    const index = providers.findIndex((item) => item.id === provider.id);
    if (index >= 0) {
      providers[index] = provider;
    } else {
      providers.push(provider);
    }
    const payload = {
      workspace_path: globalWorkspacePath(),
      default_provider_id: qs("#defaultProviderSelect").value || provider.id,
      providers,
    };
    setStatus("#configStatus", "正在保存配置...");
    setSubmitLoading("#configForm", true);
    try {
      await api("/api/config", { method: "POST", body: JSON.stringify(payload) });
      await refreshBootstrap();
      qs("#savedProviderSelect").value = provider.id;
      setStatus("#configStatus", "配置已保存。");
      showToast("供应商配置已保存");
    } catch (error) {
      setStatus("#configStatus", `保存失败：${error.message}`, true);
      throw error;
    } finally {
      setSubmitLoading("#configForm", false);
    }
  });

  qs("#testProviderBtn").addEventListener("click", async () => {
    const form = qs("#configForm");
    const provider = {
      id: form.provider_id.value || "",
      provider_label: form.provider_label.value.trim(),
      provider_type: form.provider_type.value,
      base_url: form.base_url.value.trim(),
      api_key: form.api_key.value.trim(),
      model_name: form.model_name.value.trim(),
      temperature: form.temperature.value.trim(),
      max_tokens: form.max_tokens.value.trim(),
      reasoning_effort: form.reasoning_effort.value,
      timeout_seconds: form.timeout_seconds.value.trim(),
      stream: false,
      anthropic_version: "2023-06-01",
    };
    setStatus("#configStatus", "正在测试模型连通...");
    qs("#testProviderBtn").disabled = true;
    try {
      const result = await api("/api/model/test", { method: "POST", body: JSON.stringify({ provider }) });
      setStatus("#configStatus", result.message || "连通测试成功。");
      showToast("连通测试成功");
    } catch (error) {
      setStatus("#configStatus", `连通失败：${error.message}`, true);
      showToast(`连通失败：${error.message}`, true);
    } finally {
      qs("#testProviderBtn").disabled = false;
    }
  });

  qs("#resumeUploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.file.files[0];
    if (!file) throw new Error("请选择 Markdown 简历文件");
    const content = await fileToText(file);
    await api("/api/assets/resumes", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.value.trim() || file.name.replace(/\.md$/i, ""),
        filename: file.name,
        content,
      }),
    });
    form.reset();
    await refreshBootstrap();
    showToast("简历已上传");
  });

  qs("#projectUploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const files = Array.from(form.files.files || []);
    if (!files.length) throw new Error("请选择项目目录");
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (files.length > 300 || totalSize > 40 * 1024 * 1024) {
      throw new Error("当前目录文件过多或体积过大，请改用“按本地路径导入”。");
    }
    const normalized = [];
    for (const file of files) {
      normalized.push({
        relative_path: file.webkitRelativePath || file.name,
        content_b64: await fileToBase64(file),
      });
    }
    await api("/api/assets/projects", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.value.trim() || (files[0].webkitRelativePath || files[0].name).split("/")[0],
        files: normalized,
      }),
    });
    form.reset();
    await refreshBootstrap();
    showToast("项目素材已上传");
  });

  qs("#projectPathImportForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const directoryPath = form.directory_path.value.trim();
    if (!directoryPath) throw new Error("请输入本地目录路径");
    await api("/api/assets/projects/import-path", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.value.trim(),
        directory_path: directoryPath,
      }),
    });
    form.reset();
    await refreshBootstrap();
    showToast("项目目录已按本地路径导入");
  });

  qs("#resumeAnalysisForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      resume_asset_id: qs("#resumeAnalysisResume").value,
      project_asset_ids: selectedProjectIds("#resumeAnalysisProjects"),
      provider_id: qs("#resumeAnalysisProvider").value,
    };
    setSubmitLoading("#resumeAnalysisForm", true);
    setStatus("#resumeAnalysisStatus", "正在读取简历和项目素材...");
    try {
      const run = await api("/api/run/resume-analysis", { method: "POST", body: JSON.stringify(payload) });
      setStatus("#resumeAnalysisStatus", "模型调用完成，正在加载结果文档...");
      const doc = await getDocument(run.path);
      state.resultDocs.resumeAnalysis = { path: doc.path, content: doc.content, mode: "preview" };
      renderDoc(qs("#resumeAnalysisResult"), state.resultDocs.resumeAnalysis);
      await refreshBootstrap();
      setStatus("#resumeAnalysisStatus", "简历分析完成。");
      showToast("简历分析已生成");
    } catch (error) {
      setStatus("#resumeAnalysisStatus", `执行失败：${error.message}`, true);
      throw error;
    } finally {
      setSubmitLoading("#resumeAnalysisForm", false);
    }
  });

  qs("#mockInterviewForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.interviewRequestPending) return;
    const payload = {
      resume_asset_id: qs("#mockInterviewResume").value,
      project_asset_ids: selectedProjectIds("#mockInterviewProjects"),
      analysis_run_id: qs("#mockInterviewAnalysis").value,
      provider_id: qs("#mockInterviewProvider").value,
    };
    setInterviewBusy(true);
    setStatus("#mockInterviewStatus", "正在阅读简历与项目资料...");
    try {
      setStatus("#mockInterviewStatus", "正在生成首轮问题...");
      state.currentInterview = null;
      setInterviewMessages([{ role: "assistant", content: "", pending: true }], { forceScroll: true });
      const result = await runInterviewStream("/api/interview/start-stream", payload);
      await syncInterviewAfterStream(result.interview, result.messages, "模拟面试已开始。");
      showToast("模拟面试已开始");
    } catch (error) {
      setInterviewMessages([], { forceScroll: true });
      setStatus("#mockInterviewStatus", `启动失败：${error.message}`, true);
    } finally {
      setInterviewBusy(false);
    }
  });

  qs("#interviewReplyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.interviewRequestPending) return;
    if (!state.currentInterview) throw new Error("请先启动模拟面试");
    const form = event.currentTarget;
    const answer = form.answer.value.trim();
    if (!answer) throw new Error("请输入回答");
    const previousMessages = state.interviewMessages.map((message) => ({ ...message }));
    setInterviewMessages(
      [
        ...previousMessages,
        { role: "user", content: answer },
        { role: "assistant", content: "", pending: true },
      ],
      { forceScroll: false }
    );
    form.reset();
    setInterviewBusy(true);
    setStatus("#mockInterviewStatus", "正在分析你的回答并生成下一轮问题...");
    try {
      const result = await runInterviewStream("/api/interview/reply-stream", {
        interview_id: state.currentInterview.id,
        answer,
      });
      await syncInterviewAfterStream(result.interview, result.messages, "已生成下一轮问题。");
    } catch (error) {
      form.answer.value = answer;
      setInterviewMessages(previousMessages);
      setStatus("#mockInterviewStatus", `发送失败：${error.message}`, true);
    } finally {
      setInterviewBusy(false);
    }
  });

  qs("#endInterviewBtn").addEventListener("click", async () => {
    if (state.interviewRequestPending) return;
    if (!state.currentInterview) throw new Error("当前没有进行中的面试");
    setInterviewBusy(true);
    setStatus("#mockInterviewStatus", "正在结束面试并生成评价...");
    try {
      const result = await api("/api/interview/end", {
        method: "POST",
        body: JSON.stringify({ interview_id: state.currentInterview.id, provider_id: state.currentInterview.provider_id || qs("#mockInterviewProvider").value }),
      });
      const doc = await getDocument(result.review_run.path);
      state.resultDocs.review = { path: doc.path, content: doc.content, mode: "preview" };
      renderDoc(qs("#reviewResult"), state.resultDocs.review);
      state.currentInterview = result.interview;
      refreshInterviewActionAvailability();
      await refreshBootstrap();
      setView("interview-review");
      setStatus("#mockInterviewStatus", "面试已结束，评价已生成。");
      showToast("面试已结束，评价已生成");
    } catch (error) {
      setStatus("#mockInterviewStatus", `结束失败：${error.message}`, true);
    } finally {
      setInterviewBusy(false);
    }
  });

  qs("#reviewForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const interviewId = qs("#reviewInterviewSelect").value;
    setSubmitLoading("#reviewForm", true);
    setStatus("#reviewStatus", "正在读取面试对话并生成评价...");
    try {
      const run = await api("/api/run/interview-review", {
        method: "POST",
        body: JSON.stringify({ interview_id: interviewId, provider_id: qs("#reviewProvider").value }),
      });
      const doc = await getDocument(run.path);
      state.resultDocs.review = { path: doc.path, content: doc.content, mode: "preview" };
      renderDoc(qs("#reviewResult"), state.resultDocs.review);
      await refreshBootstrap();
      setStatus("#reviewStatus", "面试评价生成完成。");
      showToast("面试评价已生成");
    } catch (error) {
      setStatus("#reviewStatus", `执行失败：${error.message}`, true);
      throw error;
    } finally {
      setSubmitLoading("#reviewForm", false);
    }
  });

  qs("#learningForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      review_run_id: qs("#learningReviewSelect").value,
      project_asset_ids: selectedProjectIds("#learningProjects"),
      provider_id: qs("#learningProvider").value,
    };
    setSubmitLoading("#learningForm", true);
    setStatus("#learningStatus", "正在读取评价并整理学习要点...");
    try {
      const run = await api("/api/run/learning", { method: "POST", body: JSON.stringify(payload) });
      const doc = await getDocument(run.path);
      state.resultDocs.learning = { path: doc.path, content: doc.content, mode: "preview" };
      renderManagedResultDoc("learning", "#learningResult", "#learningSaveBtn", "learningEditor", "#learningApplyCommentsBtn");
      await refreshBootstrap();
      setStatus("#learningStatus", "学习总结已生成。");
      showToast("学习总结已生成");
    } catch (error) {
      setStatus("#learningStatus", `执行失败：${error.message}`, true);
      throw error;
    } finally {
      setSubmitLoading("#learningForm", false);
    }
  });

  qs("#openSourceForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      project_asset_id: qs("#openSourceProject").value,
      template: form.template.value,
      provider_id: qs("#openSourceProvider").value,
    };
    setSubmitLoading("#openSourceForm", true);
    setStatus("#openSourceStatus", "正在扫描项目结构并抽取关键文件...");
    try {
      const run = await api("/api/run/open-source", { method: "POST", body: JSON.stringify(payload) });
      setStatus("#openSourceStatus", "模型生成中，正在组织模块化解读...");
      const doc = await getDocument(run.path);
      state.resultDocs.openSource = { path: doc.path, content: doc.content, mode: "preview" };
      renderDoc(qs("#openSourceResult"), state.resultDocs.openSource);
      await refreshBootstrap();
      setStatus("#openSourceStatus", "项目解读已生成。");
      showToast("项目解读已生成");
    } catch (error) {
      setStatus("#openSourceStatus", `执行失败：${error.message}`, true);
      throw error;
    } finally {
      setSubmitLoading("#openSourceForm", false);
    }
  });
  qs("#generalChatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = form.message.value.trim();
    if (!message) throw new Error("\u8bf7\u8f93\u5165\u5bf9\u8bdd\u5185\u5bb9");
    state.generalChatMessages.push({ role: "user", content: message });
    renderSimpleChat("#generalChatShell", state.generalChatMessages, "\u53d1\u9001\u6d88\u606f\u540e\uff0c\u5bf9\u8bdd\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002");
    form.message.value = "";
    setStatus("#generalChatStatus", "\u6b63\u5728\u751f\u6210\u56de\u590d...");
    setSubmitLoading("#generalChatForm", true);
    try {
      const result = await api("/api/chat/respond", {
        method: "POST",
        body: JSON.stringify({
          provider_id: qs("#generalChatProvider").value,
          run_id: state.generalChatRunId,
          messages: state.generalChatMessages,
          title: state.generalChatRunId ? "" : `\u666e\u901a\u5bf9\u8bdd ${new Date().toLocaleString()}`,
        }),
      });
      state.generalChatRunId = result.run?.id || state.generalChatRunId;
      state.generalChatMessages.push({ role: "assistant", content: result.reply });
      renderSimpleChat("#generalChatShell", state.generalChatMessages, "\u53d1\u9001\u6d88\u606f\u540e\uff0c\u5bf9\u8bdd\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002");
      setStatus("#generalChatStatus", "\u5df2\u56de\u590d\uff0c\u5bf9\u8bdd\u8bb0\u5f55\u5df2\u5199\u5165\u5386\u53f2\u3002");
      await refreshBootstrap();
    } catch (error) {
      state.generalChatMessages = state.generalChatMessages.slice(0, -1);
      renderSimpleChat("#generalChatShell", state.generalChatMessages, "\u53d1\u9001\u6d88\u606f\u540e\uff0c\u5bf9\u8bdd\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002");
      setStatus("#generalChatStatus", `\u56de\u590d\u5931\u8d25\uff1a${error.message}`, true);
      throw error;
    } finally {
      setSubmitLoading("#generalChatForm", false);
    }
  });

  qs("#generalChatClearBtn").addEventListener("click", () => {
    state.generalChatMessages = [];
    state.generalChatRunId = "";
    renderSimpleChat("#generalChatShell", state.generalChatMessages, "\u53d1\u9001\u6d88\u606f\u540e\uff0c\u5bf9\u8bdd\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002");
    setStatus("#generalChatStatus", "\u4f1a\u8bdd\u5df2\u6e05\u7a7a\u3002");
  });

  qs("#resumeCoachForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = form.message.value.trim();
    if (!message) throw new Error("请输入互动修改请求");
    const resumeAssetId = qs("#resumeAnalysisResume").value;
    if (!resumeAssetId) throw new Error("请先在简历分析模块选择简历");
    state.resumeCoachMessages.push({ role: "user", content: message });
    renderSimpleChat("#resumeCoachChat", state.resumeCoachMessages, "在这里和 AI 来回讨论简历修改方案。", "简历优化AI");
    form.message.value = "";
    setStatus("#resumeCoachStatus", "正在结合简历与分析结果生成修改建议...");
    setSubmitLoading("#resumeCoachForm", true);
    try {
      const result = await api("/api/resume/coach/respond", {
        method: "POST",
        body: JSON.stringify({
          provider_id: qs("#resumeAnalysisProvider").value,
          resume_asset_id: resumeAssetId,
          analysis_run_id: latestResumeAnalysisRunId(resumeAssetId),
          project_asset_ids: selectedProjectIds("#resumeAnalysisProjects"),
          messages: state.resumeCoachMessages,
        }),
      });
      state.resumeCoachMessages.push({ role: "assistant", content: result.reply });
      renderSimpleChat("#resumeCoachChat", state.resumeCoachMessages, "在这里和 AI 来回讨论简历修改方案。", "简历优化AI");
      setStatus("#resumeCoachStatus", "已生成本轮建议，可继续追问并迭代修改。");
      await refreshBootstrap();
    } catch (error) {
      state.resumeCoachMessages = state.resumeCoachMessages.slice(0, -1);
      renderSimpleChat("#resumeCoachChat", state.resumeCoachMessages, "在这里和 AI 来回讨论简历修改方案。", "简历优化AI");
      setStatus("#resumeCoachStatus", `互动失败：${error.message}`, true);
      throw error;
    } finally {
      setSubmitLoading("#resumeCoachForm", false);
    }
  });

  async function applyInlineComments(
    resultKey,
    containerSelector,
    saveBtnSelector,
    editorId,
    applyBtnSelector = "",
    statusSelector = "",
    onApplied = null
  ) {
    if (!state.resultDocs[resultKey].path) throw new Error("\u8bf7\u5148\u751f\u6210\u6216\u6253\u5f00\u4e00\u4efd\u6587\u6863");
    if (state.resultDocs[resultKey].mode !== "edit") throw new Error("\u8bf7\u5148\u8fdb\u5165\u6e90\u7801\u7f16\u8f91\u6a21\u5f0f\uff0c\u518d\u76f4\u63a5\u5199\u5165\u6279\u6ce8");
    const editor = qs(`#${editorId}`);
    if (!editor) throw new Error("\u672a\u627e\u5230\u7f16\u8f91\u5668");
    if (statusSelector) {
      setStatus(statusSelector, "正在根据你写在源码里的批注修改内容...");
    }
    try {
      await runButtonWithFeedback(applyBtnSelector, "修改中...", async () => {
        const result = await api("/api/document/apply-inline-comments", {
          method: "POST",
          body: JSON.stringify({ path: state.resultDocs[resultKey].path, content: editor.value }),
        });
        state.resultDocs[resultKey] = { path: result.path, content: result.content, mode: "preview" };
        if (resultKey === "history") {
          renderHistoryDoc();
        } else {
          renderManagedResultDoc(resultKey, containerSelector, saveBtnSelector, editorId, applyBtnSelector);
        }
        await refreshBootstrap();
      });
      if (typeof onApplied === "function") {
        onApplied();
      } else if (statusSelector) {
        setStatus(statusSelector, "已根据批注完成修改。");
      }
      showToast("\u5df2\u6839\u636e\u6e90\u7801\u4e2d\u7684\u6279\u6ce8\u66f4\u65b0\u6587\u6863");
    } catch (error) {
      if (statusSelector) {
        setStatus(statusSelector, `根据批注修改失败：${error.message}`, true);
      }
      showToast(`根据批注修改失败：${error.message}`, true);
    }
  }

  qs("#learningApplyCommentsBtn").addEventListener("click", async () => {
    await applyInlineComments(
      "learning",
      "#learningResult",
      "#learningSaveBtn",
      "learningEditor",
      "#learningApplyCommentsBtn",
      "#learningStatus",
      () => setStatus("#learningStatus", "\u5df2\u6839\u636e\u6e90\u7801\u91cc\u7684\u6279\u6ce8\u5b8c\u6210\u4fee\u6539\u3002"),
    );
  });

}

async function init() {
  bindEvents();
  setupSpeechRecognition();
  qs("#assetSearchInput").value = state.ui.preferences.assetSearch;
  qs("#historySearchInput").value = state.ui.preferences.historySearch;
  setView(resolveInitialView());
  renderEmpty(qs("#resumeAnalysisResult"), "生成简历分析后会显示在这里。");
  renderEmpty(qs("#reviewResult"), "生成评价后会显示在这里。");
  renderEmpty(qs("#learningResult"), "生成学习总结后会显示在这里。");
  renderEmpty(qs("#openSourceResult"), "生成项目解读后会显示在这里。");
  renderEmpty(qs("#historyDocument"), "从左侧文档列表打开内容。");
  qs("#learningSaveBtn").disabled = true;
  qs("#learningApplyCommentsBtn").disabled = true;
  renderInterviewChat([]);
  setInterviewBusy(false);
  interviewShell().addEventListener("scroll", syncInterviewScrollState);
  qs("#interviewScrollToBottomBtn").addEventListener("click", () => {
    state.interviewAutoScroll = true;
    scrollInterviewToBottom(true);
  });
  renderSimpleChat("#generalChatShell", state.generalChatMessages, "发送消息后，对话会显示在这里。");
  renderSimpleChat("#resumeCoachChat", state.resumeCoachMessages, "在这里和 AI 来回讨论简历修改方案。", "简历优化AI");

  try {
    await refreshBootstrap();
  } catch (error) {
    console.error(error);
    showToast(error.message, true);
  }
}

window.addEventListener("DOMContentLoaded", init);
window.addEventListener("error", (event) => {
  showToast(event.error?.message || event.message || "发生错误", true);
});
window.addEventListener("unhandledrejection", (event) => {
  showToast(event.reason?.message || "发生未处理异常", true);
});
