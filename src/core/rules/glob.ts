/**
 * Copyright (c) 2026 DevSeeker Contributors
 *
 * MIT License - see LICENSE file for details
 */

/**
 * Glob 匹配（W4 批次 3）
 *
 * 实现一个零依赖 minimatch 子集，支持：
 * - `*`     匹配除 `/` 外任意字符
 * - `**`    匹配任意层级（含 `/`）
 * - `?`     匹配单个非 `/` 字符
 * - `[abc]` 字符类
 * - 其他正则元字符一律转义
 *
 * 路径统一用 `/` 作为分隔符；如果 pattern 不含 `/`，默认在任意目录下匹配（前置 `**\u002a/`）。
 */

/** 归一化为 POSIX 路径 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 把 glob pattern 编译为 RegExp（anchored） */
export function globToRegex(pattern: string): RegExp {
  let p = pattern.trim();
  if (!p) return /$.^/; // 空模式永不匹配
  // 不含 `/` 的模式：默认允许任意目录前缀
  if (!p.includes('/')) {
    p = '**/' + p;
  }

  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` 匹配 0 ~ N 层目录（含空）
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      // 简单字符类：直到 `]`
      const end = p.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
      } else {
        re += p.slice(i, end + 1);
        i = end;
      }
    } else if ('.+^$(){}|\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** 单次匹配 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const fp = toPosixPath(filePath).replace(/^\.\//, '');
  return globToRegex(pattern).test(fp);
}

/** 任一 pattern 命中即 true */
export function matchAnyGlob(patterns: string[], filePath: string): boolean {
  return patterns.some((p) => matchGlob(p, filePath));
}
