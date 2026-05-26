import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '../components/ui/button.js';

const meta: Meta<typeof Button> = {
  title: 'UI/Button',
  component: Button,
  argTypes: {
    variant: { control: 'select', options: ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] },
    size: { control: 'select', options: ['default', 'sm', 'lg', 'icon'] },
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Default: Story = {
  args: { children: 'Button', variant: 'default' },
};

export const Destructive: Story = {
  args: { children: '删除', variant: 'destructive' },
};

export const Outline: Story = {
  args: { children: '取消', variant: 'outline' },
};

export const Small: Story = {
  args: { children: '小按钮', size: 'sm' },
};

export const Link: Story = {
  args: { children: '链接样式', variant: 'link' },
};
