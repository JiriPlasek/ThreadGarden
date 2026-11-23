# Turns Chat View

Based on the original user request recovered through Agent SDK from session 0e706bc5-6e3b-45db-ac5b-3fd13ba37d90.

Keep user messages, main-agent replies and finished subagent/background-task summaries. Hide ordinary tool calls, thinking and intermediate task noise. User messages always render in full outside the response scroller. All following visible response entries until the next user message share a single 20rem height limit and scroll internally when needed. Short responses keep their natural height. No reply boxes, Show more controls or fades; the scrollbar indicates overflow. Hide failed individual tool calls too; hide unrecognised entries in this view while keeping them available in Chat. Keep actionable requests and chat-level errors accessible. Preserve existing conversation behavior and Timeline.

Add Turns between Chat and Timeline in the remembered joined view switch. Reuse MessageList virtualization, older-message loading, queued messages, request actions and draft composer. Messaging is available only in Chat; Turns and Timeline keep the composer mounted but hidden and disabled so drafts survive view changes. Keep separate list scroll/height memory and per-turn inner scroll positions for Chat and Turns. Task detail navigation switches to Chat when the target is hidden.

Completed means completed, failed or stopped; unknown terminal outcomes are labeled honestly. Background launch acknowledgements are not completion. Historical task notifications and live task state are deduplicated and remain associated with their turn. No new backend endpoint, dependency or history read path.
