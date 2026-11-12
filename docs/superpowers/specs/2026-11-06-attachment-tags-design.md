# Image and pasted-text tags in the composer: design

**Local review revision, 2026-11-09:** the owner requested real, non-editable
attachment chips. This supersedes the textarea, backdrop and character-by-character
editing portions below. The editor now accepts plain text and atomic attachment
elements; the serialized text and attachment lifetime rules remain the same.
Clicking a badge pins its preview until an outside click or Escape. Wheel input
over a text badge scrolls its preview without requiring a click. These rules
also apply to sent badges, replacing click-to-expand-inline. See
`../plans/2026-11-09-atomic-attachment-chips.md`.

Date: 2026-11-06. Status: agreed with the owner in chat (the CLI-style tags,
drawn as badges, with hover previews in the box and in sent messages), checked
by a builder (its two questions settled under My calls: attachments kept per
draft across tab switches, and which image a sent badge shows); awaiting the
owner's read of this document in the original session. Continued and implemented
on 2026-11-09 at the owner's request; implementation plan:
`../plans/2026-11-09-attachment-tags.md`.

## Why

The owner, comparing with Claude Code in the terminal: "when I insert a huge
block of text, it compacts into this sort of <copypasted 40 lines> block.
similar to inserted images. <image 1> … that means the inserted attachment has
a POSITION, and can be referenced, so when I say 'look at <image1>' there is
this contextual information. But in ThreadGarden, inserting an image adds this
image attachment but no such associated positional element (I would welcome a
badge or something tbh) in the textbox."

Asked whether it should work like the CLI, with plain-text tags drawn as
badges: "yes you are right. and eg hovering on it should show the text, and
the image? in both the msg preview and in the already sent images".

**Success:** the owner pastes two screenshots and a 40-line log into a
message, writes "the error in [Image #2] matches line 12 of [Pasted text #1 +40
lines]", hovers each badge to check it is the right one, sends, and Claude
answers about the right image and the right paste. The sent message shows the
same badges, and hovering them shows the image and the text again.

## What Claude Code does today (checked 2026-11-06 in the owner's transcripts and `~/.claude/history.jsonl`)

- **Images.** Pasting an image puts `[Image #N]` into the prompt at the caret.
  The message sent keeps that text as typed, then the image blocks after the
  text, in order. Numbers count per session, so a message's only image can be
  `[Image #2]`. The CLI also adds an `isMeta` user message `[Image: source:
  <temp path>]`; Threadgarden has no file path for a pasted image and does not
  copy that.
- **Pasted text.** A long paste shows as `[Pasted text #N +K lines]` in the
  prompt only (`history.jsonl` keeps the display text and the content
  separately). On send, the tag is replaced in place by
  `\n\n<pasted_content id="5e8a">\n<the text>\n</pasted_content id="5e8a">\n\n`:
  a random 4-hex id, repeated on the closing tag (so a forged closing tag
  inside the paste can't end the block early). The model's system prompt
  explains these blocks to it.
- **Threadgarden today:** images are sent as one text block followed by all
  image blocks, with nothing in the text pointing at them; a long paste lands
  in the box as plain text.

## Goals (owner)

1. **Positional image tags.** Pasting, dropping or attaching an image puts
   `[Image #N]` into the box at the caret, drawn as a badge.
2. **Collapsed long pastes.** A long paste becomes `[Pasted text #N +K lines]`
   at the caret, drawn as a badge.
3. **Hover previews,** in the box and in sent messages: an image badge shows
   the image, a paste badge shows the text (scrollable).
4. **Claude gets what the terminal would send:** the tags in place, images
   after the text, pastes expanded in place in the CLI's `<pasted_content>`
   form.

## Non-goals

- A rich-text (contenteditable) composer. The box stays a `<textarea>`; the
  tags are ordinary text in it.
- Keeping images across an app restart in a draft. Drafts are text only today
  (`drafts.set {key, text}`) and images are already lost on reload; that does
  not change here.
- The CLI's `[Image: source: …]` meta message.
- Tags for files other than images and pasted text (`@` mentions stay as they
  are).

## Anti-goals

- **A paste that silently disappears.** A collapsed paste must survive
  everything the text survives: the debounced draft save, an app restart, a
  scheduled send, the away queue, and Edit of a scheduled message.
- **Claude seeing a tag the box showed as attached, without its image,** or an
  image it can't place: every image sent has its tag in the text, and every
  image tag the box shows as attached is sent with its image. (A tag the box
  marks as missing, below, goes as typed.)
- **A slower box.** The keystroke budget (spec §8, ≤ 16 ms per input event)
  still holds with a few pastes of thousands of lines.

## The owner's calls

- CLI-style text tags in the box, drawn as badges (not chips that delete as a
  whole).
- Hover shows the image or the pasted text, in the box and in sent messages.

## My calls (stated to the owner, not objected to)

- **Numbering.** `#N` counts up within the message being written, from 1, and
  is not reused after a removal (same as the CLI's numbers never going back).
  A new tag's number is one more than the highest number of its kind already
  used in this message, counting any tag already in the text (a hand-typed
  `[Image #3]`, or one left in a restored draft), so a new image never takes a
  number the text already uses. It starts again from 1 when a send clears the
  box.
- **Attachments survive a tab switch.** Every tab switch remounts the composer
  (`{#key tabs.active}` in `ChatPane.svelte`), and today that already loses
  attached images. The images and pastes of a draft are kept in memory by
  draft key (beside the text cache in `InteractionState`), so switching tabs,
  or the New chat dialog moving a draft (`moveDraft`, `asNow` in
  `new-chat/start.ts`), keeps them. Cleared on send, as the text is. A
  draft's images can total 20 MB; holding them in memory is acceptable.
- **An image tag with no image behind it** (after an app restart, or typed by
  hand) shows as a muted badge whose preview says "This image wasn't kept;
  attach it again" (or, when typed by hand, simply isn't a badge: the builder
  may treat both the same). On send it goes as typed, as text.
- **Which image a sent badge shows.** A sent message's images belong to its
  highest distinct image tag numbers, in ascending order: with K images, the
  K highest numbers in the text get them, the lowest of those the first image.
  That reads the CLI's "compare [Image #1] with [Image #2]" right when only #2
  was attached to that message (#1 was an earlier message's), and a leftover
  or hand-typed lower number never steals a new image (new numbers are always
  higher, above). Tags with no image under this rule are plain text. The rare
  wrong case (a hand-typed reference to a number higher than the attached
  ones) is accepted.
- **What counts as long.** A paste of more than 8 lines or more than 800
  characters is collapsed; a shorter one is inserted as plain text, as today.
  `+K lines` is the paste's line count.
- **The tag is the attachment.** Deleting an image tag from the text drops the
  image from the message; removing a thumbnail removes its tag(s) from the
  text. The thumbnail strip stays, each thumbnail labelled with its number.
  Deleting a paste tag drops the paste. Undo (Ctrl+Z) in the box brings a tag
  back, and with it its image or paste, for as long as the box still holds it
  (until a send or a reload).
- **Terminal chats get the badges too:** their messages contain the same tags.

## What the owner sees

**Writing.**

- Paste an image (or drop it, or pick it with the attach button): `[Image #1]`
  appears at the caret (at the end when the box isn't focused), separated from
  the text before it by a space, as `insertText` does for mentions today. The
  thumbnail strip shows the image labelled `#1`.
- Paste 40 lines: `[Pasted text #1 +40 lines]` appears at the caret.
- Both tags read as badges: same text, a tinted rounded background, in line
  with the text, wrapping with it. Text typed that merely looks like a tag but
  has no image or paste behind it (`[Image #9]` typed by hand) is not a badge.
- Hovering a badge shows a preview card above it: the image (scaled to fit,
  about 320 px at most), or the pasted text in the code font, scrollable,
  about 20 lines high. The same card shows when hovering a thumbnail.
- The caret moves through a tag like through any text; editing a character
  inside a tag breaks it (it's no longer a tag, and its attachment is dropped,
  as above).

**Sent.**

- The user message shows the same badges where the tags were, in the message's
  text. `<pasted_content …>` blocks show as `[Pasted text #N +K lines]` badges
  again, numbered in order of appearance.
- Hovering shows the same preview card. A paste badge can also be clicked to
  open the full text inline (and closed again), since a hover card is awkward
  for reading something long.
- Images whose tag is in the text show as badges only; images without one
  (older Threadgarden messages, or anything sent another way) keep today's
  thumbnails under the text.
- In a sent message, an image tag maps to an image by the rule under My calls
  (the K highest tag numbers get the K images). That also reads the CLI's
  messages right, where a message's only image can be `[Image #2]`.

## What Claude receives

`chat.send` keeps its shape (`text`, `images`); the composer prepares both:

- `text`: the box's text with every paste tag replaced in place by the CLI's
  block (`\n\n<pasted_content id="xxxx">\n…\n</pasted_content id="xxxx">\n\n`,
  a fresh random 4-hex id per block, the same on both tags). Image tags stay as
  typed.
- `images`: the images whose tag is in the text, ordered by tag number, each
  once (a tag typed twice still sends one image).

The service needs no change: `toUserMessage` already sends the text block
first and the images after.

## Keeping pastes alive: one text form

The composer holds the box's text (with tags) and its attachments (images and
pastes by number). Everywhere the message leaves the composer as text, it
leaves in **the sent form** (pastes expanded as above), and everywhere text
comes back into the composer, `<pasted_content>` blocks are collapsed into
tags again with their content:

- **Drafts:** `saveDraft` stores the sent form; the restored draft is parsed
  back into tags. No protocol change.
- **Scheduled sends** and the **away queue** store what was sent, already in
  the sent form; **Edit** of a scheduled message (`Composer.load`) parses it
  back, and matches its images to its tags by the sent-message rule. The box's
  own stash while a scheduled message is edited (`current()` / `load()`,
  `ChatView.svelte`) uses the sent form too.
- Images are not part of the text form: after an app restart a restored
  draft's image tags have no image behind them and show as missing (My calls).

## Elsewhere

- **Provisional titles** (`provisionalTitle` in `chat/titles.ts`) take the
  first line of the first message; a message starting with a paste would be
  titled `<pasted_content id="…">`. Titles (and anything else that summarises
  a user message: the chat list's first-prompt fallback, notifications, the
  scheduled-send preview, the away queue's waiting rows) should read a paste
  block as its text or its `[Pasted text #N +K lines]` label, never the raw
  tags.
- **Long messages.** `UserItem`'s 3,000-character clamp applies to the text as
  shown (pastes as badges), not to the expanded text.
- **Search** indexes user text as sent, pastes included; that's wanted.
- **The away copy** keeps user text, so it keeps the paste blocks; the copy's
  view renders them as badges like any sent message.

## Left to the builder

- How the badges are drawn in the textarea. One way: a backdrop layer behind
  the textarea that renders the same text with the tags wrapped in styled
  spans (the textarea's own text transparent, its caret visible), kept
  scrolled with it; hover found by hit-testing those spans' rects against the
  pointer over the textarea. The `caret.ts` mirror technique is related.
  Whatever is chosen must stay within the keystroke budget.
- Paste detection details: `onpaste` already distinguishes image files and
  path mentions; long text is a third case (with `preventDefault` and an
  insert at the caret). Ctrl+Shift+V or a setting to paste long text uncollapsed
  is not required.
- Parsing and serialising the text form, tag matching (exact
  `[Image #N]` / `[Pasted text #N +K lines]` only), and the mapping in sent
  messages, as pure functions with unit tests.
- Whether a removed image or paste is kept in memory for undo until send, or
  undo simply restores the text (and the attachment only while it is still
  held). Native undo only covers edits made through the textarea's own
  editing (e.g. `execCommand('insertText')`), not assignments to its value.
- Accessibility: a badge in a sent message is a button with the image's or
  paste's description as its name; the preview is reachable by focus, not only
  hover.
