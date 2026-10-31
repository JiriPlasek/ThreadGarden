import Content from './dropdown-menu-content.svelte';
import Item from './dropdown-menu-item.svelte';
import Portal from './dropdown-menu-portal.svelte';
import Separator from './dropdown-menu-separator.svelte';
import Trigger from './dropdown-menu-trigger.svelte';
import Root from './dropdown-menu.svelte';

/** The parts of shadcn-svelte's dropdown menu pahub uses (same styling as the context menu). */
export {
  Root,
  Trigger,
  Portal,
  Content,
  Item,
  Separator,
  //
  Root as DropdownMenu,
  Trigger as DropdownMenuTrigger,
  Portal as DropdownMenuPortal,
  Content as DropdownMenuContent,
  Item as DropdownMenuItem,
  Separator as DropdownMenuSeparator,
};
