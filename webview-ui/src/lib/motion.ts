import { motion, AnimatePresence } from 'framer-motion';

/**
 * 消息出现动画
 */
export const messageVariants = {
  initial: { opacity: 0, y: 10, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0 },
};

/**
 * 卡片折叠/展开动画
 */
export const expandVariants = {
  collapsed: { height: 0, opacity: 0 },
  expanded: { height: 'auto', opacity: 1 },
};

/**
 * 弹窗/遮罩出现动画
 */
export const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
};

/**
 * 列表出现（交错）
 */
export const listItemVariants = {
  hidden: { opacity: 0, x: -10 },
  visible: (i: number) => ({
    opacity: 1,
    x: 0,
    transition: { delay: i * 0.03 },
  }),
};

export { motion, AnimatePresence };
