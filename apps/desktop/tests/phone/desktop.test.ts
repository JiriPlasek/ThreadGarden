import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import PlacesColumn from '../../src/lib/components/layout/PlacesColumn.svelte';
import { isPhone } from '../../src/lib/native';
import { project, setup, setupTwoMachines } from '../layout/harness';

// The same components in a desktop build (no VITE_THREADGARDEN_PHONE, no Android).
describe('the desktop is unchanged', () => {
  it("a desktop build's places column still has This PC", async () => {
    expect(isPhone).toBe(false);
    const env = await setupTwoMachines({
      configure: (s) => (s.handlers['projects.list'] = () => [project('p1', 'alpha')]),
    });
    render(PlacesColumn, { context: env.context });
    const group = await screen.findByRole('group', { name: 'This PC' });
    expect(await within(group).findByRole('button', { name: /alpha/i })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Ubuntu PC' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /analytics/i })).toBeTruthy();
  });

  it('with This PC alone, its projects sit under This PC, and there is no Add machine', async () => {
    const env = await setup();
    render(PlacesColumn, { context: env.context });
    expect(await screen.findByRole('heading', { name: 'This PC' })).toBeTruthy();
    expect(screen.getByText('No projects yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add machine/i })).toBeNull();
  });
});
