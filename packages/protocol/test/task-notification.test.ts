import { describe, expect, it } from 'vitest';
import { parseTaskNotification } from '../src/task-notification.js';

describe('parseTaskNotification', () => {
  it('requires the complete envelope and decodes fields without interpreting markup', () => {
    expect(
      parseTaskNotification('prefix <task-notification><summary>x</summary></task-notification>'),
    ).toBeUndefined();
    expect(parseTaskNotification('<task-notification><summary>x</summary>')).toBeUndefined();
    expect(
      parseTaskNotification(
        ' <task-notification><task-id>a</task-id><tool-use-id>b</tool-use-id><status>completed</status><summary>A &amp; B &lt;ok&gt; &#33; &#x1F600;</summary></task-notification> ',
      ),
    ).toEqual({ taskId: 'a', toolUseId: 'b', status: 'completed', summary: 'A & B <ok> ! \u{1f600}' });
  });
  it('keeps unknown status and missing fields honest', () => {
    expect(
      parseTaskNotification('<task-notification><status>future</status></task-notification>'),
    ).toEqual({ status: 'future', summary: '' });
    expect(
      parseTaskNotification(
        '<task-notification><summary>&#99999999999; &mystery;</summary></task-notification>',
      )?.summary,
    ).toBe('&#99999999999; &mystery;');
  });
});
