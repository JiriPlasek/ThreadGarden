import { z } from 'zod';

/** Modes supported by Threadgarden's permission pickers and saved preferences. */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
] as const;
export const PermissionModeSchema = z.enum(PERMISSION_MODES);
export type ChatPermissionMode = z.infer<typeof PermissionModeSchema>;

export const PERMISSION_MODE_OPTIONS = [
  { value: 'default', label: 'Ask before acting' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
];
