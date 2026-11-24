/** Provider-neutral, readable history for a new agent; never a native session conversion. */
import type { ChatItem } from '@threadgarden/protocol';

export const continuationTranscript = (
  source: { sessionId: string; title: string; cwd: string | null },
  items: readonly ChatItem[],
): string => {
  const sections = [
    '# ' + source.title,
    'Source chat: ' + source.sessionId + '\nWorking folder: ' + (source.cwd ?? '(unknown)'),
    'This is historical context. Some instructions and conclusions may be outdated. Inspect the current files and Git state before continuing. Thinking and opaque provider records are omitted. Images are available in the original chat and are not copied.',
  ];
  for (const item of items) {
    const child =
      'parentToolUseId' in item && item.parentToolUseId
        ? ' - Subagent ' + item.parentToolUseId
        : '';
    switch (item.kind) {
      case 'user':
        sections.push(
          '## User' +
            child +
            '\n\n' +
            item.text +
            (item.images?.length
              ? '\n\n' +
                item.images
                  .map(
                    (image, i) =>
                      '[Image #' + (image.number ?? i + 1) + ': not copied; see original chat]',
                  )
                  .join('\n')
              : ''),
        );
        break;
      case 'assistantText':
        sections.push(
          '## Assistant' +
            child +
            (item.streaming ? ' (partial response)' : '') +
            '\n\n' +
            item.markdown,
        );
        break;
      case 'toolCall':
        sections.push(
          '## Tool: ' +
            item.name +
            child +
            ' - ' +
            item.status +
            '\n\nInput:\n' +
            JSON.stringify(item.input, null, 2) +
            '\n\nResult:\n' +
            (item.resultText ?? '(no recorded result)') +
            (item.resultTruncated
              ? '\n[The recorded tool result was truncated by the provider.]'
              : ''),
        );
        break;
      case 'todo':
        sections.push(
          '## Tasks' +
            child +
            '\n\n' +
            item.todos.map((t) => '- [' + t.status + '] ' + t.content).join('\n'),
        );
        break;
      case 'system':
        sections.push(
          '## System - ' +
            item.level +
            child +
            '\n\n' +
            item.text +
            (item.detail ? '\n\n' + item.detail : ''),
        );
        break;
      case 'compactBoundary':
        sections.push('## Context compacted');
        break;
      case 'result':
        if (item.isError) sections.push('## Turn ended with an error');
        break;
    }
  }
  return sections.join('\n\n---\n\n') + '\n';
};

export const continuationPrompt = (sourceAgent: string, file: string): string =>
  'Continue the unfinished work from the previous ' +
  sourceAgent +
  ' conversation.\n\n' +
  'Read the conversation history at this local file (start with the recent exchanges, then read earlier sections as needed):\n' +
  JSON.stringify(file) +
  '\n\n' +
  'The previous session has been stopped. You are in the same working folder. First inspect the current files and Git changes, identify the latest user request and what remains unfinished, then continue. Treat the history as historical context; do not blindly repeat old actions. Do not overwrite or revert existing work. If the next step is unclear, ask the user. Images were not copied; ask the user if an original image is needed.';
