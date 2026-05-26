/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * 通义生态适配 module（W13.2-C · Phase 3 续作）
 *
 * 命中信号：package.json 依赖含 `dashscope`、`@dashscope/*`、`qwen-agent`、`@alicloud/dashscope-*` 等。
 * 该 module 教 LLM 在「用户正在调用通义/Qwen API」的项目里如何正确生成集成代码。
 *
 * 与 DashScope 云厂商认知对齐到 2026-05-02：
 *   - OpenAI 兼容模式：`https://dashscope.aliyuncs.com/compatible-mode/v1`
 *   - 原生 DashScope：`https://dashscope.aliyuncs.com/api/v1`（非兼容模式，字段差异较大）
 *
 * 设计边界：
 *   - 只覆盖 Node.js / TypeScript 生态的调用规范；Python SDK 另起。
 *   - 不涉及通义灵码 IDE 插件配置（用户可自行在 VSCode 侧配，和 prompt 无关）。
 */

export const TONGYI_ECOSYSTEM_MODULE = [
  '## 通义 / Qwen 生态集成规范（DashScope Node SDK）',
  '',
  '### 选型：OpenAI 兼容模式 vs 原生 SDK',
  '- 首选 **OpenAI 兼容模式**：`baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"`，配合 `openai` 官方 SDK 即可。最大限度复用 OpenAI 生态的中间件/客户端库。',
  '- 仅当需要原生专有能力（如 `text-embedding-v3` 的某些高级参数、`qwen-vl-max` 的原生消息格式）时走 `dashscope` 原生 npm 包。',
  '- 同一项目中混用两种模式时，务必分别管理 client 实例，避免 baseURL 混淆。',
  '',
  '### 鉴权',
  '- 环境变量优先：`DASHSCOPE_API_KEY`（与官方 CLI 对齐）。',
  '- 代码中严禁硬编码 API Key；生成集成样例时必须用 `process.env.DASHSCOPE_API_KEY`。',
  '- `baseURL` 建议从 env 或 config 注入，便于切换到 VPC 专有端点。',
  '',
  '### 模型表（常用）',
  '- **对话**：`qwen-plus`（默认首选，性价比高）/ `qwen-max`（能力最强）/ `qwen-turbo`（低延迟）/ `qwen-long`（长上下文 10M）。',
  '- **推理**：`qwen-plus-latest`（含 thinking）/ `qwq-plus`（专用推理模型）。',
  '- **视觉**：`qwen-vl-max`（多模态首选）/ `qwen-vl-plus`（性价比版）。',
  '- **向量**：`text-embedding-v3`（1024 维，支持 `dimensions` 参数降维）/ `text-embedding-v2`（兼容 1536 维）。',
  '- **规避**：不要生成已下线模型的示例（如 `qwen-turbo-0624`、`text-embedding-v1`）——2026 后多已停服。',
  '',
  '### 参数差异与兼容陷阱',
  '- OpenAI 兼容模式下 **不支持** OpenAI 原生的 `logprobs` / `top_logprobs` / `seed` 等参数；传入会被忽略或报 400。',
  '- `temperature` 有效范围 `[0, 2]`，但通义建议 `[0, 1]`；超出 1 时生成质量下降明显。',
  '- `response_format: { type: "json_object" }` 在兼容模式下可用但需在 prompt 里显式说明 "JSON 输出"，否则模型可能返回普通文本。',
  '- DeepSeek 等走兼容模式第三方模型时的 `reasoning_content` 字段，Qwen 系列同样会出现（thinking 模式），解析端需兼容 `content` 为空字符串但含 `reasoning_content` 的情况。',
  '',
  '### 视觉消息格式（OpenAI 兼容模式）',
  '- 单条 user message 的 `content` 为数组：`[{ type: "text", text: "..." }, { type: "image_url", image_url: { url: "data:image/..." } }]`。',
  '- `image_url` 接受 DataURL（`data:image/png;base64,...`）或公网 HTTPS URL；本地路径不被接受。',
  '- 多张图片：多个 `image_url` part 顺序排列；qwen-vl-max 单请求建议 ≤ 10 张。',
  '- 生成调用示例时务必走 `qwen-vl-*` 系列——纯文本模型收到 image_url 会 400。',
  '',
  '### Function Calling',
  '- 兼容模式下格式对齐 OpenAI：`tools: [{ type: "function", function: { name, description, parameters } }]`。',
  '- Qwen 对 JSON Schema 的遵从度略低于 GPT-4：描述务必明确 required、enum；复杂嵌套结构建议先在 prompt 里给示例。',
  '- `tool_choice: "auto"` 是默认行为；强制走某工具时用 `tool_choice: { type: "function", function: { name: "xxx" } }`。',
  '',
  '### 流式响应',
  '- `stream: true` 返回 SSE 流，与 OpenAI 完全一致。',
  '- 最后一个 chunk 的 `usage` 字段只在 `stream_options: { include_usage: true }` 时返回；忘记加会导致成本统计丢失。',
  '',
  '### Pitfalls',
  '- **混淆 baseURL**：往 `compatible-mode/v1` 发原生 DashScope 格式（`input.messages`）会 404；反向亦然。',
  '- **硬编码模型版本号**：`qwen-max-2024-xx-xx` 这类快照版本会随时间下线，优先用别名 `qwen-max`。',
  '- **忘记 charset**：非 ASCII prompt 直接走 `Content-Type: application/json` 而未指定 `charset=utf-8` 时，某些代理会乱码。',
  '- **qwen-long 读文件**：长文档走 `file-id` 引用模式（先上传得到 fileid，再在 messages 引用），不能直接把 10M 文本塞进 content。',
].join('\n');
