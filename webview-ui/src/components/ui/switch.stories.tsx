import type { Meta, StoryObj } from '@storybook/react';
import { Switch } from '../components/ui/switch.js';

const meta: Meta<typeof Switch> = {
  title: 'UI/Switch',
  component: Switch,
};

export default meta;
type Story = StoryObj<typeof Switch>;

export const Off: Story = {
  args: { checked: false },
};

export const On: Story = {
  args: { checked: true },
};
