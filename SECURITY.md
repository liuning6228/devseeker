# Security Policy

## Reporting a Vulnerability

DevSeeker 重视安全性。如发现安全漏洞，**请勿公开提交 Issue**。

请通过以下方式私下报告：

- 在 GitHub 上通过 **Security Advisories** 页面提交：`https://github.com/liuning6228/devseeker/security/advisories`

我们承诺：

1. **48 小时内**确认收到报告
2. 评估并确定修复优先级，**14 天内**给出修复计划
3. 修复完成后公开发布安全公告

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | ✅                 |
| < latest| ❌                 |

## Security Considerations

### API Key 安全

DevSeeker 的 LLM / VLLM API Key 存储在 VSCode SecretStorage 中，**不会**写入日志、文件或网络请求。Webview 与扩展端之间通过 `postMessage` 通信，不暴露 Key。

### 沙箱隔离

所有 bash 命令在沙箱终端内执行，受 SSRF 防护和命令黑名单保护。确认弹窗机制防止意外写入。

### 依赖安全

我们定期扫描依赖（`npm audit`）并更新。如发现供应链安全问题，请按上方方式报告。
