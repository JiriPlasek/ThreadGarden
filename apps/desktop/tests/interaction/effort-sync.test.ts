import { screen, waitFor } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import { summary } from '../layout/harness';
import { renderChat, SID } from './helpers';

it('selects reported effort on open and follows runtime updates without a manual pick', async () => {
  const { server } = await renderChat({
    configure: (server) => {
      server.handlers['chat.open'] = () => ({
        summary: summary(SID, { live: true, status: 'idle' }),
        header: { model: 'opus', effort: 'high' },
        items: [],
        hasMore: false,
        seq: 1,
      });
      server.handlers['chat.models'] = () => [
        {
          value: 'opus',
          displayName: 'Opus',
          description: '',
          supportedEffortLevels: ['low', 'medium', 'high'],
        },
      ];
    },
  });
  const effort = (await screen.findByRole('combobox', { name: 'Effort' })) as HTMLSelectElement;
  expect(effort.value).toBe('high');
  server.push('chat.status', { sessionId: SID, seq: 2, status: 'idle', header: { effort: 'low' } });
  await waitFor(() => expect(effort.value).toBe('low'));
  expect(server.calls('chat.setEffort')).toHaveLength(0);
  server.push('chat.status', { sessionId: SID, seq: 3, status: 'idle', header: { effort: '' } });
  await waitFor(() => expect(effort.selectedOptions[0]?.textContent).toBe('Effort (unreported)'));
});
