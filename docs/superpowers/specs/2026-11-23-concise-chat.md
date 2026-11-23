# Concise Chat View

Based on the original user request recovered through Agent SDK from session 0e706bc5-6e3b-45db-ac5b-3fd13ba37d90.

Keep user messages, main-agent replies and finished subagent/background-task summaries. Hide ordinary tool calls, thinking and intermediate task noise. Every long visible content block has a bounded height and Show more/Show less. Keep actionable requests, errors and unknown data accessible. Preserve existing conversation behavior and Timeline.

Add Concise between Conversation and Timeline in the remembered joined view switch. Reuse MessageList virtualization, older-message loading, queued messages, request actions and draft composer. Keep separate list scroll/height/expansion memory for Conversation and Concise. Task detail navigation switches to Conversation when the target is hidden.

Completed means completed, failed or stopped; unknown terminal outcomes are labeled honestly. Background launch acknowledgements are not completion. Historical task notifications and live task state are deduplicated and remain associated with their turn. No new backend endpoint, dependency or history read path.
