import {h} from 'vue';
import type {Meta, StoryObj} from '@storybook/vue3-vite';

import DraggableApp from './DraggableApp.vue';
import draggableSource from './DraggableApp.vue?raw';
import {
  baseStyles,
  draggableStyles,
} from '@dnd-kit/stories-shared/styles/sandbox';

const meta: Meta<typeof DraggableApp> = {
  title: 'Draggable/Basic setup',
  component: DraggableApp,
};

export default meta;
type Story = StoryObj<typeof DraggableApp>;

export const Example: Story = {
  decorators: [
    (story) => ({
      setup() {
        return () =>
          h('div', [
            h('style', baseStyles),
            h('style', draggableStyles),
            h(story()),
          ]);
      },
    }),
  ],
  parameters: {
    codesandbox: {
      files: {
        'src/App.vue': draggableSource,
        'src/styles.css': [baseStyles, draggableStyles].join('\n\n'),
      },
    },
  },
};
