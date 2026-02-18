# 快速启动指南

## 1. 安装依赖

```bash
# 安装后端依赖
cd backend
poetry install

# 或者使用 pip
pip install -r requirements.txt

# 安装前端依赖
cd ../frontend
npm install
```

## 2. 配置环境变量

复制 `.env.example` 为 `.env` 并填写配置：

### 使用 MiniMax (推荐)

```bash
# .env 配置
LLM_PROVIDER=minimax
REMOTE_LLM_ENABLED=true
MINIMAX_API_KEY=your-minimax-api-key
MINIMAX_MODEL=MiniMax-M2.5

# Embedding 配置
EMBEDDING_MODEL=embo-01
EMBEDDING_DIMENSION=1024
REMOTE_EMBEDDING_ENABLED=false
```

### 使用 OpenAI (备选)

```bash
# .env 配置
LLM_PROVIDER=openai
REMOTE_LLM_ENABLED=true
OPENAI_API_KEY=sk-your-openai-api-key
OPENAI_MODEL=gpt-4-turbo-preview

# Embedding 配置
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536
```

### 使用 DeepSeek (流式友好)

```bash
# .env 配置
LLM_PROVIDER=deepseek
REMOTE_LLM_ENABLED=true
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat

# Embedding 配置（建议仍用 MiniMax/OpenAI；未配置时自动离线回退）
EMBEDDING_MODEL=embo-01
EMBEDDING_DIMENSION=1024
REMOTE_EMBEDDING_ENABLED=false
```

提示：如果你不写 `REMOTE_LLM_ENABLED`，后端会在检测到可用 API Key 时自动启用远程模式。

## 3. 获取 MiniMax API 密钥

1. 访问 https://platform.minimaxi.com/
2. 注册/登录账号
3. 在控制台获取 API Key
4. 确保账户有足够的配额

## 4. 启动服务

```bash
# 启动后端 (在 backend 目录，推荐多 worker 防止生文阻塞读接口)
API_WORKERS=2 ./scripts/run_api.sh

# 启动前端 (在 frontend 目录)
npm run dev
```

可选日志配置（`backend/.env`）：

```bash
LOG_LEVEL=INFO
ENABLE_HTTP_LOGGING=true
LOG_FILE=../data/logs/app.log
```

## 5. 访问应用

打开浏览器访问 http://localhost:3000

验证是否真的在走远程模型：

```bash
curl http://127.0.0.1:8000/api/runtime/llm
```

关键字段应满足：
- `remote_effective: true`
- `remote_ready: true`
- `effective_provider` 与你期望的一致

## 6. 使用流程（新版单工作台）

1. **选择项目** - 顶部下拉直接切换，或点“新建项目”即时创建。
2. **一句话输入** - 在页面底部输入小说核心冲突与目标。
3. **点“开始生成”** - 默认即可跑通，模式/范围可用芯片快速切换。
4. **看中间正文流** - Markdown 正文在主区域持续更新，章节开始即有占位提示。
5. **右侧查看状态** - “任务”页看章节结果和日志，“记忆”页维护 L1，“调试”页看 Prompt 约束。

## 7. 调试接口（推荐）

```bash
# 查看当前模型运行状态
curl http://127.0.0.1:8000/api/runtime/llm

# 流式整卷/整本生成（SSE）
curl -N -X POST "http://127.0.0.1:8000/api/projects/<project_id>/one-shot-book/stream" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"主角在雪夜被背叛后潜伏反击","mode":"studio","scope":"volume","chapter_count":4,"words_per_chapter":1600,"auto_approve":true}'

# 查看 Prompt 和约束预览
curl -X POST "http://127.0.0.1:8000/api/projects/<project_id>/prompt-preview" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"主角在雪夜被背叛后潜伏反击","mode":"studio","scope":"volume","chapter_count":4,"target_words":1600}'
```

## 支持的模型

### MiniMax (文本)
- `MiniMax-M2.5` - 顶尖性能 (约 60 TPS)
- `MiniMax-M2.5-highspeed` - 极速版 (约 100 TPS)
- `MiniMax-M2.1` - 编程能力强
- `MiniMax-M2.1-highspeed` - 极速版

### Embedding
- `embo-01` - MiniMax 嵌入模型 (1024维)

### OpenAI (备选)
- `gpt-4-turbo-preview`
- `gpt-4`
- `text-embedding-3-small`

### DeepSeek
- `deepseek-chat`

## 故障排除

### API 调用失败
- 检查 API Key 是否正确
- 确保账户有足够配额
- 查看日志中的具体错误信息

### Embedding 服务报错
- 确保 `EMBEDDING_MODEL` 与 provider 匹配
- MiniMax 使用 `embo-01`，OpenAI 使用 `text-embedding-3-small`
- 本地优先模式下保持 `REMOTE_EMBEDDING_ENABLED=false` 可获得更稳定速度

### 前端无法连接后端
- 检查后端是否运行在正确端口 (默认 8000)
- 检查 Vite 代理配置
