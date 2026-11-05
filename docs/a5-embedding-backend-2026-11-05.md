# A5：向量记忆的 embedding 后端（2026-11-05）

## 一、为什么原来没有后端可用

`src/memory/embedding.ts` 的 `OllamaEmbedder` 打的是 **Ollama 专有端点**
`POST {base}/api/embed`，响应形状 `{embeddings: number[][]}`。而本机现有的两套
对话模型都不提供 embedding：

| 端点 | 实测结果 |
|---|---|
| NInfer `POST :18200/v1/embeddings` | **404**；`/v1/models` 的 `output_modalities` 只有 `text` |
| Strata `POST :8080/v1/embeddings` | **404 `{"error":{"message":"not found"}}`** |

博士已弃用 Ollama 做对话模型 → 向量路没有后端可用。这是 A5 的阻塞点。

## 二、选型

| 方向 | 结论 |
|---|---|
| 核显跑 bge-m3 | **否决**。9800X3D 的 iGPU 只有 2 CU（~0.5 TFLOPS），8 核 AVX-512 CPU 约 0.9 TFLOPS；两者共用同一套 DDR5-4800 带宽。核显不可能更快 |
| 独显（RTX 5080）跑 embedding | 需 1–2 GB 显存，而 NInfer 启动后 `free` 仅 716 MiB（实测），与主模型互斥 |
| 云端 embedding | 违反「不调 key、数据不出境」 |
| **llama.cpp CPU + bge-m3 GGUF** | **采用** |

## 三、落地

- 二进制：`llama-b12128-bin-win-cpu-x64.zip`（GitHub release，走代理 7892，23.6 MB / 31s）
  → `C:\local-llm\llama-cpp\`
- 模型：**没有下载**。Ollama 的 bge-m3 模型层本身就是 GGUF（blob
  `sha256-daec91ff…`，1.08 GiB，魔数 `GGUF`），直接复制为 `bge-m3.gguf`。
- 启动：

  ```sh
  cd C:/local-llm/llama-cpp
  ./llama-server.exe -m bge-m3.gguf --embedding --host 127.0.0.1 --port 11435 -c 8192 -t 8
  ```

- 代码：新增 `OpenAiCompatibleEmbedder`（`src/memory/embedding.ts`），走
  `POST /v1/embeddings`，解析 `{data: [{embedding}]}`。启动接线在
  `src/runtime/start.ts`：

  ```sh
  PRTS_EMBED=1 PRTS_EMBED_BACKEND=openai PRTS_EMBED_URL=http://127.0.0.1:11435
  ```

  默认仍是 `ollama`，既有行为不变。

## 四、实测

| 项 | 值 |
|---|---|
| 维度 | **1024**（与 Ollama 侧 bge-m3 一致 → 向量表无需重算） |
| 单条 | 40 ms（含首次请求） |
| 批量 20 条 | 451 ms，**22.6 ms/条** |
| 与检索链路对比 | V1-16 装配 p50 396ms / p95 815ms，嵌入占比约 5% |

## 五、边界（未验证的部分）

- **向量路对检索质量的贡献仍未量化**。`scripts/eval-longmemeval-retrieval.mjs`
  调 `store.search()` 时不传 `queryVector`，所以 V1-17 的 45.1% 是**纯字面成绩**，
  向量一分未计。要判断值不值得开，还需要一次带向量的对照跑。
- 后端服务不常驻（与两套对话模型不同，它只占 CPU），需要时手动起。
- `--embedding` 模式下 llama-server 不做生成；同一进程不能兼作对话模型。
