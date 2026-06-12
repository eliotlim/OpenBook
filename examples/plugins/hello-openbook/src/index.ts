import {api} from '@open-book/plugin-sdk';
import {HelloBlock} from './block';

/**
 * The smallest useful OpenBook extension: one custom block and one palette
 * command. `activate` runs when the workspace loads the plugin; everything
 * registered through the api is torn down automatically on disable.
 */
export default function activate(a: typeof api) {
  a.blocks.register({
    type: 'hello',
    render: HelloBlock,
    slash: {
      label: 'Hello block',
      hint: 'A friendly counter from the example extension',
      keywords: 'hello example plugin extension counter',
      make: () => ({type: 'openbook.hello/hello', props: {count: 0}}),
    },
  });

  a.commands.register({
    id: 'new-greeting-page',
    title: 'New greeting page',
    keywords: 'hello greeting example plugin',
    run: () => {
      void a.pages.create(`Hello ${new Date().toISOString().slice(0, 10)}`, 'A page made by the Hello OpenBook extension.');
    },
  });
}
