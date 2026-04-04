# Interview Assistant

本项目是一个本地可运行的网页版面试助手，聚焦大模型应用开发 / Agent 应用开发岗位，支持以下能力：

1. 简历分析
2. 模拟面试
3. 面试评价
4. 从评价中学习
5. 开源项目阅读
6. 模型配置、素材库、历史记录和 Markdown 落盘

## 运行方式

### 方式一：双击启动
直接运行 `start_app.bat`。

### 方式二：命令行启动

```powershell
cd .\interview_assistant
python server.py
```

服务启动后，在浏览器打开：

```text
http://127.0.0.1:8765
```

## 说明

1. 默认是 `Demo` 模式，不需要 API Key 就能体验完整流程。
2. “模型配置”页支持保存多个供应商配置，并在各模块表单里单独选择当前要使用的模型。
   - 如果选择的模型是 ClaudeCode ，在 `Reasoning` 栏里不填
3. `temperature`、`max_tokens`、`reasoning_effort`、`timeout_seconds` 可以留空，留空时不会主动传给模型接口。
4. 需要配置 `workspace`路径，后续可以在“模型配置”页改成其他本地路径。
5. 如果项目目录很大，例如上千个文件，建议在“素材库”页使用“按本地路径导入”，不要走浏览器目录上传。
6. 模拟面试支持浏览器原生语音转文字，推荐使用最新版 Edge / Chrome。
7. 历史记录页支持直接编辑 Markdown 原文并保存。
