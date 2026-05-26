/**
 * Copyright (c) 2026 DualMind Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * settings-validator —— Settings 文件写保护（§8.11.3）
 *
 * 职责：
 * - search_replace / write_file 在写入 .vscode/*.json 等配置前做 JSON 预校验
 * - 不合法则拒绝写入，返回清晰的错误提示
 * - 不对非 settings 文件产生副作用
 */

export interface SettingsValidationResult {
  valid: boolean;
  errorMessage?: string;
  /** 模拟替换后的完整内容（JSON 格式化后的版本） */
  mergedContent?: string;
}

/** 目标文件路径模式配表 */
const SETTINGS_PATTERNS: Array<{ dirPrefix: string; ext: string }> = [
  // .vscode/settings.json 及同级所有 JSON
  { dirPrefix: '.vscode', ext: '.json' },
  // DualMind 配置文件
  { dirPrefix: '.dualmind', ext: '.yaml' },
];

/**
 * 判断文件绝对路径是否匹配 SETTINGS_PATTERNS。
 * 匹配规则：路径中包含 `/{dirPrefix}/` 且以 `{ext}` 结尾。
 */
export function isSettingsFile(absPath: string): boolean {
  const normalized = absPath.replace(/\\/g, '/');
  for (const p of SETTINGS_PATTERNS) {
    if (normalized.includes(`/${p.dirPrefix}/`) && normalized.endsWith(p.ext)) {
      return true;
    }
  }
  return false;
}

/**
 * 对 settings JSON 文件做预写校验。
 *
 * @param filePath 目标文件绝对路径
 * @param content 写入后的完整内容（search_replace 已替换后的版本，或 write_file 的完整新内容）
 * @returns 校验结果
 */
export function validateSettingsEdit(filePath: string, content: string): SettingsValidationResult {
  if (!isSettingsFile(filePath)) {
    return { valid: true };
  }

  // YAML 文件暂不做严格校验（未来可扩展 js-yaml）
  if (filePath.endsWith('.yaml')) {
    return { valid: true };
  }

  try {
    JSON.parse(content);
    return { valid: true, mergedContent: content };
  } catch (e) {
    const msg = e instanceof SyntaxError ? e.message : String(e);
    return {
      valid: false,
      errorMessage: `写入 ${filePath} 的内容不是合法 JSON：${msg}`,
    };
  }
}
