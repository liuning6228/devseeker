import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { ModeStatusPayload, ProviderStatusPayload, ContextSearchItem, SkillInfo } from '../protocol';
import { ContextPicker } from './ContextPicker';
import { getVsCodeApi } from '../vscode-api';

export interface ComposerProps {
  disabled: boolean;
  isRunning: boolean;
  /** W7c · 新签名：可附带 DataURL 图片数组（截图粘贴） */
  onSend: (text: string, images?: string[]) => void;
  onAbort: () => void;
  /** W12.1 · Inline Edit 草稿推送；nonce 变化时将 text 拼接到输入框末尾 */
  prefill?: { text: string; nonce: number; isInlineEdit?: boolean };
  // ---------- W-UI1 · 内嵌 Agent / 模型下拉 + 上方成本薄条 ----------
  /** 当前 provider 状态（顶部原有） */
  provider?: ProviderStatusPayload;
  onSelectProvider?: (providerId: string | null) => void;
  /** 当前 mode 状态 */
  mode?: ModeStatusPayload;
  onSelectMode?: (mode: 'agent' | 'plan' | 'debug' | 'ask') => void;
  /** 成本文本（如 `本次 ¥0.003 · cache 42%`） */
  cost?: string;
  /** usage 文本（如 `in 12 · out 340`） */
  usage?: string;
  /** Context 徽章 JSX（由 App.tsx 渲染后传入，避免 Composer 直接导入 reducer 内部类型） */
  contextBadge?: ReactNode;
  /** 当前会话已用 token 数（用于 CTX 进度条） */
  usedTokens?: number;
  /** token 总限额 */
  totalTokens?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 单张图片的大小上限（≈10MB DataURL）—— 避免 Webview postMessage 过大 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 同时最多附带几张图 */
const MAX_IMAGES = 6;

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}

export function Composer({
  disabled,
  isRunning,
  onSend,
  onAbort,
  prefill,
  provider,
  onSelectProvider,
  mode,
  onSelectMode,
  cost,
  usage,
  contextBadge,
  usedTokens = 0,
  totalTokens = 1_048_576,
}: ComposerProps): JSX.Element {
  const ctxRatio = totalTokens > 0 ? (usedTokens / totalTokens) * 100 : 0;
  const [text, setText] = useState('');
  /** W7c · 当前已粘贴待发送的图片 DataURL 列表 */
  const [images, setImages] = useState<string[]>([]);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** W12.1 · 记录已消费的 prefill nonce，避免 React StrictMode / re-render 重复追加 */
  const lastPrefillNonceRef = useRef<number | null>(null);
  /** W15.4 · 当前是否处于 Inline Edit 模式（由 prefill.isInlineEdit 设置，发送后重置） */
  const [isInlineEditMode, setIsInlineEditMode] = useState(false);

  // ─── Step 1: 输入历史管理 ───
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draftSaved, setDraftSaved] = useState('');
  // Step 6: 模式切换确认弹窗
  const [pendingModeSwitch, setPendingModeSwitch] = useState<{ from: string; to: string } | null>(null);
  // Step 7: @ 上下文选择器
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextQuery, setContextQuery] = useState('');
  // Step 12: / 命令菜单
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [skills, setSkills] = useState<SkillInfo[]>([]);

  // Step 12: 加载 Skill 列表
  useEffect(() => {
    getVsCodeApi().postMessage({ type: 'get_skills' });
    const handler = (ev: MessageEvent) => {
      if (ev.data?.type === 'skill_list') setSkills(ev.data.skills || []);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // W12.1 · 当 prefill.nonce 变化时，将 text 拼接到 textarea 末尾（已有内容 → 空行分隔）
  useEffect(() => {
    if (!prefill) return;
    if (lastPrefillNonceRef.current === prefill.nonce) return;
    lastPrefillNonceRef.current = prefill.nonce;
    setText((prev) => (prev.length > 0 ? prev + '\n\n' + prefill.text : prefill.text));
    // W15.4 · 标记 Inline Edit 模式
    if (prefill.isInlineEdit) {
      setIsInlineEditMode(true);
    }
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        // 某些环境不支持 setSelectionRange，忽略
      }
    });
  }, [prefill]);

  // 自适应高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [text]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    // Step 1: 将输入存入历史（去重，限制 50 条）
    if (trimmed) {
      setInputHistory((prev) => {
        const filtered = prev.filter((h) => h !== trimmed);
        return [...filtered, trimmed].slice(-50);
      });
    }
    setHistoryIndex(-1);
    setDraftSaved('');
    onSend(trimmed, images.length > 0 ? images : undefined);
    setText('');
    setImages([]);
    setPasteError(null);
    setIsInlineEditMode(false);
  }, [text, images, onSend]);

  const handleKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault();
        submit();
        return;
      }
      // Step 1: Ctrl+↑/↓ 导航输入历史（不拦截普通 ArrowUp/Down，保留 textarea 原生光标移动）
      if (ev.ctrlKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
        ev.preventDefault();
        if (inputHistory.length === 0) return;
        if (ev.key === 'ArrowUp') {
          if (historyIndex === -1) {
            setDraftSaved(text);
            setHistoryIndex(inputHistory.length - 1);
            setText(inputHistory[inputHistory.length - 1]);
          } else if (historyIndex > 0) {
            setHistoryIndex(historyIndex - 1);
            setText(inputHistory[historyIndex - 1]);
          }
        } else {
          if (historyIndex < inputHistory.length - 1) {
            setHistoryIndex(historyIndex + 1);
            setText(inputHistory[historyIndex + 1]);
          } else {
            setHistoryIndex(-1);
            setText(draftSaved);
          }
        }
      }
    },
    [submit, text, inputHistory, historyIndex, draftSaved],
  );

  const handlePaste = useCallback(
    async (ev: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = ev.clipboardData?.items;
      if (!items || items.length === 0) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0) return;
      ev.preventDefault();
      if (images.length + imageFiles.length > MAX_IMAGES) {
        setPasteError(`最多附带 ${MAX_IMAGES} 张图片（已附 ${images.length}）`);
        return;
      }
      try {
        const dataURLs: string[] = [];
        for (const file of imageFiles) {
          if (file.size > MAX_IMAGE_BYTES) {
            setPasteError(`图片过大：${(file.size / 1024 / 1024).toFixed(1)}MB > 8MB 上限`);
            return;
          }
          const url = await readFileAsDataURL(file);
          dataURLs.push(url);
        }
        setImages((prev) => [...prev, ...dataURLs]);
        setPasteError(null);
      } catch (err) {
        setPasteError(`读取图片失败：${String(err)}`);
      }
    },
    [images.length],
  );

  const handleFilesPicked = useCallback(
    async (ev: React.ChangeEvent<HTMLInputElement>) => {
      const files = ev.target.files;
      if (!files || files.length === 0) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.type.startsWith('image/')) imageFiles.push(f);
      }
      // 重置 input，以便同一文件重选可触发 change
      ev.target.value = '';
      if (imageFiles.length === 0) {
        setPasteError('请选择图片文件（png / jpg / webp）');
        return;
      }
      if (images.length + imageFiles.length > MAX_IMAGES) {
        setPasteError(`最多附带 ${MAX_IMAGES} 张图片（已附 ${images.length}）`);
        return;
      }
      try {
        const dataURLs: string[] = [];
        for (const file of imageFiles) {
          if (file.size > MAX_IMAGE_BYTES) {
            setPasteError(`图片过大：${(file.size / 1024 / 1024).toFixed(1)}MB > 8MB 上限`);
            return;
          }
          const url = await readFileAsDataURL(file);
          dataURLs.push(url);
        }
        setImages((prev) => [...prev, ...dataURLs]);
        setPasteError(null);
      } catch (err) {
        setPasteError(`读取图片失败：${String(err)}`);
      }
    },
    [images.length],
  );

  const insertToken = useCallback((token: string) => {
    const el = textareaRef.current;
    if (!el) {
      setText((prev) => (prev.length === 0 ? token : prev + token));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setText((prev) => prev.slice(0, start) + token + prev.slice(end));
    queueMicrotask(() => {
      el.focus();
      const pos = start + token.length;
      try {
        el.setSelectionRange(pos, pos);
      } catch { /* noop */ }
    });
  }, []);

  // Step 1: 拖拽文件/文本到 textarea
  const handleDrop = useCallback(
    async (ev: React.DragEvent<HTMLTextAreaElement>) => {
      const files = ev.dataTransfer?.files;
      if (!files || files.length === 0) return;
      ev.preventDefault();
      const imageFiles: File[] = [];
      const textFiles: File[] = [];
      for (let i = 0; i < files.length; i++) {
        if (files[i].type.startsWith('image/')) {
          imageFiles.push(files[i]);
        } else if (
          files[i].type.startsWith('text/') ||
          files[i].name.match(/\.(ts|tsx|js|jsx|json|md|py|go|rs|yaml|yml|toml|css|html|sh)$/)
        ) {
          textFiles.push(files[i]);
        }
      }
      // 图片拖拽
      for (const f of imageFiles) {
        if (f.size > MAX_IMAGE_BYTES) {
          setPasteError(`图片过大：${(f.size / 1024 / 1024).toFixed(1)}MB > 8MB 上限`);
          continue;
        }
        if (images.length >= MAX_IMAGES) {
          setPasteError(`最多附带 ${MAX_IMAGES} 张图片`);
          break;
        }
        const url = await readFileAsDataURL(f);
        setImages((prev) => [...prev, url]);
      }
      // 文本文件拖拽：读取内容并插入 textarea（作为代码块）
      for (const f of textFiles) {
        const content = await f.text();
        const snippet = content.slice(0, 2000); // 限制 2000 字符
        setText((prev) => prev + `\n\`\`\`${f.name}\n${snippet}\n\`\`\`\n`);
      }
      setPasteError(null);
    },
    [images.length],
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const canSend = !disabled && (text.trim().length > 0 || images.length > 0);

  // ---------- 下拉数据 ----------
  const providerAvailable = provider?.availableProviders ?? [];
  const providerPreferred = provider?.preferredProvider ?? '';
  const modeList = mode?.available ?? [];
  const currentMode = mode?.current ?? 'agent';

  // Step 7: 选择上下文后替换 @query 为引用文本
  const handleContextSelect = useCallback((item: ContextSearchItem) => {
    const el = textareaRef.current;
    const cursorPos = el?.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const lastAtIndex = beforeCursor.lastIndexOf('@');
    if (lastAtIndex >= 0) {
      const prefix = text.slice(0, lastAtIndex);
      const suffix = text.slice(cursorPos);
      const ref = item.type === 'file' ? `@${item.path}`
        : item.type === 'symbol' ? `@${item.path}#${item.name}`
        : `@memory:${item.name}`;
      setText(prefix + ref + ' ' + suffix);
    }
    setShowContextPicker(false);
    setContextQuery('');
    el?.focus();
  }, [text]);

  return (
    <div className="composer">
      <div className="composer-topbar" role="status" aria-label="会话成本与上下文">
        {usage && <span className="composer-topbar__usage">{usage}</span>}
        {cost && <span className="composer-topbar__cost">{cost}</span>}
        {/* CTX 区块：只有 contextBadge 有值时（即有上下文统计）才显示，含进度条和百分比 */}
        {contextBadge && (
          <span className="composer-topbar__ctx" title={`${usedTokens.toLocaleString()} / ${totalTokens.toLocaleString()} tokens`}>
            {contextBadge}
            <span className="composer-topbar__ctx-track" aria-hidden="true">
              <span className="composer-topbar__ctx-fill" style={{ width: `${Math.min(ctxRatio, 100)}%` }} />
            </span>
            <span className="composer-topbar__ctx-pct">
              {formatTokens(usedTokens)} / {formatTokens(totalTokens)}
            </span>
          </span>
        )}
      </div>
      {images.length > 0 && (
        <div className="composer__thumbs" role="list">
          {images.map((url, i) => (
            <div key={i} className="composer__thumb" role="listitem">
              <img src={url} alt={`粘贴图片 ${i + 1}`} className="composer__thumb-img" />
              <button
                type="button"
                className="composer__thumb-remove"
                onClick={() => removeImage(i)}
                aria-label={`移除图片 ${i + 1}`}
                title="移除"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {pasteError && (
        <div className="composer__paste-error" role="alert">
          {pasteError}
        </div>
      )}
      <textarea
        ref={textareaRef}
        className={`composer__input${isInlineEditMode ? ' composer__input--inline-edit' : ''}`}
        placeholder={isInlineEditMode ? '描述你想要的修改…（仅使用 search_replace / create_file）' : '规划与编程，@ 添加上下文，/ 使用命令'}
        value={text}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          const cursorPos = e.target.selectionStart ?? value.length;
          const beforeCursor = value.slice(0, cursorPos);
          // Step 7: @ 检测
          const lastAtIndex = beforeCursor.lastIndexOf('@');
          if (lastAtIndex >= 0 && !beforeCursor.slice(lastAtIndex).includes(' ')) {
            setContextQuery(beforeCursor.slice(lastAtIndex + 1));
            setShowContextPicker(true);
          } else {
            setShowContextPicker(false);
          }
          // Step 12: / 检测
          const lastSlashIndex = beforeCursor.lastIndexOf('/');
          if (lastSlashIndex >= 0 && !beforeCursor.slice(lastSlashIndex).includes(' ') && skills.length > 0) {
            setSlashQuery(beforeCursor.slice(lastSlashIndex + 1));
            setShowSlashMenu(true);
          } else {
            setShowSlashMenu(false);
          }
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDrop={handleDrop}
        disabled={disabled}
        rows={2}
      />
      {/* Step 7: @ 上下文选择器弹出层 */}
      {showContextPicker && (
        <ContextPicker
          query={contextQuery}
          onSelect={handleContextSelect}
          onClose={() => { setShowContextPicker(false); setContextQuery(''); }}
        />
      )}
      {/* Step 12: / 命令菜单弹出层 */}
      {showSlashMenu && (
        <div className="composer__slash-menu" role="listbox" aria-label="命令菜单">
          {skills
            .filter((s) => !slashQuery || s.name.toLowerCase().includes(slashQuery.toLowerCase()))
            .slice(0, 10)
            .map((s) => (
              <button key={s.name} className="composer__slash-item" role="option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const el = textareaRef.current;
                  if (!el) return;
                  const val = el.value;
                  const cursorPos = el.selectionStart ?? val.length;
                  const before = val.slice(0, cursorPos);
                  const slashIdx = before.lastIndexOf('/');
                  const prefix = slashIdx >= 0 ? val.slice(0, slashIdx) : '';
                  const suffix = val.slice(cursorPos);
                  const cmd = `/${s.name}${s.argsTemplate ? ` ${s.argsTemplate}` : ''}`;
                  setText(prefix + cmd + ' ' + suffix);
                  setShowSlashMenu(false);
                  el.focus();
                }}>
                <span className="composer__slash-icon">⚡</span>
                <span className="composer__slash-name">/{s.name}</span>
                <span className="composer__slash-desc">{s.description}</span>
              </button>
            ))}
        </div>
      )}
      <div className="composer__footer">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {/* 模式选择：始终显示，无数据时显示"智能体" */}
            <select
              className="composer__select"
              value={currentMode}
              title={
                mode?.lastChangeReason
                  ? `模式: ${currentMode} · 上次切换原因: ${mode.lastChangeReason}`
                  : `模式: ${currentMode}`
              }
              onChange={(e) => {
                const v = e.target.value as 'agent' | 'plan' | 'debug' | 'ask';
                // Step 6: 切换到不同模式时弹出确认对话框
                if (v !== currentMode) {
                  setPendingModeSwitch({ from: currentMode, to: v });
                }
              }}
              aria-label="选择智能体模式"
            >
              {modeList.length > 0
                ? modeList.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))
                : <option value="agent">智能体</option>
              }
            </select>
            {/* Provider 选择：始终显示，无数据时显示"自动" */}
            <select
              className="composer__select"
              value={providerPreferred ?? ''}
              title={provider?.routeReason ? `router: ${provider.routeReason}` : `provider: ${provider?.providerId ?? '-'}`}
              onChange={(e) => {
                const v = e.target.value;
                onSelectProvider?.(v === '' ? null : v);
              }}
              aria-label="选择模型"
            >
              <option value="">自动 ({provider?.providerId ?? '-'})</option>
              {providerAvailable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName ?? p.id}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={handleFilesPicked}
            />
            <button
              type="button"
              className="composer__icon-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              title="附件 / 图片上传（支持粘贴截图）"
              aria-label="上传图片"
            >
              🖼️
            </button>
            <button
              type="button"
              className="composer__icon-btn"
              onClick={() => insertToken('@')}
              disabled={disabled}
              title="添加上下文（@ 引用文件 / 符号）"
              aria-label="添加上上下文"
            >
              @
            </button>
            <button
              type="button"
              className="composer__icon-btn"
              onClick={() => insertToken('/')}
              disabled={disabled}
              title="使用 Skill 命令（/ 触发 skill）"
              aria-label="使用命令"
            >
              /
            </button>
            {isRunning ? (
              <button
                type="button"
                className="composer__stop-btn"
                onClick={onAbort}
                title="中断当前任务"
                aria-label="中断"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="2" y="2" width="20" height="20" rx="3" fill="none" />
                  <rect x="6" y="6" width="12" height="12" rx="1" fill="white" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="composer__send-btn"
                onClick={submit}
                disabled={!canSend}
                title={canSend ? '发送（Enter）' : '输入消息后发送'}
                aria-label="发送"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      {/* Step 6: 模式切换确认对话框 */}
      {pendingModeSwitch && (
        <div className="composer__mode-switch-overlay" onClick={() => setPendingModeSwitch(null)}>
          <div className="composer__mode-switch-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="composer__mode-switch-title">确认模式切换</div>
            <div className="composer__mode-switch-desc">
              从 <strong>{pendingModeSwitch.from}</strong> 切换到 <strong>{pendingModeSwitch.to}</strong>
            </div>
            <div className="composer__mode-switch-actions">
              <button className="btn btn-outline" onClick={() => setPendingModeSwitch(null)}>取消</button>
              <button className="btn btn-primary" onClick={() => {
                onSelectMode?.(pendingModeSwitch.to as 'agent' | 'plan' | 'debug' | 'ask');
                setPendingModeSwitch(null);
              }}>确认切换</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
