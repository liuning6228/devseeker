/**
 * QuestionCard —— ask_user_question UI（DESIGN §M11.5）
 *
 * 结构：
 * - 容器展示 1-4 个问题；每个问题含 header chip + 问题文本 + 2-4 选项 + "Other" 自定义输入
 * - 单选 / 多选（multiSelect）由每题自适应
 * - 底部 Submit / Cancel 按钮
 *
 * 提交行为：把每题的 selected labels（或 empty）+ otherText（若非空）封装为 answers[] 回调
 */

import { useState, useEffect, useRef } from 'react';
import type { AskQuestionItem, AskQuestionPayload } from '../protocol';

export interface QuestionCardProps {
  payload: AskQuestionPayload;
  onSubmit: (
    requestId: string,
    answers: Array<{ question: string; selected: string[]; other?: string }>,
  ) => void;
  onCancel: (requestId: string) => void;
}

interface LocalAnswer {
  selected: Set<string>;
  other: string;
}

export function QuestionCard({ payload, onSubmit, onCancel }: QuestionCardProps): JSX.Element {
  const [answers, setAnswers] = useState<LocalAnswer[]>(() =>
    payload.questions.map(() => ({ selected: new Set<string>(), other: '' })),
  );

  // 自动聚焦到第一个问题的第一个选项 input
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const firstInput = containerRef.current?.querySelector<HTMLElement>(
        '.ask-modal__option input, .ask-modal__other input',
      );
      firstInput?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  const updateAnswer = (idx: number, patch: (prev: LocalAnswer) => LocalAnswer): void => {
    setAnswers((prev) => prev.map((a, i) => (i === idx ? patch(a) : a)));
  };

  const handleToggle = (idx: number, q: AskQuestionItem, label: string): void => {
    updateAnswer(idx, (prev) => {
      const next = new Set(prev.selected);
      if (q.multiSelect) {
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        next.clear();
        next.add(label);
      }
      return { ...prev, selected: next };
    });
  };

  const handleSubmit = (): void => {
    const out = payload.questions.map((q, i) => {
      const a = answers[i] ?? { selected: new Set<string>(), other: '' };
      const otherTrimmed = a.other.trim();
      return {
        question: q.question,
        selected: Array.from(a.selected),
        ...(otherTrimmed ? { other: otherTrimmed } : {}),
      };
    });
    onSubmit(payload.requestId, out);
  };

  const handleCancel = (): void => {
    onCancel(payload.requestId);
  };

  const canSubmit = answers.some((a, i) => {
    if (a.selected.size > 0) return true;
    if (a.other.trim().length > 0) return true;
    const q = payload.questions[i];
    // 如果没有 options（纯文本输入模式），只要有 "其他" 内容即可
    if (!q) return false;
    // 有 options 但未选且 "其他" 为空 → 不可提交
    return false;
  });

  const total = payload.questions.length;

  // 点击背景遮罩 = 取消
  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) handleCancel();
  };

  // Enter 键提交
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && canSubmit) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <div
      ref={containerRef}
      className="ask-modal-overlay"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
    >
      <div className="ask-modal" role="dialog" aria-modal="true" aria-label="DualMind 需要你的输入">
        <div className="ask-modal__title">DualMind 需要你的输入</div>
        <div className="ask-modal__hint">
          请回答以下 {total} 个问题以帮助我做决策。你可以选择一个方案，或在下方输入自定义内容。
        </div>
        {payload.questions.map((q, i) => {
          const a = answers[i]!;
          return (
            <div key={i} className="ask-modal__question">
              <div className="ask-modal__header-row">
                <span className="ask-modal__chip">{q.header}</span>
                {q.multiSelect && <span className="ask-modal__multi">多选</span>}
              </div>
              <div className="ask-modal__text">{q.question}</div>
              <div className="ask-modal__select-hint">
                {q.multiSelect ? '请选择一个或多个选项：' : '请选择一个选项：'}
              </div>
              <ul className="ask-modal__options">
                {q.options.map((opt, j) => {
                  const checked = a.selected.has(opt.label);
                  return (
                    <li
                      key={j}
                      className={`ask-modal__option${checked ? ' ask-modal__option--checked' : ''}`}
                      onClick={() => handleToggle(i, q, opt.label)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleToggle(i, q, opt.label);
                        }
                      }}
                      tabIndex={0}
                      role={q.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={checked}
                    >
                      <div className="ask-modal__option-inner">
                        <span className="ask-modal__option-indicator">
                          {q.multiSelect
                            ? (checked ? '☑' : '☐')
                            : (checked ? '●' : '○')}
                        </span>
                        <div className="ask-modal__option-text">
                          <span className="ask-modal__option-label">{opt.label}</span>
                          <span className="ask-modal__option-desc">{opt.description}</span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="ask-modal__other">
                <div className="ask-modal__other-header">其他方案（可选，手动输入）</div>
                <label>
                  <textarea
                    className="ask-modal__other-input"
                    placeholder="输入你的自定义方案…"
                    value={a.other}
                    onChange={(e) => updateAnswer(i, (prev) => ({ ...prev, other: e.target.value }))}
                    rows={2}
                  />
                </label>
              </div>
            </div>
          );
        })}
        <div className="ask-modal__actions">
          <button
            type="button"
            className="ask-modal__btn ask-modal__btn--cancel"
            onClick={handleCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="ask-modal__btn ask-modal__btn--submit"
            onClick={handleSubmit}
            disabled={!canSubmit}
            title={canSubmit ? '提交你的选择' : '请至少选择一项或输入自定义内容'}
          >
            提交
          </button>
        </div>
      </div>
    </div>
  );
}
