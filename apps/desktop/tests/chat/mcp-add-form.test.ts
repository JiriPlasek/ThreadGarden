import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { McpScope, McpServerConfig } from '@threadgarden/protocol';
import { describe, expect, it, vi } from 'vitest';
import McpAddServerForm from '../../src/lib/components/chat/McpAddServerForm.svelte';

type OnAdd = (name: string, scope: McpScope, config: McpServerConfig) => Promise<void>;

const show = (onAdd: OnAdd = async () => {}, onCancel: () => void = () => {}) => {
  const add = vi.fn<OnAdd>(onAdd);
  render(McpAddServerForm, { onAdd: add, onCancel });
  return add;
};

describe('McpAddServerForm', () => {
  it('the type switches between the URL and the command fields', async () => {
    show();
    expect(screen.getByLabelText('URL')).toBeTruthy();
    expect(screen.queryByLabelText('Command')).toBeNull();
    await userEvent.click(screen.getByLabelText('Command (stdio)'));
    expect(screen.getByLabelText('Command')).toBeTruthy();
    expect(screen.getByLabelText('Arguments (one per line)')).toBeTruthy();
    expect(screen.queryByLabelText('URL')).toBeNull();
    await userEvent.click(screen.getByLabelText('URL (http)'));
    expect(screen.getByLabelText('URL')).toBeTruthy();
  });

  it('header and environment values are masked', async () => {
    show();
    expect(screen.getByText('Headers')).toBeTruthy();
    expect(screen.getByText('(values hidden)')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '+ add' }));
    expect(screen.getByLabelText('Header value 1').getAttribute('type')).toBe('password');
    await userEvent.click(screen.getByLabelText('Command (stdio)'));
    expect(screen.getByText('Environment')).toBeTruthy();
    expect(screen.getByLabelText('Environment value 1').getAttribute('type')).toBe('password');
  });

  it('Everyone shows the .mcp.json note', async () => {
    show();
    const note =
      "Saved in this project's .mcp.json, which is usually committed and shared with everyone who clones the project.";
    expect(screen.queryByText(note)).toBeNull();
    await userEvent.click(screen.getByLabelText('Everyone (.mcp.json)'));
    expect(screen.getByText(note)).toBeTruthy();
  });

  it('Add sends the server', async () => {
    const add = show();
    await userEvent.type(screen.getByLabelText('Name'), 'sentry');
    await userEvent.type(screen.getByLabelText('URL'), 'https://mcp.sentry.dev/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(add).toHaveBeenCalledWith('sentry', 'local', {
      type: 'http',
      url: 'https://mcp.sentry.dev/mcp',
    });
  });

  it('a problem is shown and nothing is sent', async () => {
    const add = show();
    await userEvent.type(screen.getByLabelText('Name'), 'a b');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'Use letters, numbers, - and _ for the name (not starting with -).',
    );
    expect(add).not.toHaveBeenCalled();
  });

  it("Claude Code's refusal is shown word for word and the form keeps its values", async () => {
    const add = show(async () => {
      throw new Error('MCP server sentry already exists in local config');
    });
    await userEvent.type(screen.getByLabelText('Name'), 'sentry');
    await userEvent.type(screen.getByLabelText('URL'), 'https://mcp.sentry.dev/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'MCP server sentry already exists in local config',
    );
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('sentry');
    expect((screen.getByLabelText('URL') as HTMLInputElement).value).toBe(
      'https://mcp.sentry.dev/mcp',
    );
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('Cancel calls onCancel', async () => {
    const onCancel = vi.fn();
    show(async () => {}, onCancel);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
