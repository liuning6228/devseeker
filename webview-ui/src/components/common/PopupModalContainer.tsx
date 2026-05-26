import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog.js';

interface PopupModalContainerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
}

/**
 * PopupModalContainer — 通用弹窗容器
 * 基于 shadcn/ui Dialog，带遮罩 + 关闭按钮 + ESC 关闭
 */
export function PopupModalContainer({ open, onOpenChange, title, children }: PopupModalContainerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
