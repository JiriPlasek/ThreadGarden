export type TaskNotification = {
  taskId?: string;
  toolUseId?: string;
  status?: string;
  summary: string;
};

const decode = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    if (!code.startsWith('#')) {
      return (
        ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[
          code.toLowerCase()
        ] ?? entity
      );
    }
    const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
      ? String.fromCodePoint(n)
      : entity;
  });

/** Reads the CLI's whole task-notification envelope, never a fragment of a user prompt. */
export const parseTaskNotification = (text: string): TaskNotification | undefined => {
  const body = /^\s*<task-notification>([\s\S]*?)<\/task-notification>\s*$/.exec(text)?.[1];
  if (body === undefined || /<\/?task-notification>/.test(body)) return undefined;
  const field = (tag: string): string | undefined => {
    const value = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)?.[1];
    return value === undefined ? undefined : decode(value.trim());
  };
  const taskId = field('task-id');
  const toolUseId = field('tool-use-id');
  const status = field('status');
  return {
    ...(taskId ? { taskId } : {}),
    ...(toolUseId ? { toolUseId } : {}),
    ...(status ? { status } : {}),
    summary: field('summary') ?? '',
  };
};
