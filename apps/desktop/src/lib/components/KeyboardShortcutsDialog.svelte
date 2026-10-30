<script lang="ts">
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import { SHORTCUT_GROUPS, formatCombos, shortcutsFor } from '#lib/shortcuts.js';
  import { useApp } from '#lib/state/context.js';

  /**
   * Every keyboard shortcut, grouped (written from `shortcuts.ts`). Opens with
   * Ctrl/Cmd+/ anywhere, `?` outside text fields, the quick switcher's
   * "Keyboard shortcuts" command and the settings dialog; never over another
   * dialog. The composer rows follow the "Enter sends the message" setting.
   */
  const { interaction, settings } = useApp();

  const groups = $derived.by(() => {
    const list = shortcutsFor({ enterToSend: settings.value.enterToSend });
    return SHORTCUT_GROUPS.map((group) => ({
      group,
      id: `shortcuts-${group.toLowerCase().replace(/\s+/g, '-')}`,
      items: list.filter((s) => s.group === group),
    }));
  });

  /** Typing a `?` into a field must stay typing. */
  const isEditable = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  };

  const onWindowKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const modSlash = mod && (e.key === '/' || e.key === '?');
    const question = !mod && e.key === '?' && !isEditable(e.target);
    if (!modSlash && !question) return;
    if (interaction.shortcutsOpen) {
      // Ctrl/Cmd+/ toggles; `?` inside the dialog does nothing.
      if (modSlash) {
        e.preventDefault();
        interaction.shortcutsOpen = false;
      }
      return;
    }
    // Another modal (settings, a confirmation, the quick switcher) owns the keyboard.
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    e.preventDefault();
    interaction.shortcutsOpen = true;
  };
</script>

<svelte:window onkeydown={onWindowKey} />

<Dialog.Root
  open={interaction.shortcutsOpen}
  onOpenChange={(open) => (interaction.shortcutsOpen = open)}
>
  <Dialog.Content class="max-h-[85vh] gap-4 overflow-y-auto p-5 sm:max-w-3xl">
    <Dialog.Header>
      <Dialog.Title class="text-base">Keyboard shortcuts</Dialog.Title>
      <Dialog.Description class="text-xs">
        Composer keys follow the “Enter sends the message” setting ({settings.value.enterToSend
          ? 'on'
          : 'off'}).
      </Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-x-8 gap-y-5 md:grid-cols-2">
      {#each groups as { group, id, items } (group)}
        <section aria-labelledby={id}>
          <h3 {id} class="text-muted-foreground mb-1.5 text-xs font-semibold">
            {group}
          </h3>
          <table class="w-full border-collapse text-sm">
            <tbody>
              {#each items as s (s.id)}
                <tr class="border-b last:border-b-0">
                  <td class="py-1.5 pr-3 align-top">{s.description}</td>
                  <td class="py-1 text-right align-top whitespace-nowrap">
                    {#each formatCombos(s.combos) as keys, i (keys)}
                      {#if i > 0}<span class="text-muted-foreground mx-1 text-xs">or</span>{/if}
                      <kbd
                        class="bg-muted text-foreground inline-block min-w-6 rounded border border-b-2 px-1.5 text-center font-sans text-xs leading-5"
                        >{keys}</kbd
                      >
                    {/each}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
