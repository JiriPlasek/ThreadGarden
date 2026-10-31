import { settingsDefaults } from '@pahub/protocol';
import { applyAppearance, readCachedAppearance } from '#lib/appearance.js';
import { applyScale, readCachedScale } from '#lib/interface-scale.js';

// pahub's UI is a static single-page app inside the Tauri webview: no server rendering.
export const ssr = false;
export const prerender = false;

// The interface size this webview remembers, before anything is rendered (the
// service's copy, restored after connecting, wins if they differ).
applyScale(readCachedScale());

// The same for the appearance settings (accent, styles, fonts; spec v1.3 §6).
applyAppearance({ ...settingsDefaults, ...readCachedAppearance() });
