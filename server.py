import base64
import json
import os
import re
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional, Tuple


APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "web"
SKILLS_ROOT = APP_ROOT / "skills"
CONFIG_FILE = APP_ROOT / "app_config.json"

DEFAULT_WORKSPACE = APP_ROOT / "workspace"
MODULE_DIRECTORIES = {
    "resume_analysis": "简历分析",
    "mock_interview": "模拟面试",
    "interview_review": "面试评价",
    "learning": "学习总结",
    "open_source_reading": "开源项目阅读",
    "general_chat": "普通对话",
}
SKILL_PATHS = {
    "resume_analysis": SKILLS_ROOT / "简历分析助手" / "SKILL.md",
    "mock_interview": SKILLS_ROOT / "面试助手" / "SKILL.md",
    "interview_review": SKILLS_ROOT / "面试评价助手" / "SKILL.md",
    "learning": SKILLS_ROOT / "面试总结学习助手" / "SKILL.md",
    "open_source_reading": SKILLS_ROOT / "开源项目阅读助手" / "SKILL.md",
}
TEXT_EXTENSIONS = {
    ".md",
    ".txt",
    ".py",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".env",
    ".sh",
    ".bat",
    ".ps1",
    ".java",
    ".go",
    ".rs",
    ".cpp",
    ".c",
    ".h",
    ".hpp",
    ".cs",
    ".rb",
    ".php",
    ".sql",
    ".html",
    ".css",
    ".scss",
    ".vue",
    ".xml",
    ".proto",
    ".ipynb",
}
IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    ".next",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "target",
    "bin",
    "obj",
}
STATE_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def iso_label() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


INTERVIEW_TITLE_RE = re.compile(r"^(?P<date>\d{4}-\d{2}-\d{2})\s+\u6a21\u62df\u9762\u8bd5(?:-(?P<index>\d+))?$")
RUN_TITLE_LABELS = {
    "interview_review": "\u9762\u8bd5\u8bc4\u4ef7",
    "learning": "\u5b66\u4e60\u603b\u7ed3",
}


def extract_iso_date(value: str) -> str:
    match = re.search(r"(\d{4}-\d{2}-\d{2})", (value or "").strip())
    return match.group(1) if match else ""


def interview_series_date(interview: Dict) -> str:
    for key in ("created_at", "updated_at"):
        date_text = extract_iso_date(interview.get(key, ""))
        if date_text:
            return date_text
    title_match = INTERVIEW_TITLE_RE.match((interview.get("title") or "").strip())
    if title_match:
        return title_match.group("date")
    return today_str()


def interview_series_base_title(date_text: str) -> str:
    return f"{date_text} \u6a21\u62df\u9762\u8bd5"


def normalize_interview_titles(interviews: List[Dict]) -> bool:
    grouped: Dict[str, List[Dict]] = {}
    for interview in interviews or []:
        grouped.setdefault(interview_series_date(interview), []).append(interview)
    changed = False
    for date_text, items in grouped.items():
        base_title = interview_series_base_title(date_text)
        items.sort(key=lambda item: (item.get("created_at") or item.get("updated_at") or "", item.get("id") or ""))
        if len(items) == 1:
            desired_titles = [base_title]
        else:
            desired_titles = [f"{base_title}-{index}" for index in range(1, len(items) + 1)]
        for interview, desired_title in zip(items, desired_titles):
            if interview.get("title") != desired_title:
                interview["title"] = desired_title
                changed = True
    return changed


def run_series_date(run: Dict, interviews_by_id: Dict[str, Dict]) -> str:
    source = run.get("source") or {}
    interview_id = source.get("interview_id") or ""
    interview = interviews_by_id.get(interview_id)
    if interview:
        return interview_series_date(interview)
    for value in (
        run.get("created_at", ""),
        run.get("updated_at", ""),
        run.get("title", ""),
        run.get("path", ""),
    ):
        date_text = extract_iso_date(value)
        if date_text:
            return date_text
    return today_str()


def normalize_run_titles(state: Dict) -> bool:
    interviews_by_id = {item.get("id", ""): item for item in state.get("interviews", [])}
    grouped: Dict[Tuple[str, str], List[Dict]] = {}
    for run in state.get("runs", []):
        module_key = run.get("module_key") or ""
        if module_key not in RUN_TITLE_LABELS:
            continue
        grouped.setdefault((module_key, run_series_date(run, interviews_by_id)), []).append(run)
    changed = False
    for (module_key, date_text), items in grouped.items():
        base_title = f"{date_text} {RUN_TITLE_LABELS[module_key]}"
        items.sort(key=lambda item: (item.get("created_at") or item.get("updated_at") or "", item.get("id") or ""))
        if len(items) == 1:
            desired_titles = [base_title]
        else:
            desired_titles = [f"{base_title}-{index}" for index in range(1, len(items) + 1)]
        for run, desired_title in zip(items, desired_titles):
            if run.get("title") != desired_title:
                run["title"] = desired_title
                changed = True
    return changed


def interview_transcript_runtime_config(interview: Dict) -> Dict:
    return {
        "model": {
            "provider_label": interview.get("provider_label", ""),
            "model_name": interview.get("model_name", ""),
        }
    }


def refresh_interview_transcripts_for_title_changes(state: Dict, previous_titles: Dict[str, str]) -> None:
    for interview in state.get("interviews", []):
        if previous_titles.get(interview.get("id", "")) == interview.get("title"):
            continue
        data = load_interview_data(interview)
        if not data:
            continue
        persist_markdown(
            Path(interview["transcript_path"]),
            interview_transcript_markdown(interview, data, interview_transcript_runtime_config(interview)),
        )


def sanitize_name(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\\\|?*]+', "-", name or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or "未命名"


def slug_fragment(name: str) -> str:
    cleaned = sanitize_name(name)
    cleaned = cleaned.replace(" ", "-")
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    return cleaned[:48]


def json_load(path: Path, default):
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def json_dump(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)


def default_config() -> Dict:
    return {
        "workspace_path": str(DEFAULT_WORKSPACE),
        "default_provider_id": "demo-default",
        "providers": [
            {
                "id": "demo-default",
                "provider_label": "Demo",
                "provider_type": "demo",
                "base_url": "https://api.openai.com",
                "api_key": "",
                "model_name": "demo-local",
                "temperature": None,
                "max_tokens": None,
                "reasoning_effort": "",
                "timeout_seconds": None,
                "stream": False,
                "anthropic_version": "2023-06-01",
            }
        ],
    }


def normalize_optional_number(value, cast=float):
    if value in ("", None):
        return None
    return cast(value)


def normalize_provider(provider: Dict, fallback_id: str) -> Dict:
    return {
        "id": provider.get("id") or fallback_id,
        "provider_label": provider.get("provider_label", ""),
        "provider_type": provider.get("provider_type") or "demo",
        "base_url": provider.get("base_url", ""),
        "api_key": provider.get("api_key", ""),
        "model_name": provider.get("model_name", ""),
        "temperature": normalize_optional_number(provider.get("temperature"), float),
        "max_tokens": normalize_optional_number(provider.get("max_tokens"), int),
        "reasoning_effort": provider.get("reasoning_effort", "") or "",
        "timeout_seconds": normalize_optional_number(provider.get("timeout_seconds"), int),
        "stream": bool(provider.get("stream", False)),
        "anthropic_version": provider.get("anthropic_version", "2023-06-01"),
    }


def resolve_provider(config: Dict, provider_id: Optional[str] = None) -> Dict:
    providers = config.get("providers") or []
    target_id = provider_id or config.get("default_provider_id")
    for provider in providers:
        if provider.get("id") == target_id:
            return provider
    if providers:
        return providers[0]
    return default_config()["providers"][0]


def runtime_config_with_provider(config: Dict, provider_id: Optional[str] = None) -> Dict:
    runtime = dict(config)
    runtime["model"] = resolve_provider(config, provider_id)
    return runtime


def ensure_runtime_timeout(runtime_config: Dict, minimum_timeout: int) -> Dict:
    runtime = dict(runtime_config)
    model_cfg = dict(runtime.get("model") or {})
    current_timeout = int(model_cfg.get("timeout_seconds") or 0)
    if current_timeout < minimum_timeout:
        model_cfg["timeout_seconds"] = minimum_timeout
    runtime["model"] = model_cfg
    return runtime


def load_config() -> Dict:
    config = json_load(CONFIG_FILE, default_config())
    if "workspace_path" not in config:
        config["workspace_path"] = str(DEFAULT_WORKSPACE)
    if "providers" not in config:
        legacy_model = config.get("model") or default_config()["providers"][0]
        config["providers"] = [normalize_provider(legacy_model, "provider-1")]
        config["default_provider_id"] = config["providers"][0]["id"]
    else:
        normalized = []
        for index, provider in enumerate(config.get("providers") or []):
            normalized.append(normalize_provider(provider, provider.get("id") or f"provider-{index + 1}"))
        config["providers"] = normalized or default_config()["providers"]
        if not config.get("default_provider_id"):
            config["default_provider_id"] = config["providers"][0]["id"]
    config["model"] = resolve_provider(config)
    return config


def save_config(config: Dict) -> None:
    normalized = load_config()
    normalized["workspace_path"] = (config.get("workspace_path") or "").strip()
    raw_providers = config.get("providers") or []
    providers = []
    for index, provider in enumerate(raw_providers):
        providers.append(normalize_provider(provider, provider.get("id") or f"provider-{index + 1}"))
    if not providers:
        providers = default_config()["providers"]
    normalized["providers"] = providers
    default_provider_id = config.get("default_provider_id") or providers[0]["id"]
    if not any(provider["id"] == default_provider_id for provider in providers):
        default_provider_id = providers[0]["id"]
    normalized["default_provider_id"] = default_provider_id
    normalized["model"] = resolve_provider(normalized)
    json_dump(
        CONFIG_FILE,
        {
            "workspace_path": normalized["workspace_path"],
            "default_provider_id": normalized["default_provider_id"],
            "providers": normalized["providers"],
        },
    )


def workspace_path_from(config: Optional[Dict] = None, override_path: Optional[str] = None) -> Path:
    cfg = config or load_config()
    target = (override_path or "").strip() or cfg.get("workspace_path") or DEFAULT_WORKSPACE
    return Path(target).resolve()


def ensure_workspace(config: Optional[Dict] = None, override_path: Optional[str] = None) -> Path:
    cfg = config or load_config()
    workspace = workspace_path_from(cfg, override_path)
    required_dirs = [
        workspace / "assets" / "resumes",
        workspace / "assets" / "projects",
        workspace / "system",
        workspace / "system" / "interviews",
    ]
    for folder in MODULE_DIRECTORIES.values():
        required_dirs.append(workspace / folder)
    for path in required_dirs:
        path.mkdir(parents=True, exist_ok=True)
    state_path = workspace / "system" / "state.json"
    if not state_path.exists():
        json_dump(
            state_path,
            {
                "version": 1,
                "resumes": [],
                "projects": [],
                "runs": [],
                "interviews": [],
                "active_document": "",
            },
        )
    return workspace


def load_state(workspace: Path) -> Dict:
    ensure_workspace({"workspace_path": str(workspace)})
    return json_load(
        workspace / "system" / "state.json",
        {
            "version": 1,
            "resumes": [],
            "projects": [],
            "runs": [],
            "interviews": [],
            "active_document": "",
        },
    )


def save_state(workspace: Path, state: Dict) -> None:
    json_dump(workspace / "system" / "state.json", state)


def with_state(mutator, workspace_override: Optional[str] = None):
    with STATE_LOCK:
        config = load_config()
        workspace = ensure_workspace(config, workspace_override)
        state = load_state(workspace)
        previous_titles = {item.get("id", ""): item.get("title", "") for item in state.get("interviews", [])}
        if normalize_interview_titles(state.get("interviews", [])):
            refresh_interview_transcripts_for_title_changes(state, previous_titles)
        normalize_run_titles(state)
        result = mutator(workspace, state, config)
        previous_titles = {item.get("id", ""): item.get("title", "") for item in state.get("interviews", [])}
        if normalize_interview_titles(state.get("interviews", [])):
            refresh_interview_transcripts_for_title_changes(state, previous_titles)
        normalize_run_titles(state)
        save_state(workspace, state)
    return result


def read_skill(module_key: str) -> str:
    path = SKILL_PATHS[module_key]
    if not path.exists():
        raise FileNotFoundError(f"Skill 文件不存在: {path}")
    return path.read_text(encoding="utf-8")


def safe_rel_path(relative_path: str) -> Path:
    parts = [part for part in Path(relative_path).parts if part not in ("", ".", "..")]
    return Path(*parts)


def is_path_within(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def count_files(root: Path) -> int:
    total = 0
    for _, _, files in iter_project_walk(root):
        total += len(files)
    return total


def iter_project_walk(root: Path):
    for current_root, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in IGNORED_DIRS]
        yield Path(current_root), dirnames, filenames


def next_module_markdown_path(workspace: Path, module_key: str, base_name: Optional[str] = None) -> Path:
    folder = workspace / MODULE_DIRECTORIES[module_key]
    folder.mkdir(parents=True, exist_ok=True)
    if module_key == "open_source_reading" and base_name:
        preferred = sanitize_name(base_name)
        candidate = folder / f"{preferred}.md"
        if not candidate.exists():
            return candidate
    name = base_name or MODULE_DIRECTORIES[module_key]
    name = sanitize_name(name)
    stem = f"{today_str()}-{name}"
    candidate = folder / f"{stem}.md"
    if not candidate.exists():
        return candidate
    counter = 1
    while True:
        candidate = folder / f"{stem}-{counter}.md"
        if not candidate.exists():
            return candidate
        counter += 1


def normalize_run_item(run: Dict) -> Dict:
    normalized = dict(run)
    normalized["path"] = str(Path(run["path"]))
    return normalized


def normalize_asset(asset: Dict) -> Dict:
    normalized = dict(asset)
    normalized["path"] = str(Path(asset["path"]))
    return normalized


def normalize_interview(interview: Dict) -> Dict:
    normalized = dict(interview)
    normalized["transcript_path"] = str(Path(interview["transcript_path"]))
    normalized["json_path"] = str(Path(interview["json_path"]))
    return normalized


def list_text_files(root: Path) -> List[Path]:
    results = []
    for current_root, _, filenames in iter_project_walk(root):
        for filename in filenames:
            path = current_root / filename
            if path.suffix.lower() in TEXT_EXTENSIONS and path.stat().st_size <= 200_000:
                results.append(path)
    return results


def read_text_file(path: Path, limit: int = 6000) -> str:
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_text(encoding="utf-8", errors="ignore")
    if len(content) > limit:
        return content[:limit] + "\n...[截断]..."
    return content


def project_tree(root: Path, max_entries: int = 120) -> str:
    lines = []
    entries = []
    for current_root, dirnames, filenames in iter_project_walk(root):
        current = Path(current_root)
        entries.extend(current / dirname for dirname in dirnames)
        entries.extend(current / filename for filename in filenames)
    entries = sorted(entries, key=lambda item: (item.is_file(), str(item).lower()))
    for entry in entries[:max_entries]:
        rel = entry.relative_to(root)
        prefix = "DIR " if entry.is_dir() else "FILE"
        lines.append(f"{prefix} {rel}")
    if len(entries) > max_entries:
        lines.append("... [目录已截断]")
    return "\n".join(lines)


def rank_project_files(files: List[Path]) -> List[Path]:
    def score(path: Path) -> Tuple[int, int, str]:
        name = path.name.lower()
        rel = str(path).lower()
        priority = 5
        if name == "readme.md":
            priority = 0
        elif name.startswith(("main", "app", "server", "index")):
            priority = 1
        elif "agent" in rel or "rag" in rel or "api" in rel:
            priority = 2
        elif path.suffix.lower() in {".py", ".ts", ".tsx", ".js", ".md"}:
            priority = 3
        return (priority, len(rel), rel)

    return sorted(files, key=score)


def build_project_snapshot(asset: Dict, max_files: int = 18, chars_per_file: int = 5000) -> str:
    root = Path(asset["path"])
    files = rank_project_files(list_text_files(root))
    lines = [
        f"项目名称：{asset['name']}",
        f"项目路径：{root}",
        "目录结构：",
        "```text",
        project_tree(root),
        "```",
    ]
    if not files:
        lines.append("未发现可读取的文本源码文件。")
        return "\n".join(lines)
    lines.append("关键文件摘录：")
    for path in files[:max_files]:
        rel = path.relative_to(root)
        lines.append(f"\n### 文件：{rel}")
        lines.append("```")
        lines.append(read_text_file(path, chars_per_file))
        lines.append("```")
    if len(files) > max_files:
        lines.append(f"\n其余 {len(files) - max_files} 个文本文件未展开。")
    return "\n".join(lines)


def resume_text_from_asset(asset: Dict) -> str:
    return Path(asset["path"]).read_text(encoding="utf-8")


def markdown_meta(module_title: str, config: Dict, extra_lines: Optional[List[str]] = None) -> str:
    model_name = config.get("model", {}).get("model_name", "unknown")
    provider = config.get("model", {}).get("provider_label", "unknown")
    lines = [
        f"# {module_title}",
        "",
        f"生成时间：{iso_label()}",
        f"模型供应商：{provider}",
        f"模型名称：{model_name}",
    ]
    if extra_lines:
        lines.extend(extra_lines)
    lines.append("")
    return "\n".join(lines)


def demo_resume_analysis(resume: Dict, projects: List[Dict], config: Dict) -> str:
    resume_content = resume_text_from_asset(resume)
    excerpt = resume_content[:800] + ("..." if len(resume_content) > 800 else "")
    project_names = "、".join(project["name"] for project in projects) if projects else "未提供项目"
    lines = [
        markdown_meta("简历分析", config, [f"简历素材：{resume['name']}", f"项目素材：{project_names}"]),
        "## 岗位匹配概览",
        "该候选人当前更适合投递大模型应用开发 / Agent 工程化的初级到中级岗位，是否能冲击更高层级，取决于项目细节、工程指标和上线约束的表达完整度。",
        "",
        "## 简历亮点",
        "- 简历中已经包含与 LLM / Agent 相关的关键词，方向匹配度较高。",
        "- 如果项目中包含 RAG、评测、工具调用、工作流编排等内容，会显著提升说服力。",
        "- 使用 Markdown 作为输入，后续可以继续沉淀为可复用面试素材。",
        "",
        "## 主要风险",
        "- 项目描述如果只停留在“做了什么”，缺少“为什么这么做、指标如何、参数如何选”，在面试深挖时容易失分。",
        "- 如果没有明确的线上约束、成本控制、评测口径和失败案例，候选人的工程可信度会被打折。",
        "",
        "## 修改建议",
        "1. 每段项目经历补齐“问题背景 -> 技术方案 -> 关键参数 -> 指标结果 -> 个人贡献”。",
        "2. 为每个项目准备一份 1 分钟版本和 3 分钟版本介绍。",
        "3. 明确写出使用过的模型、框架、向量库、评测指标和优化策略。",
        "",
        "## 上下文摘要",
        f"后续模拟面试建议重点围绕以下素材展开：{project_names}。",
        "",
        "## 简历片段参考",
        "```markdown",
        excerpt,
        "```",
    ]
    return "\n".join(lines)


def demo_interview_opening(resume: Dict, projects: List[Dict], turn: int = 1) -> str:
    project_names = "、".join(project["name"] for project in projects) if projects else "你的核心项目"
    if turn == 1:
        return (
            "我们开始模拟面试。先做一个简短自我介绍，然后展开项目追问。\n\n"
            "1. 请你用 1 分钟介绍自己，重点说你为什么适合大模型应用开发岗位。\n"
            f"2. 在 {project_names} 里，你最想重点讲哪一个项目？为什么？\n"
            "3. 这个项目里最有技术含量的一处设计是什么？"
        )
    if turn == 2:
        return (
            "继续往深处追问：\n\n"
            "1. 你刚才提到的核心链路里，模型、检索、重排、缓存分别怎么选型？\n"
            "2. 你如何评估效果，至少说出一个离线指标和一个线上约束。\n"
            "3. 如果流量扩大 10 倍，你准备先优化哪两个点？"
        )
    return (
        "最后一轮追问：\n\n"
        "1. 说一个你项目里真实踩过的坑，以及你如何定位和修复。\n"
        "2. 如果面试官质疑你的项目细节不够可信，你会拿什么证据证明自己真的做过？\n"
        "3. 回到岗位本身，你觉得自己现在距离 offer 还差哪一块？"
    )


def demo_interview_opening_v2(resume: Dict, projects: List[Dict], turn: int = 1, focus_project_id: str = "") -> str:
    focus_project = resolve_focus_project(projects, focus_project_id)
    focus_project_name = focus_project["name"] if focus_project else "你的核心项目"
    if turn == 1:
        return (
            "我们开始模拟面试，先做一个简短自我介绍，然后只围绕一个项目展开追问。\n\n"
            "1. 请你用 1 分钟介绍自己，重点说你为什么适合大模型应用开发岗位。\n"
            f"2. 先聚焦项目《{focus_project_name}》，请你讲清楚这个项目的背景、目标和你的个人职责。\n"
            f"3. 在《{focus_project_name}》里，你认为最有技术含量的一处设计是什么？为什么这样做？"
        )
    if turn == 2:
        return (
            f"继续围绕《{focus_project_name}》深挖：\n\n"
            f"1. 在《{focus_project_name}》的核心链路里，模型、检索、重排和缓存分别是怎么选型的？\n"
            f"2. 你如何评估《{focus_project_name}》的效果，至少说出一个离线指标和一个线上约束。\n"
            f"3. 如果《{focus_project_name}》的流量扩大 10 倍，你会优先优化哪两个点？"
        )
    return (
        f"最后继续追问《{focus_project_name}》：\n\n"
        f"1. 说一个你在《{focus_project_name}》里真实踩过的坑，以及你如何定位和修复。\n"
        f"2. 如果面试官质疑你对《{focus_project_name}》的细节不够可信，你会拿什么证据证明自己真的做过？\n"
        f"3. 复盘《{focus_project_name}》，如果再做一次，你最想重构或补强的部分是什么？"
    )


def demo_interview_round_v3(resume: Dict, project: Optional[Dict], round_index: int = 1) -> str:
    return normalize_interview_questions("", project)


def demo_interview_evaluation(interview: Dict, config: Dict) -> str:
    lines = [
        markdown_meta("面试评价", config, [f"关联面试：{interview['title']}"]),
        "## 面试概况",
        "本次面试按照“自我介绍 -> 项目深挖 -> 指标与工程细节 -> 风险与复盘”的顺序进行。候选人整体表达流畅，但在可验证的实现细节和量化指标上仍需加强。",
        "",
        "## 亮点",
        "- 能够围绕岗位方向组织回答，整体方向感正确。",
        "- 对 LLM / Agent 应用开发常见模块有一定概念储备。",
        "- 有继续复盘和学习的意愿，适合通过针对性训练快速补齐短板。",
        "",
        "## 主要不足",
        "- 项目细节还不够可追问，参数、依赖库、关键方法和评测口径需要更具体。",
        "- 工程化表达不足，成本、延迟、稳定性、失败兜底等内容讲得不够。",
        "- 面向招聘场景的说服力不足，个人贡献和结果证明还可以更强。",
        "",
        "## 综合结论",
        "当前水平更接近初级到中级之间。如果把项目讲述整理成“背景、方案、参数、指标、坑点、结果”六段式，竞争力会明显提升。",
        "",
        "## 改进建议",
        "1. 为每个项目准备参数卡片和指标卡片。",
        "2. 把所有“我做了什么”改写成“我解决了什么问题，怎么验证有效”。",
        "3. 针对常见追问做专项练习，例如 chunk 切分、rerank、工具调用失败兜底、Agent 状态管理。",
    ]
    return "\n".join(lines)


def demo_learning(evaluation_text: str, config: Dict) -> str:
    lines = [
        markdown_meta("学习总结", config),
        "## 不足1：项目细节不可追问",
        "- 更好的回答：先说目标，再说技术方案，接着说关键参数、指标与上线限制。",
        "- 需要学习的知识点：RAG 切分策略、embedding / rerank 组合、Agent 工具调用链路。",
        "- 下一步练习：给自己任意一个项目补一张“参数与指标卡片”。",
        "",
        "## 不足2：工程化表达不足",
        "- 更好的回答：补充成本、延迟、稳定性、缓存和失败兜底。",
        "- 需要学习的知识点：性能压测、监控埋点、降本与限流策略。",
        "- 下一步练习：写出一个真实的线上指标看板草图。",
        "",
        "## 评价摘要",
        "```markdown",
        evaluation_text[:1200] + ("..." if len(evaluation_text) > 1200 else ""),
        "```",
    ]
    return "\n".join(lines)


def demo_open_source(project: Dict, template: str, config: Dict) -> str:
    snapshot = build_project_snapshot(project, max_files=6, chars_per_file=2500)
    lines = [
        markdown_meta("项目解读", config, [f"项目素材：{project['name']}"]),
        "## 模块拆解建议",
        "先看入口、配置、核心服务、数据流，再看评测和部署脚本。真实阅读时建议优先确认请求从哪里进入、状态在哪里流转、结果如何落盘或返回。",
        "",
        "## 模块1：入口与初始化",
        "通常需要确认主程序如何装配模型、向量库、工具或 Web 服务。重点看 `main/app/server/index` 一类入口文件和配置读取逻辑。",
        "",
        "## 模块2：核心能力实现",
        "重点查看与 LLM / Agent 直接相关的模块，例如检索、编排、工具调用、任务调度、状态管理和评测。",
        "",
        "## 模块3：工程化与运维",
        "需要关注日志、缓存、异常处理、配置管理和部署脚本，判断项目是否具备真实可运行性。",
        "",
        "## 本次项目快照",
        snapshot,
    ]
    if template.strip():
        lines.extend(["", "## 用户模板", "```markdown", template.strip(), "```"])
    return "\n".join(lines)


def demo_comment_reply(comment: str, document_text: str, config: Dict) -> str:
    excerpt = document_text[:600] + ("..." if len(document_text) > 600 else "")
    lines = [
        markdown_meta("批注回复", config),
        f"## 批注内容\n{comment}",
        "",
        "## 回复",
        "这条批注已经基于当前文档上下文继续处理。建议你重点关注文档里现有结论对应的输入、证据链和下一步执行动作，不要只看摘要。",
        "",
        "## 当前文档参考片段",
        "```markdown",
        excerpt,
        "```",
    ]
    return "\n".join(lines)


INLINE_COMMENT_RE = re.compile(r"(批注[:：]|TODO[:：]|NOTE[:：]|<!--\s*批注[:：]?|【批注】)", flags=re.IGNORECASE)


def has_inline_comment_markers(text: str) -> bool:
    return bool(INLINE_COMMENT_RE.search(text or ""))


def strip_inline_comment_markers(text: str) -> str:
    normalized = (text or "").replace("\r\n", "\n")
    normalized = re.sub(r"<!--\s*批注[:：]?\s*.*?-->", "", normalized, flags=re.IGNORECASE)
    lines = []
    for line in normalized.split("\n"):
        if INLINE_COMMENT_RE.search(line):
            continue
        lines.append(line)
    cleaned = "\n".join(lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def demo_inline_comment_apply(original_text: str, annotated_text: str, config: Dict) -> str:
    cleaned = strip_inline_comment_markers(annotated_text)
    return (cleaned or original_text or "").strip() + "\n"


def demo_general_chat_reply(last_user_text: str, config: Dict) -> str:
    return (
        "收到。下面是我基于你这条输入给的直接建议：\n\n"
        f"- 你的问题：{(last_user_text or '').strip()[:180]}\n"
        "- 建议先明确目标、输入约束、成功标准，再决定实现路径。\n"
        "- 如果你愿意，我可以继续把这个问题拆成可执行步骤。"
    )


def demo_resume_coach_reply(resume_text: str, user_request: str, config: Dict) -> str:
    excerpt = resume_text[:500] + ("..." if len(resume_text) > 500 else "")
    return (
        "已进入简历互动优化模式。先给你一版可直接改写的建议：\n\n"
        "## 修改思路\n"
        "- 用“背景 -> 动作 -> 结果”三段式重写每段项目经历。\n"
        "- 增加可量化指标，例如延迟、召回、成本、稳定性。\n"
        "- 强化个人贡献，避免“参与了”这类弱表达。\n\n"
        "## 你当前追问\n"
        f"{user_request}\n\n"
        "## 可参考的简历片段\n"
        "```markdown\n"
        f"{excerpt}\n"
        "```"
    )


def chat_completion_from_messages(provider_cfg: Dict, system_prompt: str, messages: List[Dict]) -> str:
    provider_type = provider_cfg.get("provider_type", "demo")
    if provider_type == "demo":
        last_user = ""
        for message in reversed(messages):
            if message.get("role") == "user":
                last_user = message.get("content", "")
                break
        return demo_general_chat_reply(last_user, {"model": provider_cfg})
    if provider_type == "anthropic":
        base_url = provider_cfg.get("base_url", "https://api.anthropic.com").rstrip("/")
        endpoint = base_url if base_url.endswith("/v1/messages") else f"{base_url}/v1/messages"
        payload = {
            "model": provider_cfg.get("model_name"),
            "system": system_prompt,
            "messages": [{"role": msg.get("role"), "content": msg.get("content", "")} for msg in messages if msg.get("role") in {"user", "assistant"}],
            "max_tokens": provider_cfg.get("max_tokens") if provider_cfg.get("max_tokens") is not None else 3200,
        }
        if provider_cfg.get("temperature") is not None:
            payload["temperature"] = provider_cfg.get("temperature")
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-api-key": provider_cfg.get("api_key", ""),
                "anthropic-version": provider_cfg.get("anthropic_version", "2023-06-01"),
            },
            method="POST",
        )
        timeout = int(provider_cfg.get("timeout_seconds") or 90)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
        blocks = data.get("content") or []
        text = "".join(block.get("text", "") for block in blocks if isinstance(block, dict) and block.get("type") == "text").strip()
        if not text:
            raise RuntimeError("Anthropic 对话返回为空")
        return text
    base_url = provider_cfg.get("base_url", "https://api.openai.com").rstrip("/")
    endpoint = base_url
    if not endpoint.endswith("/chat/completions"):
        if endpoint.endswith("/v1"):
            endpoint = f"{endpoint}/chat/completions"
        else:
            endpoint = f"{endpoint}/v1/chat/completions"
    payload = {
        "model": provider_cfg.get("model_name"),
        "messages": [{"role": "system", "content": system_prompt}] + [{"role": msg.get("role"), "content": msg.get("content", "")} for msg in messages if msg.get("role") in {"user", "assistant"}],
    }
    if provider_cfg.get("temperature") is not None:
        payload["temperature"] = provider_cfg.get("temperature")
    if provider_cfg.get("max_tokens") is not None:
        payload["max_tokens"] = provider_cfg.get("max_tokens")
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {provider_cfg.get('api_key', '')}",
        },
        method="POST",
    )
    timeout = int(provider_cfg.get("timeout_seconds") or 90)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"OpenAI 调用失败，HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OpenAI 调用失败，网络错误: {exc}") from exc
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("对话模型没有返回 choices")
    content = (choices[0].get("message") or {}).get("content")
    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
    if not content:
        raise RuntimeError("对话模型返回为空")
    return content


def build_system_prompt(module_key: str, skill_text: str, config: Dict) -> str:
    reasoning = config.get("model", {}).get("reasoning_effort") or "未指定"
    return (
        f"{skill_text}\n\n"
        "你正在Interview-Assistant本地产品内执行任务。"
        "请严格基于提供的素材和上下文输出 Markdown，避免编造不存在的事实。"
        f"当前建议推理强度：{reasoning}。"
    )


def openai_chat_completion(model_cfg: Dict, system_prompt: str, user_prompt: str) -> str:
    base_url = model_cfg.get("base_url", "https://api.openai.com").rstrip("/")
    endpoint = base_url
    if not endpoint.endswith("/chat/completions"):
        if endpoint.endswith("/v1"):
            endpoint = f"{endpoint}/chat/completions"
        else:
            endpoint = f"{endpoint}/v1/chat/completions"
    payload = {
        "model": model_cfg.get("model_name"),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    if model_cfg.get("temperature") is not None:
        payload["temperature"] = model_cfg.get("temperature")
    if model_cfg.get("max_tokens") is not None:
        payload["max_tokens"] = model_cfg.get("max_tokens")
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {model_cfg.get('api_key', '')}",
        },
        method="POST",
    )
    timeout = int(model_cfg.get("timeout_seconds") or 90)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"OpenAI 调用失败，HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OpenAI 调用失败，网络错误: {exc}") from exc
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError("模型没有返回 choices")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, list):
        text_parts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                text_parts.append(part.get("text", ""))
        content = "".join(text_parts)
    if not content:
        raise RuntimeError("模型返回为空")
    return content


def anthropic_completion(model_cfg: Dict, system_prompt: str, user_prompt: str) -> str:
    base_url = model_cfg.get("base_url", "https://api.anthropic.com").rstrip("/")
    endpoint = base_url if base_url.endswith("/v1/messages") else f"{base_url}/v1/messages"
    payload = {
        "model": model_cfg.get("model_name"),
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }
    if model_cfg.get("max_tokens") is not None:
        payload["max_tokens"] = model_cfg.get("max_tokens")
    else:
        payload["max_tokens"] = 3200
    if model_cfg.get("temperature") is not None:
        payload["temperature"] = model_cfg.get("temperature")
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-api-key": model_cfg.get("api_key", ""),
            "anthropic-version": model_cfg.get("anthropic_version", "2023-06-01"),
        },
        method="POST",
    )
    timeout = int(model_cfg.get("timeout_seconds") or 90)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    content = data.get("content") or []
    texts = [block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text"]
    joined = "".join(texts).strip()
    if not joined:
        raise RuntimeError("Anthropic 返回为空")
    return joined


def call_model(module_key: str, user_prompt: str, config: Dict, demo_builder, demo_args: Tuple, skill_text: Optional[str] = None) -> str:
    model_cfg = config.get("model", {})
    provider_type = model_cfg.get("provider_type", "demo")
    if provider_type == "demo":
        return demo_builder(*demo_args)
    skill_body = skill_text or read_skill(module_key)
    system_prompt = build_system_prompt(module_key, skill_body, config)
    try:
        if provider_type == "anthropic":
            return anthropic_completion(model_cfg, system_prompt, user_prompt)
        return openai_chat_completion(model_cfg, system_prompt, user_prompt)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"模型调用失败，HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"模型调用失败，网络错误: {exc}") from exc


def test_model_connection(provider_cfg: Dict) -> Dict:
    provider_type = provider_cfg.get("provider_type", "demo")
    if provider_type == "demo":
        return {"ok": True, "message": "Demo 模式无需真实连通，测试通过。"}
    runtime_cfg = {"model": provider_cfg}
    probe_prompt = "请只回复 OK"
    try:
        if provider_type == "anthropic":
            text = anthropic_completion(provider_cfg, "你是连通性测试助手。", probe_prompt)
        else:
            text = openai_chat_completion(provider_cfg, "你是连通性测试助手。", probe_prompt)
        excerpt = (text or "").strip().replace("\n", " ")
        if len(excerpt) > 60:
            excerpt = excerpt[:60] + "..."
        return {"ok": True, "message": f"连通成功，模型返回：{excerpt or '空文本'}", "provider": provider_cfg.get("provider_label", "")}
    except Exception as exc:
        return {"ok": False, "message": str(exc), "provider": provider_cfg.get("provider_label", "")}


def append_run(state: Dict, run: Dict) -> None:
    state["runs"].append(run)
    state["active_document"] = run["path"]


def persist_markdown(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def create_run(
    workspace: Path,
    state: Dict,
    config: Dict,
    module_key: str,
    title: str,
    content: str,
    source: Dict,
    preferred_name: Optional[str] = None,
) -> Dict:
    markdown_path = next_module_markdown_path(workspace, module_key, preferred_name or title)
    persist_markdown(markdown_path, content)
    model_cfg = config.get("model", {})
    run = {
        "id": uuid.uuid4().hex,
        "module_key": module_key,
        "module_name": MODULE_DIRECTORIES[module_key],
        "title": title,
        "path": str(markdown_path),
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "source": {
            **source,
            "provider_id": model_cfg.get("id", ""),
            "provider_label": model_cfg.get("provider_label", ""),
            "model_name": model_cfg.get("model_name", ""),
        },
    }
    append_run(state, run)
    return run


def update_run_content(state: Dict, run_id: str, content: str, title: Optional[str] = None) -> Dict:
    for run in state["runs"]:
        if run["id"] != run_id:
            continue
        path = Path(run["path"])
        persist_markdown(path, content)
        if title:
            run["title"] = title
        run["updated_at"] = now_iso()
        state["active_document"] = str(path)
        return run
    raise KeyError(f"Run not found: {run_id}")


def find_asset(state: Dict, kind: str, asset_id: str) -> Dict:
    collection = state["resumes"] if kind == "resume" else state["projects"]
    for asset in collection:
        if asset["id"] == asset_id:
            return asset
    raise KeyError(f"未找到素材: {asset_id}")


def project_assets_from_ids(state: Dict, ids: List[str]) -> List[Dict]:
    return [find_asset(state, "project", project_id) for project_id in ids]


def project_context_from_ids(state: Dict, ids: List[str], max_files: int = 18) -> str:
    projects = project_assets_from_ids(state, ids)
    if not projects:
        return "未提供项目素材。"
    return "\n\n".join(build_project_snapshot(project, max_files=max_files) for project in projects)


def normalize_project_id_list(ids: Optional[List[str]]) -> List[str]:
    if not ids:
        return []
    return [str(project_id) for project_id in ids if project_id]


def project_scope_matches(selected_ids: Optional[List[str]], source_ids: Optional[List[str]]) -> bool:
    selected = set(normalize_project_id_list(selected_ids))
    source = set(normalize_project_id_list(source_ids))
    return source.issubset(selected)


def save_resume_asset(workspace: Path, state: Dict, payload: Dict) -> Dict:
    name = sanitize_name(payload.get("name") or payload.get("filename") or "简历")
    filename = sanitize_name(payload.get("filename") or f"{name}.md")
    replace_id = payload.get("replace_asset_id")
    if not filename.lower().endswith(".md"):
        filename += ".md"
    content = payload.get("content", "")
    if not content.strip():
        raise ValueError("简历内容不能为空")
    existing = None
    if replace_id:
        existing = find_asset(state, "resume", replace_id)
    asset_id = existing["id"] if existing else uuid.uuid4().hex
    path = workspace / "assets" / "resumes" / f"{asset_id}-{slug_fragment(filename)}"
    persist_markdown(path, content)
    asset = {
        "id": asset_id,
        "name": name,
        "filename": filename,
        "path": str(path),
        "updated_at": now_iso(),
        "size": len(content.encode("utf-8")),
    }
    if existing:
        for index, current in enumerate(state["resumes"]):
            if current["id"] == replace_id:
                state["resumes"][index] = asset
                break
    else:
        state["resumes"].append(asset)
    return asset


def save_project_asset(workspace: Path, state: Dict, payload: Dict) -> Dict:
    files = payload.get("files") or []
    if not files:
        raise ValueError("项目目录不能为空")
    name = sanitize_name(payload.get("name") or "项目")
    replace_id = payload.get("replace_asset_id")
    existing = None
    if replace_id:
        existing = find_asset(state, "project", replace_id)
    asset_id = existing["id"] if existing else uuid.uuid4().hex
    root = workspace / "assets" / "projects" / f"{asset_id}-{slug_fragment(name)}"
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    file_count = 0
    for item in files:
        relative_path = safe_rel_path(item.get("relative_path", ""))
        if not relative_path.parts:
            continue
        target = root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        data = base64.b64decode(item.get("content_b64", "").encode("utf-8"))
        target.write_bytes(data)
        file_count += 1
    asset = {
        "id": asset_id,
        "name": name,
        "path": str(root),
        "updated_at": now_iso(),
        "file_count": file_count,
        "storage_mode": "workspace_copy",
    }
    if existing:
        for index, current in enumerate(state["projects"]):
            if current["id"] == replace_id:
                state["projects"][index] = asset
                break
    else:
        state["projects"].append(asset)
    return asset


def register_project_asset_from_path(workspace: Path, state: Dict, payload: Dict) -> Dict:
    raw_path = (payload.get("directory_path") or "").strip()
    if not raw_path:
        raise ValueError("目录路径不能为空")
    root = Path(raw_path).expanduser().resolve()
    if not root.exists():
        raise FileNotFoundError(f"目录不存在: {root}")
    if not root.is_dir():
        raise ValueError(f"路径不是目录: {root}")
    replace_id = payload.get("replace_asset_id")
    existing = None
    if replace_id:
        existing = find_asset(state, "project", replace_id)
    asset_id = existing["id"] if existing else uuid.uuid4().hex
    asset = {
        "id": asset_id,
        "name": sanitize_name(payload.get("name") or root.name),
        "path": str(root),
        "updated_at": now_iso(),
        "file_count": count_files(root),
        "storage_mode": "reference",
    }
    if existing:
        for index, current in enumerate(state["projects"]):
            if current["id"] == replace_id:
                state["projects"][index] = asset
                break
    else:
        state["projects"].append(asset)
    return asset


def rename_asset(state: Dict, kind: str, asset_id: str, new_name: str) -> Dict:
    asset = find_asset(state, kind, asset_id)
    asset["name"] = sanitize_name(new_name)
    asset["updated_at"] = now_iso()
    if kind == "resume" and asset["name"] and not asset.get("filename"):
        asset["filename"] = f"{asset['name']}.md"
    return asset


def delete_asset(workspace: Path, state: Dict, kind: str, asset_id: str) -> None:
    collection_key = "resumes" if kind == "resume" else "projects"
    collection = state[collection_key]
    for index, asset in enumerate(collection):
        if asset["id"] != asset_id:
            continue
        path = Path(asset["path"])
        storage_mode = asset.get("storage_mode", "workspace_copy")
        if storage_mode != "reference" and path.exists() and is_path_within(path, workspace / "assets"):
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
        del collection[index]
        return
    raise KeyError(f"未找到素材: {asset_id}")


def delete_run(workspace: Path, state: Dict, run_id: str) -> None:
    for index, run in enumerate(state["runs"]):
        if run["id"] != run_id:
            continue
        path = Path(run["path"])
        if path.exists() and is_path_within(path, workspace):
            path.unlink()
        del state["runs"][index]

        # 清空 active_document 如果它指向被删除的文档
        if state.get("active_document") == str(path):
            state["active_document"] = ""
        return
    raise KeyError(f"未找到文档记录: {run_id}")


def find_interview(state: Dict, interview_id: str) -> Dict:
    for interview in state["interviews"]:
        if interview["id"] == interview_id:
            return interview
    raise KeyError(f"未找到面试记录: {interview_id}")


def delete_interview(workspace: Path, state: Dict, interview_id: str) -> None:
    for index, interview in enumerate(state["interviews"]):
        if interview["id"] != interview_id:
            continue
        transcript_path = Path(interview["transcript_path"])
        json_path = Path(interview["json_path"])
        if transcript_path.exists() and is_path_within(transcript_path, workspace):
            transcript_path.unlink()
        if json_path.exists() and is_path_within(json_path, workspace):
            json_path.unlink()
        del state["interviews"][index]
        if state.get("active_document") == str(transcript_path):
            state["active_document"] = ""
        return
    raise KeyError(f"Interview not found: {interview_id}")


def load_interview_data(interview: Dict) -> Dict:
    return json_load(Path(interview["json_path"]), {})


def save_interview_data(interview: Dict, data: Dict) -> None:
    json_dump(Path(interview["json_path"]), data)


def find_project_by_id(projects: List[Dict], project_id: str) -> Optional[Dict]:
    for project in projects:
        if project.get("id") == project_id:
            return project
    return None


def detect_focus_project_id(projects: List[Dict], text: str) -> str:
    if not text:
        return ""
    matched_ids = []
    for project in projects:
        name = (project.get("name") or "").strip()
        if not name:
            continue
        if re.search(re.escape(name), text, flags=re.IGNORECASE):
            matched_ids.append(project["id"])
    if len(matched_ids) == 1:
        return matched_ids[0]
    return ""


def resolve_focus_project(projects: List[Dict], focus_project_id: str = "") -> Optional[Dict]:
    if focus_project_id:
        project = find_project_by_id(projects, focus_project_id)
        if project:
            return project
    return projects[0] if projects else None


def pick_next_project(projects: List[Dict], asked_project_ids: Optional[List[str]], fallback_project_id: str = "") -> Optional[Dict]:
    asked = {project_id for project_id in (asked_project_ids or []) if project_id}
    for project in projects:
        if project.get("id") not in asked:
            return project
    return resolve_focus_project(projects, fallback_project_id)


RESUME_TOPIC_SECTION_KEYWORDS = ("项目经历", "项目经验", "工作经历", "工作经验", "实习经历")
MARKDOWN_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


def normalize_lookup_key(text: str) -> str:
    return re.sub(r"[\W_]+", "", (text or "").strip().lower())


def clean_resume_topic_title(title: str) -> str:
    cleaned = re.sub(r"^\d+[\.\-、:：]\s*", "", (title or "").strip())
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def markdown_headings(markdown_text: str) -> Tuple[List[str], List[Dict]]:
    lines = markdown_text.splitlines()
    headings = []
    for index, line in enumerate(lines):
        match = MARKDOWN_HEADING_RE.match(line.strip())
        if not match:
            continue
        headings.append(
            {
                "level": len(match.group(1)),
                "title": clean_resume_topic_title(match.group(2)),
                "line": index,
            }
        )
    return lines, headings


def match_resume_topic_to_project_asset(topic_name: str, projects: List[Dict]) -> Optional[Dict]:
    topic_key = normalize_lookup_key(topic_name)
    if not topic_key:
        return None
    best_match = None
    best_score = 0
    for project in projects:
        project_name = (project.get("name") or "").strip()
        project_key = normalize_lookup_key(project_name)
        if not project_key:
            continue
        score = 0
        if topic_key == project_key:
            score = 3
        elif topic_key in project_key or project_key in topic_key:
            score = 2
        elif any(part and normalize_lookup_key(part) in project_key for part in re.split(r"[\s/|,，:：()（）\-]+", topic_name)):
            score = 1
        if score > best_score:
            best_match = project
            best_score = score
    return best_match


def extract_resume_focus_topics(resume: Dict, projects: List[Dict]) -> List[Dict]:
    resume_markdown = resume_text_from_asset(resume)
    lines, headings = markdown_headings(resume_markdown)
    topics = []
    for index, heading in enumerate(headings):
        normalized_title = heading["title"].replace(" ", "")
        if not any(keyword in normalized_title for keyword in RESUME_TOPIC_SECTION_KEYWORDS):
            continue
        section_end = len(lines)
        for later in headings[index + 1:]:
            if later["level"] <= heading["level"]:
                section_end = later["line"]
                break
        child_headings = [
            later
            for later in headings[index + 1:]
            if heading["line"] < later["line"] < section_end and later["level"] > heading["level"]
        ]
        if not child_headings:
            continue
        child_level = min(item["level"] for item in child_headings)
        direct_children = [item for item in child_headings if item["level"] == child_level]
        for topic_index, child in enumerate(direct_children):
            child_end = section_end
            for later in direct_children[topic_index + 1:]:
                if later["line"] > child["line"]:
                    child_end = later["line"]
                    break
            topic_content = "\n".join(lines[child["line"]:child_end]).strip()
            matched_project = match_resume_topic_to_project_asset(child["title"], projects)
            topics.append(
                {
                    "id": f"resume-topic-{len(topics) + 1}",
                    "name": child["title"],
                    "section_type": heading["title"],
                    "content": topic_content,
                    "matched_project_id": matched_project.get("id", "") if matched_project else "",
                    "matched_project_name": matched_project.get("name", "") if matched_project else "",
                }
            )
    if topics:
        return topics
    for index, project in enumerate(projects):
        topics.append(
            {
                "id": f"project-topic-{index + 1}",
                "name": project.get("name", f"项目{index + 1}"),
                "section_type": "项目资料",
                "content": "",
                "matched_project_id": project.get("id", ""),
                "matched_project_name": project.get("name", ""),
            }
        )
    return topics


def find_resume_topic_by_id(topics: List[Dict], topic_id: str) -> Optional[Dict]:
    for topic in topics or []:
        if topic.get("id") == topic_id:
            return topic
    return None


def pick_next_resume_topic(topics: List[Dict], asked_topic_ids: Optional[List[str]], fallback_topic_id: str = "") -> Optional[Dict]:
    asked = {topic_id for topic_id in (asked_topic_ids or []) if topic_id}
    for topic in topics or []:
        if topic.get("id") not in asked:
            return topic
    return find_resume_topic_by_id(topics, fallback_topic_id) or (topics[0] if topics else None)


def matched_project_for_topic(topic: Optional[Dict], projects: List[Dict]) -> Optional[Dict]:
    if not topic:
        return None
    matched_project_id = (topic.get("matched_project_id") or "").strip()
    return find_project_by_id(projects, matched_project_id) if matched_project_id else None


def build_resume_topic_sequence(topics: List[Dict]) -> str:
    if not topics:
        return "(none)"
    return "\n".join(
        f"{index}. {topic.get('name', '')}（来自 {topic.get('section_type', '简历')}）"
        for index, topic in enumerate(topics, start=1)
    )


def resume_topic_snapshot_or_placeholder(topic: Optional[Dict]) -> str:
    if not topic:
        return "未提供当前简历项目/工作经历片段。"
    content = (topic.get("content") or "").strip()
    if len(content) > 2500:
        content = content[:2500].rstrip() + "\n...[截断]..."
    lines = [
        f"主题名称：{topic.get('name', '')}",
        f"来源章节：{topic.get('section_type', '简历')}",
    ]
    if content:
        lines.extend(["```markdown", content, "```"])
    else:
        lines.append("简历中未提取到更详细的原文片段。")
    return "\n".join(lines)


def build_intro_fallback_questions() -> List[str]:
    return [
        "请先做一个简短的自我介绍，并重点讲一下你最近这段经历和目标岗位的匹配点。",
        "你最近在找什么方向的岗位？为什么会重点看大模型应用开发相关机会？",
        "除了项目本身之外，你觉得自己在技术、工程习惯或沟通协作上，最值得面试官优先了解的点是什么？",
    ]


def user_requests_continue_current_topic(text: str) -> bool:
    normalized = (text or "").strip().lower()
    if not normalized:
        return False
    keywords = [
        "继续问这个项目",
        "继续聊这个项目",
        "先别换项目",
        "继续深挖这个项目",
        "继续问当前项目",
        "接着问这个项目",
        "不要切下一个项目",
        "continue this project",
        "stay on this project",
    ]
    return any(keyword in normalized for keyword in keywords)


def build_interview_phase_note(phase: str, topic: Optional[Dict], is_new_topic: bool, asked_topic_ids: Optional[List[str]] = None) -> str:
    if phase == "intro":
        return "我们先做个开场，我先了解一下你的基本情况。"
    if not topic:
        return ""
    topic_name = topic.get("name", "当前项目")
    section_type = topic.get("section_type", "")
    topic_label = f"你的「{topic_name}」这段经历" if any(keyword in section_type for keyword in ("工作", "实习")) else f"你的「{topic_name}」"
    if is_new_topic:
        if asked_topic_ids:
            return f"接下来我们聊一聊{topic_label}。"
        return f"接下来我会针对{topic_label}进行提问。"
    return ""


def project_snapshot_or_placeholder(project: Optional[Dict], max_files: int = 10) -> str:
    if not project:
        return "未提供项目资料。"
    return build_project_snapshot(project, max_files=max_files)


def clean_question_text(text: str) -> str:
    cleaned = (text or "").strip()
    cleaned = cleaned.replace("\r", " ").replace("\n", " ")
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = cleaned.replace("**", "").replace("`", "")
    cleaned = re.sub(r"^[>\-*•\s]+", "", cleaned)
    cleaned = re.sub(r"^\d+\.\s*", "", cleaned)
    cleaned = cleaned.strip(" \t-:：")
    return cleaned


def question_mentions_project(question: str, project_name: str) -> bool:
    return bool(project_name and re.search(re.escape(project_name), question, flags=re.IGNORECASE))


def strip_redundant_project_leadin(question: str, project_name: str = "") -> str:
    cleaned = (question or "").strip()
    patterns = [
        r"^(?:在|针对|关于|围绕)\s*[《「“\"]?(?:你的核心项目|当前项目|这个项目|该项目)[》」”\"]?\s*(?:里|中)?\s*[，,：: ]*",
        r"^(?:先|我们先)?\s*(?:围绕|针对|关于)\s*[《「“\"]?(?:你的核心项目|当前项目|这个项目|该项目)[》」”\"]?\s*[，,：: ]*",
    ]
    if project_name:
        escaped_name = re.escape(project_name)
        patterns = [
            rf"^(?:在|针对|关于|围绕)\s*[《「“\"]?{escaped_name}[》」”\"]?\s*(?:里|中)?\s*[，,：: ]*",
            rf"^(?:在|针对|关于|围绕)\s*项目\s*[《「“\"]?{escaped_name}[》」”\"]?\s*(?:里|中)?\s*[，,：: ]*",
        ] + patterns
    for pattern in patterns:
        cleaned = re.sub(pattern, "", cleaned, count=1, flags=re.IGNORECASE)
    return cleaned.strip()


def extract_question_candidates(text: str) -> List[str]:
    normalized = (text or "").replace("\r\n", "\n").strip()
    if not normalized:
        return []
    pattern = re.compile(
        r"(?:^|\n)\s*(?:\d+|[一二三四五六七八九十]+|[①②③④⑤⑥⑦⑧⑨⑩])[\.、:：)\]]?\s*(.+?)(?=(?:\n\s*(?:\d+|[一二三四五六七八九十]+|[①②③④⑤⑥⑦⑧⑨⑩])[\.、:：)\]]?\s)|\Z)",
        flags=re.S,
    )
    blocks = [clean_question_text(match) for match in pattern.findall(normalized)]
    blocks = [block for block in blocks if block]
    if blocks:
        return blocks
    fallback = []
    for piece in re.split(r"[？?]\s*", normalized):
        candidate = clean_question_text(piece)
        if candidate:
            fallback.append(candidate)
    return fallback


def build_fallback_project_questions(project: Optional[Dict]) -> List[str]:
    section_type = (project or {}).get("section_type", "")
    if any(keyword in section_type for keyword in ("工作", "实习")):
        return [
            "先整体讲一下这段经历：你当时负责的业务、模块或角色重点是什么？",
            "这段经历里你主导或深度参与过的关键技术方案是什么？请讲清具体实现、设计取舍，以及你的实际贡献。",
            "最后你怎么衡量这段经历的结果或价值？能结合业务指标、交付结果，或者一次真实的问题排查与优化案例来讲吗？",
        ]
    return [
        "先整体讲一下这个项目：你负责的核心模块是什么，它主要解决了什么业务问题？",
        "这个项目里你做过的关键技术方案是什么？请讲清具体实现、为什么这样设计，以及做过哪些权衡。",
        "最后你是怎么验证这个项目效果、稳定性或线上表现的？能结合指标、结果，或一次真实的排查优化案例来讲吗？",
    ]


def normalize_interview_questions(raw_text: str, project: Optional[Dict], other_project_names: Optional[List[str]] = None, phase: str = "project") -> str:
    project_name = (project or {}).get("name", "")
    blocked_project_names = [name for name in (other_project_names or []) if name]
    candidates = extract_question_candidates(raw_text)
    normalized_questions = []
    seen = set()
    for question in candidates:
        if any(question_mentions_project(question, name) for name in blocked_project_names):
            continue
        normalized = strip_redundant_project_leadin(clean_question_text(question), project_name)
        if not normalized:
            continue
        if not normalized.endswith(("？", "?")):
            normalized += "？"
        signature = re.sub(r"\W+", "", normalized)
        if not signature or signature in seen:
            continue
        seen.add(signature)
        normalized_questions.append(normalized)
        if len(normalized_questions) == 3:
            break
    if len(normalized_questions) < 3:
        fallback_questions = build_intro_fallback_questions() if phase == "intro" else build_fallback_project_questions(project)
        for question in fallback_questions:
            signature = re.sub(r"\W+", "", question)
            if signature in seen:
                continue
            seen.add(signature)
            normalized_questions.append(question)
            if len(normalized_questions) == 3:
                break
    return "\n".join(f"{index}. {question}" for index, question in enumerate(normalized_questions[:3], start=1))


def build_interview_turn_message(
    raw_text: str,
    phase: str,
    topic: Optional[Dict],
    other_topic_names: Optional[List[str]],
    is_new_topic: bool,
    asked_topic_ids: Optional[List[str]] = None,
) -> str:
    normalized = normalize_interview_questions(
        raw_text,
        topic,
        other_topic_names,
        phase=phase,
    )
    note = build_interview_phase_note(phase, topic, is_new_topic, asked_topic_ids)
    return f"{note}\n{normalized}".strip() if note else normalized


def load_analysis_text_from_run_id(state: Dict, run_id: str) -> str:
    if not run_id:
        return ""
    for run_item in state.get("runs", []):
        if run_item.get("id") != run_id:
            continue
        try:
            return Path(run_item["path"]).read_text(encoding="utf-8")
        except OSError:
            return ""
    return ""


def interview_transcript_markdown(interview: Dict, data: Dict, config: Dict) -> str:
    resume_name = interview.get("resume_name", "未指定")
    project_names = "、".join(interview.get("project_names", [])) or "未指定"
    lines = [
        markdown_meta(
            "模拟面试记录",
            config,
            [
                f"面试标题：{interview['title']}",
                f"简历素材：{resume_name}",
                f"项目素材：{project_names}",
                f"状态：{interview['status']}",
            ],
        ),
        "## 对话记录",
    ]
    for message in data.get("messages", []):
        speaker = "面试官" if message["role"] == "assistant" else "候选人"
        lines.append(f"### {speaker}")
        lines.append(message["content"])
        lines.append("")
    return "\n".join(lines)


def build_resume_analysis_prompt(resume: Dict, projects: List[Dict]) -> str:
    project_context = "\n\n".join(build_project_snapshot(project) for project in projects) if projects else "未提供项目资料。"
    return (
        "请基于以下简历和项目资料，输出一份用于大模型应用开发 / Agent 应用开发岗位的简历分析报告。"
        "报告必须包括：岗位匹配概览、简历亮点、主要风险、修改建议、后续模拟面试重点。\n\n"
        f"简历内容：\n```markdown\n{resume_text_from_asset(resume)}\n```\n\n"
        f"项目资料：\n{project_context}\n"
    )


def build_interview_start_prompt(resume: Dict, projects: List[Dict], analysis_text: str = "") -> str:
    project_context = "\n\n".join(build_project_snapshot(project, max_files=10) for project in projects) if projects else "未提供项目资料。"
    return (
        "请开始一场模拟面试。要求：\n"
        "1. 一次只提出 3 到 5 个问题。\n"
        "2. 问题必须围绕简历和项目，难度由浅入深。\n"
        "3. 输出只包含当前轮要问的问题，不要提前给评价。\n\n"
        "**格式要求（必须严格遵守）：**\n"
        "- 每个问题必须单独一行，以编号开头\n"
        "- 编号必须是 1. 2. 3. 这样的递增格式\n"
        "- 禁止让所有问题都使用编号 1.\n\n"
        "正确格式示例：\n"
        "1. 第一个问题是什么？\n"
        "2. 第二个问题是什么？\n"
        "3. 第三个问题是什么？\n\n"
        f"简历：\n```markdown\n{resume_text_from_asset(resume)}\n```\n\n"
        f"项目资料：\n{project_context}\n\n"
        f"已有简历分析（可选）：\n```markdown\n{analysis_text}\n```"
    )


def build_interview_followup_prompt(interview_data: Dict, latest_answer: str) -> str:
    transcript = []
    for message in interview_data.get("messages", []):
        role = "面试官" if message["role"] == "assistant" else "候选人"
        transcript.append(f"{role}: {message['content']}")
    return (
        "你正在继续一场模拟面试。请基于已有对话和候选人刚才的回答继续追问。"
        "一次只提出 3 到 5 个问题，继续围绕项目细节、工程指标和取舍展开。"
        "不要给最终评价。\n\n"
        "**格式要求（必须严格遵守）：**\n"
        "- 每个问题必须单独一行，以编号开头\n"
        "- 编号必须是 1. 2. 3. 这样的递增格式\n"
        "- 禁止让所有问题都使用编号 1.\n\n"
        "正确格式示例：\n"
        "1. 第一个问题是什么？\n"
        "2. 第二个问题是什么？\n"
        "3. 第三个问题是什么？\n\n"
        f"历史对话：\n```text\n{os.linesep.join(transcript)}\n```\n\n"
        f"候选人刚才的最新回答：\n{latest_answer}"
    )


def build_interview_start_prompt_v2(
    resume: Dict,
    projects: List[Dict],
    analysis_text: str = "",
    focus_project_id: str = "",
) -> str:
    project_context = "\n\n".join(build_project_snapshot(project, max_files=10) for project in projects) if projects else "未提供项目资料。"
    focus_project = resolve_focus_project(projects, focus_project_id)
    focus_project_name = focus_project["name"] if focus_project else "未指定项目"
    other_project_names = [project["name"] for project in projects if project.get("id") != (focus_project or {}).get("id")]
    other_projects_text = "、".join(other_project_names) if other_project_names else "暂无"
    return (
        "请开始一场模拟面试。要求：\n"
        "1. 一次只提出 3 到 5 个问题。\n"
        "2. 问题必须围绕简历和项目，难度由浅入深。\n"
        "3. 同一轮里如果问项目，只能围绕同一个项目展开，禁止混入多个项目的问题。\n"
        f"4. 当前轮次聚焦项目：{focus_project_name}。\n"
        "5. 即使候选人还有其他项目，本轮也不要切到其他项目；后续轮次再一个项目一个项目地问。\n"
        "6. 当前轮的每个项目问题都要直接指向当前聚焦项目，避免问题对象模糊。\n"
        "7. 输出只包含当前轮要问的问题，不要提前给评价。\n\n"
        "**格式要求（必须严格遵守）**\n"
        "- 每个问题必须单独一行，以编号开头\n"
        "- 编号必须是 1. 2. 3. 这样递增格式\n"
        "- 禁止让所有问题都使用编号 1.\n\n"
        "正确格式示例：\n"
        "1. 第一个问题是什么？\n"
        "2. 第二个问题是什么？\n"
        "3. 第三个问题是什么？\n\n"
        f"当前聚焦项目：{focus_project_name}\n"
        f"其他项目（本轮不要提问）：{other_projects_text}\n\n"
        f"简历：\n```markdown\n{resume_text_from_asset(resume)}\n```\n\n"
        f"项目资料：\n{project_context}\n\n"
        f"已有简历分析（可选）：\n```markdown\n{analysis_text}\n```"
    )


def build_interview_followup_prompt_v2(interview_data: Dict, latest_answer: str, projects: List[Dict]) -> str:
    transcript = []
    for message in interview_data.get("messages", []):
        role = "面试官" if message["role"] == "assistant" else "候选人"
        transcript.append(f"{role}: {message['content']}")
    focus_project = resolve_focus_project(projects, interview_data.get("current_project_id", ""))
    focus_project_name = focus_project["name"] if focus_project else "未指定项目"
    remaining_names = [project["name"] for project in projects if project.get("id") != (focus_project or {}).get("id")]
    remaining_projects_text = "、".join(remaining_names) if remaining_names else "暂无"
    return (
        "你正在继续一场模拟面试。请基于已有对话和候选人刚才的回答继续追问。"
        "一次只提出 3 到 5 个问题，继续围绕项目细节、工程指标和取舍展开。"
        f"当前轮次默认聚焦项目：{focus_project_name}。"
        "同一轮里如果问项目，只能问这一个项目，不能混入其他项目。"
        "如果你判断该切到下一个项目，也必须整轮只围绕新的单个项目提问，不能同时提到两个项目。"
        "除非明确决定切换，否则默认延续当前聚焦项目继续深挖。"
        "不要给最终评价。\n\n"
        "**格式要求（必须严格遵守）**\n"
        "- 每个问题必须单独一行，以编号开头\n"
        "- 编号必须是 1. 2. 3. 这样递增格式\n"
        "- 禁止让所有问题都使用编号 1.\n\n"
        "正确格式示例：\n"
        "1. 第一个问题是什么？\n"
        "2. 第二个问题是什么？\n"
        "3. 第三个问题是什么？\n\n"
        f"当前聚焦项目：{focus_project_name}\n"
        f"其他候选项目：{remaining_projects_text}\n\n"
        f"历史对话：\n```text\n{os.linesep.join(transcript)}\n```\n\n"
        f"候选人刚才的最新回答：\n{latest_answer}"
    )


def build_interview_round_prompt_v3(
    resume: Dict,
    project: Optional[Dict],
    analysis_text: str = "",
    asked_project_names: Optional[List[str]] = None,
    latest_answer: str = "",
) -> str:
    project_name = project["name"] if project else "你的核心项目"
    asked_text = "、".join([name for name in (asked_project_names or []) if name]) or "暂无"
    latest_answer_block = ""
    if latest_answer.strip():
        latest_answer_block = (
            "上一轮候选人的回答如下。这段内容只用于帮助你了解候选人的表达和经验，不要在本轮继续追问其他项目。\n"
            f"```text\n{latest_answer.strip()}\n```\n\n"
        )
    return (
        "你正在进行模拟面试。在输出问题前，请先完整阅读候选人的简历，再阅读本轮的当前项目资料。\n"
        "本轮只允许问一个项目，并且必须严格输出 3 个问题。\n"
        "3 个问题都必须围绕当前项目，不能掺杂其他项目，不能问自我介绍，不能做评价，不能输出标题或说明文字。\n"
        f"当前项目：{project_name}\n"
        f"已经问过的项目：{asked_text}\n"
        "输出格式必须严格如下，编号必须递增：\n"
        "1. 第一个问题\n"
        "2. 第二个问题\n"
        "3. 第三个问题\n\n"
        f"{latest_answer_block}"
        f"简历内容：\n```markdown\n{resume_text_from_asset(resume)}\n```\n\n"
        f"当前项目资料：\n{project_snapshot_or_placeholder(project, max_files=10)}\n\n"
        f"补充分析（可选）：\n```markdown\n{analysis_text}\n```"
    )


def build_interview_review_prompt(interview: Dict, interview_data: Dict, state: Dict) -> str:
    transcript = []
    for message in interview_data.get("messages", []):
        role = "面试官" if message["role"] == "assistant" else "候选人"
        transcript.append(f"{role}: {message['content']}")
    resume = find_asset(state, "resume", interview["resume_asset_id"])
    project_context = project_context_from_ids(state, interview.get("project_asset_ids", []), max_files=10)
    return (
        "请基于下面的模拟面试对话生成一份客观的面试评价。"
        "输出必须包括：面试概况、亮点、主要不足、综合结论、改进建议。"
        "风格要求专业、中立、可执行。\n\n"
        f"简历：\n```markdown\n{resume_text_from_asset(resume)}\n```\n\n"
        f"项目上下文：\n{project_context}\n\n"
        f"面试对话：\n```text\n{os.linesep.join(transcript)}\n```"
    )


def interview_review_date(interview: Dict) -> str:
    for key in ("created_at", "updated_at"):
        date_text = extract_iso_date(interview.get(key, ""))
        if date_text:
            return date_text
    return today_str()


def interview_review_run_title(interview: Dict) -> str:
    return f"{interview_review_date(interview)} \u9762\u8bd5\u8bc4\u4ef7"


def strip_outer_markdown_fence(content: str) -> str:
    normalized = (content or "").strip()
    match = re.match(r"^```(?:markdown|md)?\s*\n(?P<body>[\s\S]*?)\n```$", normalized, flags=re.IGNORECASE)
    return match.group("body").strip() if match else normalized


def interview_version_suffix(interview: Dict) -> str:
    match = INTERVIEW_TITLE_RE.match((interview.get("title") or "").strip())
    if match and match.group("index"):
        return f"-{match.group('index')}"
    return ""


def normalize_interview_review_content(interview: Dict, content: str) -> str:
    review_date = interview_review_date(interview)
    heading = f"# {review_date} 模拟面试结果{interview_version_suffix(interview)}（大模型应用开发）"
    normalized = strip_outer_markdown_fence(content)
    if re.search(r"(?m)^# .+$", normalized):
        normalized = re.sub(r"(?m)^# .+$", heading, normalized, count=1)
    else:
        normalized = f"{heading}\n\n{normalized}".strip()
    if re.search(r"(?m)^日期[:：].*$", normalized):
        normalized = re.sub(r"(?m)^日期[:：].*$", f"日期：{review_date}", normalized, count=1)
    else:
        normalized = normalized.replace(heading, f"{heading}\n\n日期：{review_date}", 1)
    return normalized.rstrip() + "\n"


def learning_summary_date(review_run: Dict, state: Dict) -> str:
    interview_id = (review_run.get("source") or {}).get("interview_id", "")
    if interview_id:
        try:
            interview = find_interview(state, interview_id)
            return interview_review_date(interview)
        except KeyError:
            pass
    for key in ("updated_at", "created_at", "title", "path"):
        date_text = extract_iso_date(review_run.get(key, ""))
        if date_text:
            return date_text
    return today_str()


def learning_run_title(review_run: Dict, state: Dict) -> str:
    return f"{learning_summary_date(review_run, state)} \u5b66\u4e60\u603b\u7ed3"


def strip_learning_preamble(content: str) -> str:
    normalized = (content or "").strip().replace("\r\n", "\n")
    first_section = re.search(r"(?m)^##\s+", normalized)
    if first_section:
        prefix = normalized[:first_section.start()]
        if re.search(r"你好|收到你的请求|学习助手|我已经仔细阅读|模拟面试结果|面试知识总结", prefix, flags=re.IGNORECASE):
            normalized = normalized[first_section.start():].lstrip()
    normalized = re.sub(r"(?im)^你好[！!。,.， ].*$", "", normalized)
    normalized = re.sub(r"(?im)^.*收到你的请求.*$", "", normalized)
    normalized = re.sub(r"(?im)^.*我已经仔细阅读.*$", "", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    return normalized.strip()


def normalize_learning_content(review_run: Dict, state: Dict, content: str) -> str:
    summary_date = learning_summary_date(review_run, state)
    heading = f"# {summary_date} 面试知识总结"
    normalized = strip_outer_markdown_fence(strip_learning_preamble(content))
    if re.search(r"(?m)^# .+$", normalized):
        normalized = re.sub(r"(?m)^# .+$", heading, normalized, count=1)
    else:
        normalized = f"{heading}\n\n{normalized}".strip()
    normalized = re.sub(r"(?m)^日期[:：].*$", "", normalized)
    normalized = re.sub(r"(?m)^来源面试评价[:：].*$", "", normalized)
    normalized = re.sub(r"(?m)^关联面试[:：].*$", "", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized).strip()
    metadata_lines = [f"日期：{summary_date}", f"来源面试评价：{review_run.get('title', '')}"]
    interview_id = (review_run.get("source") or {}).get("interview_id", "")
    if interview_id:
        try:
            metadata_lines.append(f"关联面试：{find_interview(state, interview_id).get('title', '')}")
        except KeyError:
            pass
    normalized = normalized.replace(heading, heading + "\n\n" + "\n".join(metadata_lines), 1)
    return normalized.rstrip() + "\n"


def stream_text_fragments(text: str, chunk_size: int = 16):
    content = text or ""
    if not content:
        yield ""
        return
    for index in range(0, len(content), chunk_size):
        yield content[index:index + chunk_size]



def build_interview_system_prompt_v4(skill_text: str, config: Dict) -> str:
    rules = """
You are conducting a fact-grounded mock interview.

Follow these rules strictly:
1. Use only the resume text, the current resume topic materials, the current project materials, and statements made by the candidate in the conversation as factual sources.
2. Previous interviewer questions are NOT facts. If an earlier interviewer message conflicts with the resume or project materials, ignore the interviewer message.
3. If a metric, technology, model, framework, business context, company detail, or implementation detail is not explicitly present in the factual sources, do not invent it. Ask an open-ended question instead.
4. Ask exactly 3 questions each turn, numbered `1.`, `2.`, `3.`.
5. If the current stage is `intro`, ask only self-introduction / background questions. Do not start project deep-dives yet.
6. If the current stage is `topic`, ask only about the current focus topic from the resume. Do not mix in other topics.
7. Output questions only. Do not add greetings, explanations, summaries, transition sentences, or evaluation text. The server will add transition lines separately.
8. Ask naturally and directly. Do not start every question with repetitive lead-ins like `在《项目名》里` or `关于这个项目`.
"""
    return build_system_prompt("mock_interview", skill_text, config) + "\n\n" + rules.strip()


def build_interview_context_message_v4(
    resume: Dict,
    current_topic: Optional[Dict],
    current_project: Optional[Dict],
    projects: List[Dict],
    topics: List[Dict],
    analysis_text: str = "",
    asked_topic_names: Optional[List[str]] = None,
    phase: str = "project",
) -> Dict:
    project_names = " / ".join(project["name"] for project in projects) if projects else "(none)"
    current_topic_name = current_topic["name"] if current_topic else "(none)"
    current_project_name = current_project["name"] if current_project else "(none)"
    asked_text = " / ".join([name for name in (asked_topic_names or []) if name]) or "(none)"
    optional_analysis = ""
    if analysis_text.strip():
        optional_analysis = (
            "\n\n## Optional follow-up directions (not factual sources)\n"
            "Use this section only to decide what angle to probe next. "
            "Do not treat any detail here as fact unless it also appears explicitly in the resume or project materials.\n"
            f"```markdown\n{analysis_text}\n```"
        )
    if phase == "intro":
        stage_rules = (
            "- Current stage: intro\n"
            "- Ask only self-introduction, job direction, recent experience, and basic background questions.\n"
            "- Do not enter project deep-dive questions in this turn.\n"
        )
    else:
        stage_rules = (
            "- Current stage: topic\n"
            f"- Current focus topic from the resume: {current_topic_name}\n"
            f"- Matched project asset for extra context: {current_project_name}\n"
            "- In this turn, only ask about the current focus topic.\n"
        )
    return {
        "role": "user",
        "content": (
            "Authoritative materials for this interview turn. Treat them as the fact boundary.\n\n"
            "## Fact boundary\n"
            f"{stage_rules}"
            f"- Resume topics detected from markdown headings:\n{build_resume_topic_sequence(topics)}\n"
            f"- Allowed project asset names: {project_names}\n"
            f"- Already covered topics: {asked_text}\n"
            "- If a detail is missing from these materials, do not assume it. Ask openly.\n"
            "- If the candidate asks you to reread the resume, reread the materials below and continue from them.\n"
            "- Candidate messages can add facts about their own experience. Previous interviewer messages cannot create new facts.\n\n"
            f"## Resume\n```markdown\n{resume_text_from_asset(resume)}\n```\n\n"
            f"## Current resume topic materials\n{resume_topic_snapshot_or_placeholder(current_topic)}\n\n"
            f"## Current project materials\n{project_snapshot_or_placeholder(current_project, max_files=10)}"
            f"{optional_analysis}"
        ),
    }


def build_interview_directive_message(
    phase: str,
    current_topic: Optional[Dict],
    conversation_messages: List[Dict],
    reread_requested: bool = False,
) -> Dict:
    if conversation_messages:
        reminder = ""
        if reread_requested:
            reminder = (
                "\nThe candidate explicitly asked you to reread the resume/project materials. "
                "Reground yourself in those materials before asking the next three questions."
            )
        if phase == "intro":
            task = (
                "Continue the opening round. Ask only self-introduction and basic background questions. "
                "Do not start project or work-experience deep dives yet."
            )
        else:
            topic_name = current_topic.get("name", "current topic") if current_topic else "current topic"
            task = (
                f"Continue the interview on the resume topic `{topic_name}` only. "
                "Ask project/work-experience questions only about this topic."
            )
        return {
            "role": "user",
            "content": (
                f"{task} "
                "Use the factual materials and the conversation history. "
                "Only the candidate's messages may add new facts; earlier interviewer questions are continuity only. "
                "Keep the phrasing natural and avoid repeating the project name at the start of every question."
                f"{reminder}"
            ),
        }
    if phase == "intro":
        content = "Start the first mock interview turn. Ask exactly three self-introduction or basic-background questions."
    else:
        topic_name = current_topic.get("name", "current topic") if current_topic else "current topic"
        content = f"Start the next topic turn. Ask exactly three questions about `{topic_name}` only."
    return {
        "role": "user",
        "content": content,
    }


def user_requests_resume_reread(text: str) -> bool:
    normalized = (text or "").strip().lower()
    if not normalized:
        return False
    keywords = [
        "\u91cd\u65b0\u9605\u8bfb\u7b80\u5386",
        "\u91cd\u65b0\u770b\u7b80\u5386",
        "\u518d\u770b\u7b80\u5386",
        "\u91cd\u65b0\u8bfb\u7b80\u5386",
        "\u518d\u8bfb\u7b80\u5386",
        "\u770b\u770b\u6211\u7684\u7b80\u5386",
        "\u56de\u5230\u6211\u7684\u7b80\u5386",
        "\u91cd\u65b0\u9605\u8bfb\u6211\u7684\u9879\u76ee\u7ecf\u5386",
        "\u91cd\u65b0\u770b\u6211\u7684\u9879\u76ee\u7ecf\u5386",
        "\u91cd\u65b0\u8bfb\u4e00\u4e0b\u6211\u7684\u9879\u76ee\u7ecf\u5386",
        "reread my resume",
        "read my resume again",
        "re-read my resume",
    ]
    return any(keyword in normalized for keyword in keywords)


def generate_interview_questions_v4(
    runtime_config: Dict,
    skill_text: str,
    resume: Dict,
    current_topic: Optional[Dict],
    current_project: Optional[Dict],
    projects: List[Dict],
    topics: List[Dict],
    analysis_text: str,
    asked_topic_names: List[str],
    conversation_messages: List[Dict],
    phase: str = "project",
    reread_requested: bool = False,
) -> str:
    provider_cfg = runtime_config.get("model", {})
    if provider_cfg.get("provider_type") == "demo":
        if phase == "intro":
            return "\n".join(f"{index}. {question}" for index, question in enumerate(build_intro_fallback_questions(), start=1))
        return normalize_interview_questions("", current_topic or current_project or {"name": (current_topic or {}).get("name", "")}, [], phase="project")
    system_prompt = build_interview_system_prompt_v4(skill_text, runtime_config)
    context_message = build_interview_context_message_v4(
        resume,
        current_topic,
        current_project,
        projects,
        topics,
        analysis_text,
        asked_topic_names,
        phase,
    )
    directive_message = build_interview_directive_message(phase, current_topic, conversation_messages, reread_requested)
    return chat_completion_from_messages(
        provider_cfg,
        system_prompt,
        [context_message] + list(conversation_messages) + [directive_message],
    )

def build_learning_prompt(evaluation_text: str, projects: List[Dict], transcript_text: str) -> str:
    project_context = "\n\n".join(build_project_snapshot(project, max_files=10) for project in projects) if projects else "未提供项目资料。"
    return (
        "请根据面试评价中的不足项生成学习总结。"
        "每条不足至少包括：更好的回答、需要学习的知识点、下一步练习建议。"
        "如果项目中其实已经做过相关内容，但候选人现场没答出来，也请指出更好的表达方式。"
        "直接输出 Markdown 正文，不要寒暄，不要写“我已经阅读了你的请求/文档”，不要引用其他历史总结标题，也不要自行编造日期。\n\n"
        f"面试评价：\n```markdown\n{evaluation_text}\n```\n\n"
        f"项目资料：\n{project_context}\n\n"
        f"面试记录：\n```markdown\n{transcript_text}\n```"
    )


def build_open_source_prompt(project: Dict, template: str) -> str:
    template_text = template.strip() or "未提供模板，请按默认结构输出。"
    snapshot = build_project_snapshot(project, max_files=24, chars_per_file=3500)
    return (
        "请按开源项目解读的要求输出一份 Markdown 分析。"
        "要求先识别项目入口、目录结构、核心模块，再做模块化解读。"
        "最后补充从输入到输出的流程总结。\n\n"
        f"用户模板：\n```markdown\n{template_text}\n```\n\n"
        f"项目快照：\n{snapshot}"
    )


def build_comment_prompt(module_key: str, document_text: str, comment: str, extra_context: str) -> str:
    return (
        f"当前文档所属模块：{MODULE_DIRECTORIES.get(module_key, module_key)}。\n"
        "请基于当前文档和附加上下文，对下面这条批注给出继续回复。"
        "输出要求：先直接回答，再补充需要用户关注的关键点。"
        "回答必须基于已有文档和上下文，不要编造。\n\n"
        f"当前文档：\n```markdown\n{document_text}\n```\n\n"
        f"附加上下文：\n{extra_context}\n\n"
        f"批注：{comment}"
    )


def build_inline_comment_prompt(module_key: str, original_text: str, annotated_text: str, extra_context: str) -> str:
    return (
        f"当前文档所属模块：{MODULE_DIRECTORIES.get(module_key, module_key)}。\n"
        "用户已经直接在文档原文里写入了内联批注，请你根据这些批注直接修改文档正文。\n"
        "输出要求：\n"
        "1. 识别内联批注，常见形式包括 `批注：...`、`批注: ...`、`TODO: ...`、`NOTE: ...`、`【批注】...`、`<!-- 批注：... -->`。\n"
        "2. 按批注修改原文，但尽量保持未涉及部分、标题结构和整体风格不变。\n"
        "3. 删除所有批注痕迹，不要追加“批注回复”章节，不要解释修改过程。\n"
        "4. 只输出修改后的完整 Markdown 正文。\n\n"
        f"原始文档：\n```markdown\n{original_text}\n```\n\n"
        f"包含内联批注的当前文档：\n```markdown\n{annotated_text}\n```\n\n"
        f"附加上下文：\n{extra_context}"
    )


def resolve_document_context(state: Dict, target: Path) -> Dict:
    module_key = "resume_analysis"
    provider_id = ""
    extra_context = ""
    matching_run = next((item for item in state["runs"] if Path(item["path"]) == target), None)
    if matching_run:
        module_key = matching_run["module_key"]
        source = matching_run.get("source", {})
        provider_id = source.get("provider_id", "")
        if source.get("resume_asset_id"):
            resume = find_asset(state, "resume", source["resume_asset_id"])
            extra_context += f"关联简历：\n```markdown\n{resume_text_from_asset(resume)}\n```\n\n"
        project_ids = source.get("project_asset_ids", [])
        if project_ids:
            extra_context += project_context_from_ids(state, project_ids, max_files=8)
        if source.get("interview_id"):
            interview = find_interview(state, source["interview_id"])
            extra_context += (
                f"\n\n关联面试记录：\n```markdown\n"
                f"{Path(interview['transcript_path']).read_text(encoding='utf-8')}\n```"
            )
        return {"module_key": module_key, "provider_id": provider_id, "extra_context": extra_context}

    matching_interview = next((item for item in state.get("interviews", []) if Path(item["transcript_path"]) == target), None)
    if matching_interview:
        module_key = "mock_interview"
        provider_id = matching_interview.get("provider_id", "")
        resume = find_asset(state, "resume", matching_interview["resume_asset_id"])
        extra_context += f"关联简历：\n```markdown\n{resume_text_from_asset(resume)}\n```\n\n"
        project_ids = matching_interview.get("project_asset_ids", [])
        if project_ids:
            extra_context += project_context_from_ids(state, project_ids, max_files=8)
        return {"module_key": module_key, "provider_id": provider_id, "extra_context": extra_context}

    return {"module_key": module_key, "provider_id": provider_id, "extra_context": extra_context}



def start_interview_session(workspace: Path, state: Dict, config: Dict, payload: Dict) -> Dict:
    runtime_config = ensure_runtime_timeout(runtime_config_with_provider(config, payload.get("provider_id")), 180)
    resume = find_asset(state, "resume", payload["resume_asset_id"])
    selected_project_ids = normalize_project_id_list(payload.get("project_asset_ids", []))
    projects = project_assets_from_ids(state, selected_project_ids)
    analysis_text = ""
    source_run = None
    if payload.get("analysis_run_id"):
        for run_item in state["runs"]:
            if run_item["id"] != payload["analysis_run_id"]:
                continue
            source_project_ids = (run_item.get("source") or {}).get("project_asset_ids", [])
            if project_scope_matches(selected_project_ids, source_project_ids):
                source_run = run_item
                analysis_text = Path(run_item["path"]).read_text(encoding="utf-8")
            break
    skill_text = read_skill("mock_interview")
    resume_topics = extract_resume_focus_topics(resume, projects)
    opening_raw = generate_interview_questions_v4(
        runtime_config,
        skill_text,
        resume,
        None,
        None,
        projects,
        resume_topics,
        analysis_text,
        [],
        [],
        phase="intro",
    )
    opening = build_interview_turn_message(opening_raw, "intro", None, [topic["name"] for topic in resume_topics], False)
    interview_id = uuid.uuid4().hex
    transcript_path = next_module_markdown_path(workspace, "mock_interview", "\u6a21\u62df\u9762\u8bd5")
    interview_json_path = workspace / "system" / "interviews" / f"{interview_id}.json"
    interview = {
        "id": interview_id,
        "title": f"{today_str()} \u6a21\u62df\u9762\u8bd5",
        "resume_asset_id": resume["id"],
        "resume_name": resume["name"],
        "project_asset_ids": [project["id"] for project in projects],
        "project_names": [topic["name"] for topic in resume_topics] or [project["name"] for project in projects],
        "status": "active",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "transcript_path": str(transcript_path),
        "json_path": str(interview_json_path),
        "analysis_run_id": source_run["id"] if source_run else "",
        "provider_id": runtime_config.get("model", {}).get("id", ""),
        "provider_label": runtime_config.get("model", {}).get("provider_label", ""),
        "model_name": runtime_config.get("model", {}).get("model_name", ""),
    }
    interview_data = {
        "messages": [{"role": "assistant", "content": opening}],
        "turn_count": 1,
        "phase": "intro",
        "resume_topics": resume_topics,
        "current_topic_id": "",
        "asked_topic_ids": [],
        "current_project_id": "",
        "asked_project_ids": [],
    }
    save_interview_data(interview, interview_data)
    persist_markdown(transcript_path, interview_transcript_markdown(interview, interview_data, runtime_config))
    state["interviews"].append(interview)
    state["active_document"] = str(transcript_path)
    return {"interview": interview, "messages": interview_data["messages"]}


def reply_interview_session(workspace: Path, state: Dict, config: Dict, payload: Dict) -> Dict:
    interview = find_interview(state, payload["interview_id"])
    runtime_config = runtime_config_with_provider(config, interview.get("provider_id"))
    if interview["status"] != "active":
        raise ValueError("\u5f53\u524d\u9762\u8bd5\u5df2\u7ed3\u675f")
    answer = (payload.get("answer") or "").strip()
    if not answer:
        raise ValueError("\u56de\u7b54\u4e0d\u80fd\u4e3a\u7a7a")
    data = load_interview_data(interview)
    data.setdefault("messages", []).append({"role": "user", "content": answer})
    asked_project_ids = data.setdefault("asked_project_ids", [])
    projects = project_assets_from_ids(state, interview.get("project_asset_ids", []))
    resume = find_asset(state, "resume", interview["resume_asset_id"])
    resume_topics = data.get("resume_topics") or extract_resume_focus_topics(resume, projects)
    data["resume_topics"] = resume_topics
    phase = data.get("phase") or ("topic" if data.get("current_project_id") or data.get("asked_project_ids") or int(data.get("turn_count", 1)) > 1 else "intro")
    asked_topic_ids = data.setdefault("asked_topic_ids", [])
    current_topic_id = data.get("current_topic_id", "")
    if not current_topic_id and data.get("current_project_id"):
        matched_topic = next(
            (topic for topic in resume_topics if topic.get("matched_project_id") == data.get("current_project_id")),
            None,
        )
        if matched_topic:
            current_topic_id = matched_topic["id"]
            data["current_topic_id"] = current_topic_id
    if not asked_topic_ids and asked_project_ids:
        asked_topic_ids.extend(
            [
                topic["id"]
                for topic in resume_topics
                if topic.get("matched_project_id") in set(asked_project_ids)
            ]
        )
    reread_requested = user_requests_resume_reread(answer)
    continue_current_topic = user_requests_continue_current_topic(answer)
    current_topic = find_resume_topic_by_id(resume_topics, current_topic_id)
    if phase == "intro":
        next_phase = "topic"
        next_topic = pick_next_resume_topic(resume_topics, asked_topic_ids, current_topic_id)
        is_new_topic = True
    elif reread_requested or continue_current_topic:
        next_phase = "topic"
        next_topic = current_topic or pick_next_resume_topic(resume_topics, asked_topic_ids, current_topic_id)
        is_new_topic = False
    else:
        next_phase = "topic"
        next_topic = pick_next_resume_topic(resume_topics, asked_topic_ids, current_topic_id) or current_topic
        is_new_topic = not current_topic or (next_topic and next_topic.get("id") != current_topic.get("id"))
    next_project = matched_project_for_topic(next_topic, projects)
    analysis_text = load_analysis_text_from_run_id(state, interview.get("analysis_run_id", ""))
    asked_topic_names = [
        topic["name"]
        for topic in resume_topics
        if topic.get("id") in set(asked_topic_ids)
    ]
    next_turn = int(data.get("turn_count", 1)) + 1
    skill_text = read_skill("mock_interview")
    reply_raw = generate_interview_questions_v4(
        runtime_config,
        skill_text,
        resume,
        next_topic,
        next_project,
        projects,
        resume_topics,
        analysis_text,
        asked_topic_names,
        data.get("messages", []),
        phase=next_phase,
        reread_requested=reread_requested,
    )
    other_topic_names = [topic["name"] for topic in resume_topics if topic.get("id") != (next_topic or {}).get("id")]
    reply = build_interview_turn_message(reply_raw, next_phase, next_topic, other_topic_names, is_new_topic, asked_topic_ids)
    if next_topic:
        data["current_topic_id"] = next_topic["id"]
        if is_new_topic and next_topic["id"] not in asked_topic_ids:
            asked_topic_ids.append(next_topic["id"])
    if next_project:
        data["current_project_id"] = next_project["id"]
        if is_new_topic and next_project["id"] not in asked_project_ids:
            asked_project_ids.append(next_project["id"])
    else:
        data["current_project_id"] = ""
    data["messages"].append({"role": "assistant", "content": reply})
    data["turn_count"] = next_turn
    data["phase"] = next_phase
    interview["updated_at"] = now_iso()
    save_interview_data(interview, data)
    persist_markdown(Path(interview["transcript_path"]), interview_transcript_markdown(interview, data, runtime_config))
    state["active_document"] = interview["transcript_path"]
    return {"interview": interview, "messages": data["messages"]}

def finish_interview_session(workspace: Path, state: Dict, config: Dict, payload: Dict) -> Dict:
    interview = find_interview(state, payload["interview_id"])
    provider_id = payload.get("provider_id") or interview.get("provider_id")
    runtime_config = ensure_runtime_timeout(runtime_config_with_provider(config, provider_id), 180)
    data = load_interview_data(interview)
    closing_note = (payload.get("closing_note") or "").strip()
    if closing_note:
        data.setdefault("messages", []).append({"role": "user", "content": closing_note})
    interview["status"] = "completed"
    interview["updated_at"] = now_iso()
    save_interview_data(interview, data)
    persist_markdown(Path(interview["transcript_path"]), interview_transcript_markdown(interview, data, runtime_config))
    skill_text = read_skill("interview_review")
    prompt = build_interview_review_prompt(interview, data, state)
    content = call_model(
        "interview_review",
        prompt,
        runtime_config,
        demo_interview_evaluation,
        (interview, runtime_config),
        skill_text=skill_text,
    )
    content = normalize_interview_review_content(interview, content)
    run = create_run(
        workspace,
        state,
        runtime_config,
        "interview_review",
        interview_review_run_title(interview),
        content,
        {
            "interview_id": interview["id"],
            "resume_asset_id": interview["resume_asset_id"],
            "project_asset_ids": interview.get("project_asset_ids", []),
            "transcript_path": interview["transcript_path"],
        },
    )
    interview["review_run_id"] = run["id"]
    return {"interview": interview, "review_run": run}


def rerun_interview_review_session(workspace: Path, state: Dict, config: Dict, payload: Dict) -> Dict:
    runtime_config = ensure_runtime_timeout(runtime_config_with_provider(config, payload.get("provider_id")), 180)
    interview = find_interview(state, payload["interview_id"])
    data = load_interview_data(interview)
    skill_text = read_skill("interview_review")
    content = call_model(
        "interview_review",
        build_interview_review_prompt(interview, data, state),
        runtime_config,
        demo_interview_evaluation,
        (interview, runtime_config),
        skill_text=skill_text,
    )
    content = normalize_interview_review_content(interview, content)
    run = create_run(
        workspace,
        state,
        runtime_config,
        "interview_review",
        interview_review_run_title(interview),
        content,
        {
            "interview_id": interview["id"],
            "resume_asset_id": interview["resume_asset_id"],
            "project_asset_ids": interview.get("project_asset_ids", []),
            "transcript_path": interview["transcript_path"],
        },
    )
    interview["review_run_id"] = run["id"]
    interview["updated_at"] = now_iso()
    return run


def bootstrap_payload(workspace_override: Optional[str] = None) -> Dict:
    config = load_config()
    workspace = ensure_workspace(config, workspace_override)
    state = load_state(workspace)
    previous_titles = {item.get("id", ""): item.get("title", "") for item in state.get("interviews", [])}
    changed = False
    if normalize_interview_titles(state.get("interviews", [])):
        refresh_interview_transcripts_for_title_changes(state, previous_titles)
        changed = True
    if normalize_run_titles(state):
        changed = True
    if changed:
        save_state(workspace, state)
    return {
        "config": config,
        "workspace_path": str(workspace),
        "assets": {
            "resumes": [normalize_asset(asset) for asset in state["resumes"]],
            "projects": [normalize_asset(asset) for asset in state["projects"]],
        },
        "runs": [
            normalize_run_item(run)
            for run in sorted(state["runs"], key=lambda item: item.get("updated_at") or item["created_at"], reverse=True)
        ],
        "interviews": [
            normalize_interview(interview)
            for interview in sorted(state["interviews"], key=lambda item: item["updated_at"], reverse=True)
        ],
        "active_document": state.get("active_document", ""),
    }


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_ROOT), **kwargs)

    def log_message(self, format_, *args):
        print(f"[{iso_label()}] {self.address_string()} - {format_ % args}")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.handle_api_get(parsed)
            return
        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(404, "Not Found")
            return
        self.handle_api_write(parsed, "POST")

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(404, "Not Found")
            return
        self.handle_api_write(parsed, "PUT")

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self.send_error(404, "Not Found")
            return
        self.handle_api_write(parsed, "DELETE")

    def parse_json_body(self) -> Dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def send_json(self, payload: Dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message: str, status: int = 400):
        self.send_json({"ok": False, "error": message}, status=status)

    def begin_stream(self, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

    def send_stream_event(self, event: str, payload: Optional[Dict] = None):
        body = {"event": event, **(payload or {})}
        chunk = (json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8")
        self.wfile.write(chunk)
        self.wfile.flush()

    def workspace_override_from_request(self, parsed=None, payload: Optional[Dict] = None) -> Optional[str]:
        header_value = (self.headers.get("X-Workspace-Path", "") or "").strip()
        if header_value:
            return header_value
        if payload and isinstance(payload, dict):
            body_value = (payload.get("workspace_override", "") or "").strip()
            if body_value:
                return body_value
        if parsed is not None:
            query = urllib.parse.parse_qs(parsed.query)
            query_value = (query.get("workspace_override", [""])[0] or "").strip()
            if query_value:
                return query_value
        return None

    def handle_api_get(self, parsed):
        try:
            if parsed.path == "/api/bootstrap":
                self.send_json({"ok": True, "data": bootstrap_payload(self.workspace_override_from_request(parsed))})
                return
            if parsed.path == "/api/config":
                self.send_json({"ok": True, "data": load_config()})
                return
            if parsed.path == "/api/document":
                query = urllib.parse.parse_qs(parsed.query)
                target = query.get("path", [""])[0]
                if not target:
                    raise ValueError("缺少 path 参数")
                path = Path(target)
                if not path.exists():
                    raise FileNotFoundError(f"文件不存在: {path}")
                self.send_json({"ok": True, "data": {"path": str(path), "content": path.read_text(encoding='utf-8')}})
                return
            self.send_error_json("未知 API", status=404)
        except Exception as exc:
            self.send_error_json(str(exc), status=500)

    def handle_api_write(self, parsed, method: str):
        try:
            payload = self.parse_json_body() if method != "DELETE" else {}
            workspace_override = self.workspace_override_from_request(parsed, payload)
            if parsed.path == "/api/config" and method in {"POST", "PUT"}:
                config = payload
                save_config(config)
                saved = load_config()
                ensure_workspace(saved)
                self.send_json({"ok": True, "data": saved})
                return
            if parsed.path == "/api/model/test" and method == "POST":
                config = load_config()
                provider_id = payload.get("provider_id")
                provider = None
                if payload.get("provider") and isinstance(payload.get("provider"), dict):
                    provider = normalize_provider(payload.get("provider"), payload.get("provider", {}).get("id") or "probe-provider")
                else:
                    provider = resolve_provider(config, provider_id)
                result = test_model_connection(provider)
                status = 200 if result.get("ok") else 400
                self.send_json({"ok": bool(result.get("ok")), "data": result, "error": None if result.get("ok") else result.get("message")}, status=status)
                return
            if parsed.path == "/api/chat/respond" and method == "POST":
                def run_general_chat(workspace, state, config):
                    runtime_config = ensure_runtime_timeout(runtime_config_with_provider(config, payload.get("provider_id")), 180)
                    messages = payload.get("messages") or []
                    if not messages:
                        raise ValueError("messages 不能为空")
                    provider_cfg = runtime_config.get("model", {})
                    system_prompt = "你是Interview-Assistant里的通用对话助手。回答要直接、可执行、简洁。"
                    if provider_cfg.get("provider_type") == "demo":
                        last_user = ""
                        for message in reversed(messages):
                            if message.get("role") == "user":
                                last_user = message.get("content", "")
                                break
                        reply = demo_general_chat_reply(last_user, runtime_config)
                    else:
                        reply = chat_completion_from_messages(provider_cfg, system_prompt, messages)
                    transcript_lines = [
                        markdown_meta("普通对话", runtime_config),
                        "## 对话记录",
                    ]
                    for message in messages:
                        role = "用户" if message.get("role") == "user" else "助手"
                        transcript_lines.append(f"### {role}")
                        transcript_lines.append(message.get("content", ""))
                        transcript_lines.append("")
                    transcript_lines.append("### 助手")
                    transcript_lines.append(reply)
                    content = "\n".join(transcript_lines)
                    existing_run_id = (payload.get("run_id") or "").strip()
                    run = update_run_content(state, existing_run_id, content, payload.get("title") or None) if existing_run_id else create_run(
                        workspace,
                        state,
                        runtime_config,
                        "general_chat",
                        payload.get("title") or "普通对话",
                        content,
                        {"provider_id": provider_cfg.get("id", ""), "message_count": len(messages)},
                    )
                    return {"reply": reply, "run": run}

                result = with_state(run_general_chat, workspace_override)
                self.send_json({"ok": True, "data": {"reply": result["reply"], "run": normalize_run_item(result["run"])}})
                return
            if parsed.path == "/api/resume/coach/respond" and method == "POST":
                def run_resume_coach(workspace, state, config):
                    runtime_config = runtime_config_with_provider(config, payload.get("provider_id"))
                    resume = find_asset(state, "resume", payload.get("resume_asset_id"))
                    selected_project_ids = normalize_project_id_list(payload.get("project_asset_ids", []))
                    analysis_text = ""
                    analysis_run_id = payload.get("analysis_run_id")
                    if analysis_run_id:
                        run_item = next((item for item in state["runs"] if item["id"] == analysis_run_id), None)
                        if run_item and project_scope_matches(selected_project_ids, (run_item.get("source") or {}).get("project_asset_ids", [])):
                            analysis_text = Path(run_item["path"]).read_text(encoding="utf-8")
                    messages = payload.get("messages") or []
                    if not messages:
                        raise ValueError("messages 不能为空")
                    user_request = ""
                    for message in reversed(messages):
                        if message.get("role") == "user":
                            user_request = message.get("content", "")
                            break
                    resume_text = resume_text_from_asset(resume)
                    provider_cfg = runtime_config.get("model", {})
                    if provider_cfg.get("provider_type") == "demo":
                        reply = demo_resume_coach_reply(resume_text, user_request, runtime_config)
                    else:
                        system_prompt = (
                            "你是简历互动优化助手。基于候选人简历和历史分析，"
                            "给出可执行修改建议，并尽量给出可直接替换的表述。"
                        )
                        context_message = {
                            "role": "user",
                            "content": (
                                "以下是简历正文和历史分析，请基于它们回答后续问题。\n\n"
                                f"简历：\n```markdown\n{resume_text}\n```\n\n"
                                f"历史分析：\n```markdown\n{analysis_text}\n```"
                            ),
                        }
                        reply = chat_completion_from_messages(provider_cfg, system_prompt, [context_message] + messages)
                    transcript_lines = [
                        markdown_meta("简历互动优化", runtime_config, [f"简历素材：{resume.get('name', '')}"]),
                        "## 互动记录",
                    ]
                    for message in messages:
                        role = "用户" if message.get("role") == "user" else "助手"
                        transcript_lines.append(f"### {role}")
                        transcript_lines.append(message.get("content", ""))
                        transcript_lines.append("")
                    transcript_lines.append("### 助手")
                    transcript_lines.append(reply)
                    run = create_run(
                        workspace,
                        state,
                        runtime_config,
                        "resume_analysis",
                        "简历互动优化",
                        "\n".join(transcript_lines),
                        {
                            "resume_asset_id": resume.get("id", ""),
                            "analysis_run_id": analysis_run_id or "",
                            "project_asset_ids": selected_project_ids,
                            "provider_id": provider_cfg.get("id", ""),
                        },
                    )
                    return {"reply": reply, "run": run}

                result = with_state(run_resume_coach, workspace_override)
                self.send_json({"ok": True, "data": {"reply": result["reply"], "run": normalize_run_item(result["run"])}})
                return
            if parsed.path == "/api/document" and method in {"POST", "PUT"}:
                target = Path(payload.get("path") or "")
                if not str(target):
                    raise ValueError("缺少 path")
                if not target.exists():
                    raise FileNotFoundError(f"文件不存在: {target}")
                content = payload.get("content")
                if content is None:
                    raise ValueError("缺少 content")
                target.write_text(content, encoding="utf-8")
                with_state(lambda workspace, state, config: state.__setitem__("active_document", str(target)), workspace_override)
                self.send_json({"ok": True, "data": {"path": str(target), "content": content}})
                return
            if parsed.path == "/api/assets/resumes" and method == "POST":
                result = with_state(lambda workspace, state, config: save_resume_asset(workspace, state, payload), workspace_override)
                self.send_json({"ok": True, "data": normalize_asset(result)})
                return
            if parsed.path == "/api/assets/projects" and method == "POST":
                result = with_state(lambda workspace, state, config: save_project_asset(workspace, state, payload), workspace_override)
                self.send_json({"ok": True, "data": normalize_asset(result)})
                return
            if parsed.path == "/api/assets/projects/import-path" and method == "POST":
                result = with_state(lambda workspace, state, config: register_project_asset_from_path(workspace, state, payload), workspace_override)
                self.send_json({"ok": True, "data": normalize_asset(result)})
                return
            if parsed.path == "/api/assets/rename" and method in {"POST", "PUT"}:
                kind = payload.get("kind")
                asset_id = payload.get("asset_id")
                new_name = payload.get("new_name")
                if kind not in {"resume", "project"}:
                    raise ValueError("kind 只能是 resume 或 project")
                result = with_state(lambda workspace, state, config: rename_asset(state, kind, asset_id, new_name), workspace_override)
                self.send_json({"ok": True, "data": normalize_asset(result)})
                return
            if parsed.path.startswith("/api/assets/") and method == "DELETE":
                parts = [part for part in parsed.path.split("/") if part]
                if len(parts) != 4:
                    raise ValueError("删除路径格式错误")
                _, _, kind, asset_id = parts
                if kind not in {"resume", "project"}:
                    raise ValueError("kind 只能是 resume 或 project")
                with_state(lambda workspace, state, config: delete_asset(workspace, state, kind, asset_id), workspace_override)
                self.send_json({"ok": True})
                return
            if parsed.path.startswith("/api/runs/") and method == "DELETE":
                parts = [part for part in parsed.path.split("/") if part]
                if len(parts) != 3:
                    raise ValueError("删除路径格式错误")
                _, _, run_id = parts
                with_state(lambda workspace, state, config: delete_run(workspace, state, run_id), workspace_override)
                self.send_json({"ok": True})
                return
            if parsed.path.startswith("/api/interviews/") and method == "DELETE":
                parts = [part for part in parsed.path.split("/") if part]
                if len(parts) != 3:
                    raise ValueError("删除路径格式错误")
                _, _, interview_id = parts
                with_state(lambda workspace, state, config: delete_interview(workspace, state, interview_id), workspace_override)
                self.send_json({"ok": True})
                return
            if parsed.path == "/api/run/resume-analysis" and method == "POST":
                def run_resume(workspace, state, config):
                    runtime_config = runtime_config_with_provider(config, payload.get("provider_id"))
                    resume = find_asset(state, "resume", payload["resume_asset_id"])
                    projects = project_assets_from_ids(state, payload.get("project_asset_ids", []))
                    skill_text = read_skill("resume_analysis")
                    prompt = build_resume_analysis_prompt(resume, projects)
                    content = call_model(
                        "resume_analysis",
                        prompt,
                        runtime_config,
                        demo_resume_analysis,
                        (resume, projects, runtime_config),
                        skill_text=skill_text,
                    )
                    return create_run(
                        workspace,
                        state,
                        runtime_config,
                        "resume_analysis",
                        "简历分析",
                        content,
                        {
                            "resume_asset_id": resume["id"],
                            "project_asset_ids": [project["id"] for project in projects],
                        },
                    )

                run = with_state(run_resume, workspace_override)
                self.send_json({"ok": True, "data": normalize_run_item(run)})
                return
            if parsed.path == "/api/interview/start-stream" and method == "POST":
                self.begin_stream()
                self.send_stream_event("ack", {"status": "starting"})
                try:
                    result = with_state(lambda workspace, state, config: start_interview_session(workspace, state, config, payload), workspace_override)
                    assistant_text = (result["messages"][-1].get("content", "") if result.get("messages") else "")
                    for fragment in stream_text_fragments(assistant_text):
                        if fragment:
                            self.send_stream_event("delta", {"delta": fragment})
                            time.sleep(0.012)
                    self.send_stream_event(
                        "complete",
                        {
                            "interview": normalize_interview(result["interview"]),
                            "messages": result["messages"],
                        },
                    )
                except Exception as exc:
                    self.send_stream_event("error", {"error": str(exc)})
                return

            if parsed.path == "/api/interview/start" and method == "POST":
                result = with_state(lambda workspace, state, config: start_interview_session(workspace, state, config, payload), workspace_override)
                self.send_json({"ok": True, "data": {"interview": normalize_interview(result["interview"]), "messages": result["messages"]}})
                return
            if parsed.path == "/api/interview/reply-stream" and method == "POST":
                self.begin_stream()
                self.send_stream_event("ack", {"status": "replying"})
                try:
                    result = with_state(lambda workspace, state, config: reply_interview_session(workspace, state, config, payload), workspace_override)
                    assistant_text = (result["messages"][-1].get("content", "") if result.get("messages") else "")
                    for fragment in stream_text_fragments(assistant_text):
                        if fragment:
                            self.send_stream_event("delta", {"delta": fragment})
                            time.sleep(0.012)
                    self.send_stream_event(
                        "complete",
                        {
                            "interview": normalize_interview(result["interview"]),
                            "messages": result["messages"],
                        },
                    )
                except Exception as exc:
                    self.send_stream_event("error", {"error": str(exc)})
                return

            if parsed.path == "/api/interview/reply" and method == "POST":
                result = with_state(lambda workspace, state, config: reply_interview_session(workspace, state, config, payload), workspace_override)
                self.send_json({"ok": True, "data": {"interview": normalize_interview(result["interview"]), "messages": result["messages"]}})
                return
            if parsed.path == "/api/interview/end" and method == "POST":
                def finish_interview(workspace, state, config):
                    interview = find_interview(state, payload["interview_id"])
                    provider_id = payload.get("provider_id") or interview.get("provider_id")
                    runtime_config = ensure_runtime_timeout(runtime_config_with_provider(config, provider_id), 180)
                    data = load_interview_data(interview)
                    closing_note = (payload.get("closing_note") or "").strip()
                    if closing_note:
                        data.setdefault("messages", []).append({"role": "user", "content": closing_note})
                    interview["status"] = "completed"
                    interview["updated_at"] = now_iso()
                    save_interview_data(interview, data)
                    persist_markdown(Path(interview["transcript_path"]), interview_transcript_markdown(interview, data, runtime_config))
                    skill_text = read_skill("interview_review")
                    prompt = build_interview_review_prompt(interview, data, state)
                    content = call_model(
                        "interview_review",
                        prompt,
                        runtime_config,
                        demo_interview_evaluation,
                        (interview, runtime_config),
                        skill_text=skill_text,
                    )
                    content = normalize_interview_review_content(interview, content)
                    run = create_run(
                        workspace,
                        state,
                        runtime_config,
                        "interview_review",
                        interview_review_run_title(interview),
                        content,
                        {
                            "interview_id": interview["id"],
                            "resume_asset_id": interview["resume_asset_id"],
                            "project_asset_ids": interview.get("project_asset_ids", []),
                            "transcript_path": interview["transcript_path"],
                        },
                    )
                    interview["review_run_id"] = run["id"]
                    return {"interview": interview, "review_run": run}

                result = with_state(finish_interview, workspace_override)
                self.send_json(
                    {
                        "ok": True,
                        "data": {
                            "interview": normalize_interview(result["interview"]),
                            "review_run": normalize_run_item(result["review_run"]),
                        },
                    }
                )
                return
            if parsed.path == "/api/run/interview-review" and method == "POST":
                def rerun_review(workspace, state, config):
                    runtime_config = ensure_runtime_timeout(runtime_config_with_provider(config, payload.get("provider_id")), 180)
                    interview = find_interview(state, payload["interview_id"])
                    data = load_interview_data(interview)
                    skill_text = read_skill("interview_review")
                    content = call_model(
                        "interview_review",
                        build_interview_review_prompt(interview, data, state),
                        runtime_config,
                        demo_interview_evaluation,
                        (interview, runtime_config),
                        skill_text=skill_text,
                    )
                    content = normalize_interview_review_content(interview, content)
                    run = create_run(
                        workspace,
                        state,
                        runtime_config,
                        "interview_review",
                        interview_review_run_title(interview),
                        content,
                        {
                            "interview_id": interview["id"],
                            "resume_asset_id": interview["resume_asset_id"],
                            "project_asset_ids": interview.get("project_asset_ids", []),
                            "transcript_path": interview["transcript_path"],
                        },
                    )
                    interview["review_run_id"] = run["id"]
                    interview["updated_at"] = now_iso()
                    return run

                run = with_state(rerun_review, workspace_override)
                self.send_json({"ok": True, "data": normalize_run_item(run)})
                return
            if parsed.path == "/api/run/learning" and method == "POST":
                def run_learning(workspace, state, config):
                    runtime_config = ensure_runtime_timeout(runtime_config_with_provider(config, payload.get("provider_id")), 240)
                    run_item = next((item for item in state["runs"] if item["id"] == payload["review_run_id"]), None)
                    if not run_item:
                        raise KeyError("未找到面试评价文档")
                    evaluation_text = Path(run_item["path"]).read_text(encoding="utf-8")
                    project_ids = payload.get("project_asset_ids", run_item.get("source", {}).get("project_asset_ids", []))
                    projects = project_assets_from_ids(state, project_ids)
                    transcript_text = ""
                    interview_id = run_item.get("source", {}).get("interview_id")
                    if interview_id:
                        interview = find_interview(state, interview_id)
                        transcript_text = Path(interview["transcript_path"]).read_text(encoding="utf-8")
                    skill_text = read_skill("learning")
                    content = call_model(
                        "learning",
                        build_learning_prompt(evaluation_text, projects, transcript_text),
                        runtime_config,
                        demo_learning,
                        (evaluation_text, runtime_config),
                        skill_text=skill_text,
                    )
                    content = normalize_learning_content(run_item, state, content)
                    run = create_run(
                        workspace,
                        state,
                        runtime_config,
                        "learning",
                        learning_run_title(run_item, state),
                        content,
                        {
                            "review_run_id": run_item["id"],
                            "project_asset_ids": [project["id"] for project in projects],
                            "interview_id": interview_id or "",
                        },
                    )
                    knowledge_path = workspace / MODULE_DIRECTORIES["learning"] / "面试知识总结.md"
                    knowledge_section = f"{content.rstrip()}\n\n---\n"
                    with knowledge_path.open("a", encoding="utf-8") as handle:
                        handle.write(knowledge_section)
                    return run

                run = with_state(run_learning, workspace_override)
                self.send_json({"ok": True, "data": normalize_run_item(run)})
                return
            if parsed.path == "/api/run/open-source" and method == "POST":
                def run_open_source(workspace, state, config):
                    runtime_config = runtime_config_with_provider(config, payload.get("provider_id"))
                    project = find_asset(state, "project", payload["project_asset_id"])
                    template = payload.get("template", "")
                    skill_text = read_skill("open_source_reading")
                    content = call_model(
                        "open_source_reading",
                        build_open_source_prompt(project, template),
                        runtime_config,
                        demo_open_source,
                        (project, template, runtime_config),
                        skill_text=skill_text,
                    )
                    return create_run(
                        workspace,
                        state,
                        runtime_config,
                        "open_source_reading",
                        f"{project['name']}-解读",
                        content,
                        {
                            "project_asset_id": project["id"],
                            "template": template,
                        },
                        preferred_name=f"{project['name']}-解读",
                    )

                run = with_state(run_open_source, workspace_override)
                self.send_json({"ok": True, "data": normalize_run_item(run)})
                return
            if parsed.path == "/api/comment" and method == "POST":
                def run_comment(workspace, state, config):
                    target = Path(payload["path"])
                    if not target.exists():
                        raise FileNotFoundError(f"文件不存在: {target}")
                    comment = (payload.get("comment") or "").strip()
                    if not comment:
                        raise ValueError("批注不能为空")
                    document_text = target.read_text(encoding="utf-8")
                    module_key = "resume_analysis"
                    extra_context = ""
                    matching_run = next((item for item in state["runs"] if Path(item["path"]) == target), None)
                    if matching_run:
                        module_key = matching_run["module_key"]
                        source = matching_run.get("source", {})
                        if source.get("resume_asset_id"):
                            resume = find_asset(state, "resume", source["resume_asset_id"])
                            extra_context += f"关联简历：\n```markdown\n{resume_text_from_asset(resume)}\n```\n\n"
                        project_ids = source.get("project_asset_ids", [])
                        if project_ids:
                            extra_context += project_context_from_ids(state, project_ids, max_files=8)
                        if source.get("interview_id"):
                            interview = find_interview(state, source["interview_id"])
                            extra_context += (
                                f"\n\n关联面试记录：\n```markdown\n"
                                f"{Path(interview['transcript_path']).read_text(encoding='utf-8')}\n```"
                            )
                    runtime_config = runtime_config_with_provider(config, source.get("provider_id") if matching_run else None)
                    skill_text = read_skill(module_key) if module_key in SKILL_PATHS else ""
                    reply = call_model(
                        module_key,
                        build_comment_prompt(module_key, document_text, comment, extra_context),
                        runtime_config,
                        demo_comment_reply,
                        (comment, document_text, runtime_config),
                        skill_text=skill_text if skill_text else None,
                    )
                    appendix = (
                        f"\n\n## 批注回复 {iso_label()}\n"
                        f"批注：{comment}\n\n"
                        f"{reply}\n"
                    )
                    with target.open("a", encoding="utf-8") as handle:
                        handle.write(appendix)
                    state["active_document"] = str(target)
                    return {"path": str(target), "content": target.read_text(encoding="utf-8")}

                result = with_state(run_comment, workspace_override)
                self.send_json({"ok": True, "data": result})
                return
            if parsed.path == "/api/document/apply-inline-comments" and method == "POST":
                def apply_inline_comments(workspace, state, config):
                    target = Path(payload.get("path") or "")
                    if not str(target):
                        raise ValueError("缺少 path")
                    if not target.exists():
                        raise FileNotFoundError(f"文件不存在: {target}")
                    annotated_content = payload.get("content")
                    if annotated_content is None:
                        raise ValueError("缺少 content")
                    if not has_inline_comment_markers(annotated_content):
                        raise ValueError("未检测到内联批注，请先在源码中写入 `批注：...` 或 `<!-- 批注：... -->`")
                    original_text = target.read_text(encoding="utf-8")
                    context = resolve_document_context(state, target)
                    runtime_config = ensure_runtime_timeout(
                        runtime_config_with_provider(config, context.get("provider_id") or payload.get("provider_id")),
                        180,
                    )
                    module_key = context.get("module_key", "resume_analysis")
                    skill_text = read_skill(module_key) if module_key in SKILL_PATHS else ""
                    revised = call_model(
                        module_key,
                        build_inline_comment_prompt(module_key, original_text, annotated_content, context.get("extra_context", "")),
                        runtime_config,
                        demo_inline_comment_apply,
                        (original_text, annotated_content, runtime_config),
                        skill_text=skill_text if skill_text else None,
                    )
                    revised = strip_outer_markdown_fence(revised).rstrip() + "\n"
                    target.write_text(revised, encoding="utf-8")
                    state["active_document"] = str(target)
                    return {"path": str(target), "content": revised}

                result = with_state(apply_inline_comments, workspace_override)
                self.send_json({"ok": True, "data": result})
                return
            self.send_error_json("未知 API", status=404)
        except Exception as exc:
            self.send_error_json(str(exc), status=500)


def run_server(host: str = "127.0.0.1", port: int = 8765) -> None:
    ensure_workspace(load_config())
    STATIC_ROOT.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((host, port), AppHandler)
    print(f"Interview-Assistant已启动: http://{host}:{port}")
    print(f"工作区: {workspace_path_from()}")
    server.serve_forever()


if __name__ == "__main__":
    run_server()
