const state = {
  bootstrap: null,
  currentInterview: null,
  generalChatMessages: [],
  generalChatRunId: "",
  workspaceOverride: window.localStorage.getItem("workspaceOverride") || "",
  selectedHistoryEntryKeys: [],
  resumeCoachMessages: [],
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

function providerDisplayName(provider) {
  const label = provider.provider_label || "未命名供应商";
  const rawModelName = (provider.model_name || "").trim();
  const displayModelName = rawModelName.replace(/^gpt-/i, "GPT-");
  const modelSuffix = provider.reasoning_effort ? `-${provider.reasoning_effort}` : "";
  const model = displayModelName ? ` / ${displayModelName}${modelSuffix}` : "";
  const type = provider.provider_type ? ` [${provider.provider_type}]` : "";
  return `${label}${model}${type}`;
}

const viewTitles = {
  dashboard: "总览",
  config: "模型配置",
  assets: "素材库",
  "resume-analysis": "简历分析",
  "mock-interview": "模拟面试",
  "interview-review": "面试评价",
  learning: "学习总结",
  "open-source": "开源项目阅读",
  history: "历史记录",
};

function qs(selector) {
  return document.querySelector(selector);
}

function qsa(selector) {
  return Array.from(document.querySelectorAll(selector));
}

viewTitles["general-chat"] = "普通对话";

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

async function getDocument(path) {
  return api(`/api/document?path=${encodeURIComponent(path)}`);
}

function setView(viewKey) {
  qsa(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewKey);
  });
  qsa(".view").forEach((view) => {
    view.classList.toggle("active", view.dataset.view === viewKey);
  });
  qs("#viewTitle").textContent = viewTitles[viewKey] || "Interview-Assistant";
}

function renderEmpty(target, text) {
  target.innerHTML = `<div class="empty">${text}</div>`;
}

function renderDoc(target, docState) {
  if (!docState.content) {
    renderEmpty(target, "暂无内容");
    return;
  }
  if (docState.mode === "edit") {
    target.innerHTML = `<textarea id="historyEditor" class="history-editor"></textarea>`;
    qs("#historyEditor").value = docState.content;
    return;
  }
  if (docState.mode === "source") {
    target.innerHTML = `<div class="markdown-body"><pre><code>${escapeHtml(docState.content)}</code></pre></div>`;
    return;
  }
  target.innerHTML = markdownToHtml(docState.content);
}

function renderHistoryDoc() {
  renderDoc(qs("#historyDocument"), state.resultDocs.history);
  const saveBtn = qs("#historySaveBtn");
  saveBtn.disabled = state.resultDocs.history.mode !== "edit" || !state.resultDocs.history.path;
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

function formatDate(value) {
  return value ? value.replace("T", " ") : "-";
}

function moduleLabel(moduleKey) {
  const map = {
    resume_analysis: "简历分析",
    interview_review: "面试评价",
    learning: "学习总结",
    open_source_reading: "开源项目阅读",
  };
  map.general_chat = "普通对话";
  return map[moduleKey] || moduleKey;
}

function moduleLabel(moduleKey) {
  const map = {
    resume_analysis: "\u7b80\u5386\u5206\u6790",
    mock_interview: "\u6a21\u62df\u9762\u8bd5",
    interview_review: "\u9762\u8bd5\u8bc4\u4ef7",
    learning: "\u5b66\u4e60\u603b\u7ed3",
    open_source_reading: "\u5f00\u6e90\u9879\u76ee\u9605\u8bfb",
    general_chat: "\u666e\u901a\u5bf9\u8bdd",
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

function setBootstrap(bootstrap) {
  state.bootstrap = bootstrap;
  const validHistoryKeys = new Set([
    ...bootstrap.runs.map((run) => `run:${run.id}`),
    ...bootstrap.interviews.map((interview) => `interview:${interview.id}`),
  ]);
  state.selectedHistoryEntryKeys = state.selectedHistoryEntryKeys.filter((key) => validHistoryKeys.has(key));
  qs("#workspacePath").textContent = bootstrap.workspace_path || "-";
  qs("#activeDocument").textContent = bootstrap.active_document || "-";

  qs("#metricResumes").textContent = `${bootstrap.assets.resumes.length}`;
  qs("#metricProjects").textContent = `${bootstrap.assets.projects.length}`;
  qs("#metricRuns").textContent = `${bootstrap.runs.length}`;
  qs("#metricInterviews").textContent = `${bootstrap.interviews.length}`;

  renderDashboard();
  fillConfigForm();
  fillAssetLists();
  fillSelectors();
  renderHistoryList();
}

function renderDashboard() {
  const runsTarget = qs("#recentRuns");
  const interviewsTarget = qs("#recentInterviews");
  const runs = state.bootstrap.runs.slice(0, 5);
  const interviews = state.bootstrap.interviews.slice(0, 5);

  if (!runs.length) {
    renderEmpty(runsTarget, "\u8fd8\u6ca1\u6709\u7ed3\u679c\u6587\u6863\u3002");
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
    renderEmpty(interviewsTarget, "\u8fd8\u6ca1\u6709\u6a21\u62df\u9762\u8bd5\u8bb0\u5f55\u3002");
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
      const doc = await getDocument(interview.transcript_path);
      state.resultDocs.history = { path: doc.path, content: doc.content, mode: "preview" };
      renderHistoryDoc();
      qs("#activeDocument").textContent = doc.path;
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
  return `
    <article class="item-card">
      <div class="item-title">
        <strong>${asset.name}</strong>
        <span>${formatDate(asset.updated_at)}</span>
      </div>
      <p>${meta}</p>
      <p>${asset.path}</p>
      <label>
        <span>重命名</span>
        <input type="text" value="${asset.name}" data-rename-input="${kind}:${asset.id}" />
      </label>
      <div class="item-actions">
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

  resumeList.innerHTML = resumes.length ? resumes.map((asset) => assetCard(asset, "resume")).join("") : `<div class="empty">还没有简历素材。</div>`;
  projectList.innerHTML = projects.length ? projects.map((asset) => assetCard(asset, "project")).join("") : `<div class="empty">还没有项目素材。</div>`;

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

function fillSelectors() {
  const resumes = state.bootstrap.assets.resumes;
  const projects = state.bootstrap.assets.projects;
  const analysisRuns = state.bootstrap.runs.filter((run) => run.module_key === "resume_analysis");
  const reviewRuns = state.bootstrap.runs.filter((run) => run.module_key === "interview_review");
  const providers = state.bootstrap.config.providers || [];
  const defaultProviderId = state.bootstrap.config.default_provider_id || providers[0]?.id || "";
  const providerOptions = providers.length
    ? providers.map((provider) => `<option value="${provider.id}">${providerDisplayName(provider)}</option>`).join("")
    : `<option value="">暂无供应商配置</option>`;
  const currentProviderSelections = Object.fromEntries(
    ["#resumeAnalysisProvider", "#mockInterviewProvider", "#reviewProvider", "#learningProvider", "#openSourceProvider", "#generalChatProvider"].map((selector) => [
      selector,
      qs(selector)?.value || "",
    ])
  );

  const resumeOptions = resumes.length
    ? resumes.map((asset) => `<option value="${asset.id}">${asset.name}</option>`).join("")
    : `<option value="">暂无简历素材</option>`;

  ["#resumeAnalysisResume", "#mockInterviewResume"].forEach((selector) => {
    qs(selector).innerHTML = resumeOptions;
  });

  qs("#mockInterviewAnalysis").innerHTML = `<option value="">不引用</option>${analysisRuns
    .map((run) => `<option value="${run.id}">${PathBasename(run.path)}</option>`)
    .join("")}`;
  qs("#reviewInterviewSelect").innerHTML = state.bootstrap.interviews.length
    ? state.bootstrap.interviews.map((item) => `<option value="${item.id}">${item.title}</option>`).join("")
    : `<option value="">暂无面试记录</option>`;
  qs("#learningReviewSelect").innerHTML = reviewRuns.length
    ? reviewRuns.map((run) => `<option value="${run.id}">${PathBasename(run.path)}</option>`).join("")
    : `<option value="">暂无面试评价</option>`;
  qs("#openSourceProject").innerHTML = projects.length
    ? projects.map((project) => `<option value="${project.id}">${project.name}</option>`).join("")
    : `<option value="">暂无项目素材</option>`;

  ["#resumeAnalysisProvider", "#mockInterviewProvider", "#reviewProvider", "#learningProvider", "#openSourceProvider", "#generalChatProvider"].forEach((selector) => {
    qs(selector).innerHTML = providerOptions;
    const preferredId = currentProviderSelections[selector];
    const exists = providers.some((provider) => provider.id === preferredId);
    qs(selector).value = exists ? preferredId : defaultProviderId;
  });

  buildProjectChecks(qs("#resumeAnalysisProjects"), projects);
  buildProjectChecks(qs("#mockInterviewProjects"), projects);
  buildProjectChecks(qs("#learningProjects"), projects);
}

function PathBasename(path) {
  return path.split(/[\\/]/).pop();
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
    qs("#activeDocument").textContent = "-";
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
  const entries = historyEntries(filter);
  const target = qs("#historyList");
  const selectedEntryKeys = new Set(state.selectedHistoryEntryKeys);
  const filteredEntryKeys = entries.map((entry) => entry.key);
  const selectedFilteredCount = filteredEntryKeys.filter((key) => selectedEntryKeys.has(key)).length;
  const allFilteredSelected = filteredEntryKeys.length > 0 && selectedFilteredCount === filteredEntryKeys.length;
  if (!entries.length) {
    renderEmpty(target, "\u6682\u65e0\u6587\u6863\u3002");
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
  const doc = await getDocument(path);
  state.resultDocs.history = { path: doc.path, content: doc.content, mode: "preview" };
  renderHistoryDoc();
  qs("#activeDocument").textContent = doc.path;
}

async function refreshBootstrap() {
  const bootstrap = await api("/api/bootstrap");
  setBootstrap(bootstrap);
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

function renderInterviewChat(messages) {
  const shell = qs("#interviewChat");
  if (!messages || !messages.length) {
    renderEmpty(shell, "启动面试后，对话会显示在这里。");
    return;
  }
  shell.innerHTML = messages
    .map(
      (message) => `
        <article class="chat-message ${message.role}">
          <h4>${message.role === "assistant" ? "面试官" : "候选人"}</h4>
          ${markdownToHtml(message.content)}
        </article>
      `
    )
    .join("");
  shell.scrollTop = shell.scrollHeight;
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

async function loadInterviewMessages(interview) {
  const doc = await getDocument(interview.transcript_path);
  state.resultDocs.history = { path: doc.path, content: doc.content, mode: "preview" };
  qs("#activeDocument").textContent = doc.path;
}

function setVoiceStatus(message) {
  qs("#voiceStatus").textContent = message;
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

function setupSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setVoiceStatus("当前浏览器不支持原生语音识别，推荐使用最新版 Edge / Chrome。");
    qs("#startVoiceBtn").disabled = true;
    qs("#stopVoiceBtn").disabled = true;
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.continuous = true;
  recognition.interimResults = true;
  state.speech.recognition = recognition;
  state.speech.supported = true;
  setVoiceStatus("点击“开始语音转文字”后，对着麦克风说话，识别结果会自动写入回答框。");

  recognition.onstart = () => {
    state.speech.listening = true;
    state.speech.finalText = "";
    state.speech.baseText = getAnswerTextarea().value;
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
    setVoiceStatus(`语音识别失败：${event.error || "未知错误"}`);
  };

  recognition.onend = () => {
    state.speech.listening = false;
    setVoiceStatus("语音识别已停止。可以继续手动编辑文字，或再次开始录音。");
  };
}

function bindEvents() {
  qsa(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  qs("#refreshBtn").addEventListener("click", async () => {
    await refreshBootstrap();
    showToast("数据已刷新");
  });

  qs("#historyModuleFilter").addEventListener("change", renderHistoryList);
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
  wireModeButtons("#learningPreviewBtn", "#learningSourceBtn", "learning", "#learningResult");
  wireModeButtons("#openSourcePreviewBtn", "#openSourceSourceBtn", "openSource", "#openSourceResult");
  wireModeButtons("#historyPreviewBtn", "#historySourceBtn", "history", "#historyDocument");
  qs("#historyEditBtn").addEventListener("click", () => {
    if (!state.resultDocs.history.path) throw new Error("请先打开一份文档");
    state.resultDocs.history.mode = "edit";
    renderHistoryDoc();
  });
  qs("#historySaveBtn").addEventListener("click", async () => {
    if (!state.resultDocs.history.path) throw new Error("请先打开一份文档");
    if (state.resultDocs.history.mode !== "edit") throw new Error("请先进入编辑源码模式");
    const editor = qs("#historyEditor");
    if (!editor) throw new Error("未找到编辑器");
    const result = await api("/api/document", {
      method: "POST",
      body: JSON.stringify({ path: state.resultDocs.history.path, content: editor.value }),
    });
    state.resultDocs.history = { path: result.path, content: result.content, mode: "source" };
    renderHistoryDoc();
    await refreshBootstrap();
    showToast("文档源码已保存");
  });

  qs("#startVoiceBtn").addEventListener("click", () => {
    if (!state.speech.supported || !state.speech.recognition) throw new Error("当前浏览器不支持语音识别");
    if (state.speech.listening) return;
    state.speech.baseText = getAnswerTextarea().value;
    state.speech.finalText = "";
    state.speech.recognition.start();
  });
  qs("#stopVoiceBtn").addEventListener("click", () => {
    if (!state.speech.supported || !state.speech.recognition) return;
    if (!state.speech.listening) return;
    state.speech.recognition.stop();
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
    const payload = {
      resume_asset_id: qs("#mockInterviewResume").value,
      project_asset_ids: selectedProjectIds("#mockInterviewProjects"),
      analysis_run_id: qs("#mockInterviewAnalysis").value,
      provider_id: qs("#mockInterviewProvider").value,
    };
    setSubmitLoading("#mockInterviewForm", true);
    setStatus("#mockInterviewStatus", "正在阅读简历与项目资料...");
    try {
      const result = await api("/api/interview/start", { method: "POST", body: JSON.stringify(payload) });
      setStatus("#mockInterviewStatus", "正在生成首轮问题...");
      state.currentInterview = result.interview;
      renderInterviewChat(result.messages);
      await loadInterviewMessages(result.interview);
      await refreshBootstrap();
      setStatus("#mockInterviewStatus", "模拟面试已开始。");
      showToast("模拟面试已开始");
    } catch (error) {
      setStatus("#mockInterviewStatus", `启动失败：${error.message}`, true);
      throw error;
    } finally {
      setSubmitLoading("#mockInterviewForm", false);
    }
  });

  qs("#interviewReplyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.currentInterview) throw new Error("请先启动模拟面试");
    const form = event.currentTarget;
    const answer = form.answer.value.trim();
    if (!answer) throw new Error("请输入回答");
    setStatus("#mockInterviewStatus", "正在分析你的回答并生成下一轮问题...");
    const result = await api("/api/interview/reply", {
      method: "POST",
      body: JSON.stringify({ interview_id: state.currentInterview.id, answer }),
    });
    state.currentInterview = result.interview;
    renderInterviewChat(result.messages);
    form.reset();
    await loadInterviewMessages(result.interview);
    await refreshBootstrap();
    setStatus("#mockInterviewStatus", "已生成下一轮问题。");
  });

  qs("#endInterviewBtn").addEventListener("click", async () => {
    if (!state.currentInterview) throw new Error("当前没有进行中的面试");
    setStatus("#mockInterviewStatus", "正在结束面试并生成评价...");
    const result = await api("/api/interview/end", {
      method: "POST",
      body: JSON.stringify({ interview_id: state.currentInterview.id, provider_id: state.currentInterview.provider_id || qs("#mockInterviewProvider").value }),
    });
    const doc = await getDocument(result.review_run.path);
    state.resultDocs.review = { path: doc.path, content: doc.content, mode: "preview" };
    renderDoc(qs("#reviewResult"), state.resultDocs.review);
    state.currentInterview = result.interview;
    await refreshBootstrap();
    setView("interview-review");
    setStatus("#mockInterviewStatus", "面试已结束，评价已生成。");
    showToast("面试已结束，评价已生成");
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
      renderDoc(qs("#learningResult"), state.resultDocs.learning);
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

  qs("#commentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!state.resultDocs.history.path) throw new Error("请先打开一份文档");
    const comment = form.comment.value.trim();
    if (!comment) throw new Error("请输入批注");
    const result = await api("/api/comment", {
      method: "POST",
      body: JSON.stringify({ path: state.resultDocs.history.path, comment }),
    });
    state.resultDocs.history = { path: result.path, content: result.content, mode: "preview" };
    renderHistoryDoc();
    form.reset();
    await refreshBootstrap();
    showToast("批注回复已追加到文档");
  });
}

async function init() {
  bindEvents();
  setupSpeechRecognition();
  renderEmpty(qs("#resumeAnalysisResult"), "生成简历分析后会显示在这里。");
  renderEmpty(qs("#reviewResult"), "生成评价后会显示在这里。");
  renderEmpty(qs("#learningResult"), "生成学习总结后会显示在这里。");
  renderEmpty(qs("#openSourceResult"), "生成项目解读后会显示在这里。");
  renderEmpty(qs("#historyDocument"), "从左侧文档列表打开内容。");
  qs("#historySaveBtn").disabled = true;
  renderInterviewChat([]);
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
