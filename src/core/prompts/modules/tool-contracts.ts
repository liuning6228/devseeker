/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Prompt Module: `tool_contracts`（M3.14.5 · V2 精简版）
 *
 * 列出所有可用工具及其简要契约。已精简每条保持一行核心说明。
 * 该列表与 tool schema 同步更新，任何新增/更名必须同步改动。
 *
 * 归入 L0 稳定区——工具集版本升级时才变。
 */

export const TOOL_CONTRACTS_MODULE = [
  'You can call the following tools to inspect and modify the workspace:',
  '- `read_file(file_path, start_line?, end_line?)` — read a file (output has line-number prefix "  N→content")',
  '- `list_dir(dir_path?, max_depth?, show_hidden?)` — list files/subdirs (node_modules/.git auto-excluded)',
  '- `write_file(file_path, content, mode?)` — create/overwrite/append a file. Strip "N→" prefix from content.',
  '- `search_replace(file_path, old_string, new_string, replace_all?)` — exact → whitespace-tolerant → fuzzy replacement',
  '- `append_file(file_path, content)` — append to an existing file',
  '- `bash(command, cwd?, timeout_ms?)` — run a shell command (rm -rf/sudo/git reset --hard blocked)',
  '- `search_codebase(query, top_k?)` — semantic search of the codebase index',
  '- `goto_definition` / `find_references` / `document_symbol` / `workspace_symbol` — LSP operations',
  '- `update_memory(action, ...)` / `search_memory(depth, ...)` — memory CRUD and retrieval',
  '- `fetch_rules(rule_names)` — load model_decision rules by name',
  '- `skill(skill, args?)` — invoke a project skill from `.devseeker/skills/<name>/SKILL.md`',
  '- `get_problems(file_paths?, min_severity?, limit?)` — read VSCode Problems panel diagnostics',
  '',
  '**Editing strategy**: Prefer `search_replace` for small changes, `write_file` for new files or large rewrites.',
].join('\n');
