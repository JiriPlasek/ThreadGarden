import Content from './dropdown-menu-content.svelte';
import Item from './dropdown-menu-item.svelte';
import Portal from './dropdown-menu-portal.svelte';
import Separator from './dropdown-menu-separator.svelte';
import Sub from './dropdown-menu-sub.svelte';
import SubContent from './dropdown-menu-sub-content.svelte';
import SubTrigger from './dropdown-menu-sub-trigger.svelte';
import Trigger from './dropdown-menu-trigger.svelte';
import Root from './dropdown-menu.svelte';

/** The parts of shadcn-svelte's dropdown menu Threadgarden uses (same styling as the context menu). */
export {
  Root,
  Trigger,
  Portal,
  Content,
  Item,
  Separator,
  Sub,
  SubContent,
  SubTrigger,
  //
  Root as DropdownMenu,
  Trigger as DropdownMenuTrigger,
  Portal as DropdownMenuPortal,
  Content as DropdownMenuContent,
  Item as DropdownMenuItem,
  Separator as DropdownMenuSeparator,
};
