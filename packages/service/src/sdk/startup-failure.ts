/**
 * User-facing explanations for the reasons Claude Code gives when it refuses
 * to start (`SDKResultError.startup_failure_reason`, §6.4). `setup: true`
 * means the fix is installing or updating Claude Code, so the UI shows the
 * setup screen instead of a retry.
 */
import type { SDKStartupFailureReason } from '@anthropic-ai/claude-agent-sdk';

export type StartupFailureMessage = { title: string; body: string; setup: boolean };

type Entry = { title: string; body: string; setup?: true };

// A `Record` over the SDK union, so a new reason in a future SDK fails typecheck here.
const MESSAGES: Record<SDKStartupFailureReason, Entry> = {
  org_pin_api_key_conflict: {
    title: 'Organization sign-in required',
    body: 'Your organization requires Claude Code to use its own sign-in, but an Anthropic API key or auth token is configured. Remove the API key (in Threadgarden settings or your environment) and sign in to Claude Code.',
  },
  provider_not_allowed: {
    title: 'API provider not allowed',
    body: "Your organization's managed settings limit which API providers Claude Code may use, and this session is set up for one that is not on the list. Switch to an allowed provider or ask your administrator.",
  },
  org_verify_failed: {
    title: 'Could not verify your organization',
    body: "Claude Code could not check your sign-in against your organization's requirements. Check your network connection, or sign in to Claude Code again if your session was revoked.",
  },
  org_pin_mismatch: {
    title: 'Wrong organization',
    body: 'You are signed in to Claude Code with an account from an organization this machine does not allow. Sign in with an account from the required organization.',
  },
  managed_settings_invalid: {
    title: 'Managed settings are invalid',
    body: "Your organization's managed Claude Code settings could not be read, name no organization, or block every available model. Ask your administrator to fix the managed settings.",
  },
  remote_settings_required_unavailable: {
    title: 'Required organization settings unavailable',
    body: 'Your organization requires settings that Claude Code could not load. Check your network connection and try again.',
  },
  gateway_signin_required: {
    title: 'Sign in again',
    body: 'Your sign-in through the cloud gateway has ended. Sign in to Claude Code again, then retry.',
  },
  gateway_access_denied: {
    title: 'Gateway access denied',
    body: "The cloud gateway refused your organization's managed settings for this account. Ask your administrator for access.",
  },
  proxy_invalid: {
    title: 'Proxy setting is invalid',
    body: 'A proxy setting (such as HTTPS_PROXY) is not a complete URL. Fix the proxy variable in your environment or Claude Code settings.',
  },
  temp_dir_unusable: {
    title: 'Temporary folder unusable',
    body: 'Claude Code could not create or safely use its per-user temporary folder. Check the permissions and free space of your temp directory.',
  },
  cwd_unavailable: {
    title: 'Project folder unavailable',
    body: "The chat's project folder was deleted, moved or cannot be read. Restore the folder or start the chat in another project.",
  },
  shell_tool_missing: {
    title: 'No shell available',
    body: 'Claude Code on Windows needs Git Bash or PowerShell, and neither is available (PowerShell may be turned off by CLAUDE_CODE_USE_POWERSHELL_TOOL). Install Git for Windows or enable PowerShell.',
  },
  session_held_by_background: {
    title: 'Chat is running in the background',
    body: 'This conversation is currently running as a background session, so it cannot be resumed here. Wait for it to finish or stop it, then try again.',
  },
  worktree_resume_refused: {
    title: 'Resume refused for the worktree',
    body: "The chat's git worktree failed its safety checks, or the resume was started from inside it. See the details below for whether retrying continues without the worktree.",
  },
  worktree_unverified: {
    title: 'Worktree could not be verified',
    body: "The chat's git worktree could not be verified right now. Retrying may succeed.",
  },
  cli_version_too_old: {
    title: 'Claude Code needs an update',
    body: 'The installed Claude Code is older than the minimum version Anthropic requires. Update Claude Code, then try again.',
    setup: true,
  },
  bypass_root: {
    title: 'Bypass permissions not allowed as root',
    body: 'Bypass-permissions mode cannot be used while running as the root user. Choose another permission mode or run as a regular user.',
  },
  org_config_required_unavailable: {
    title: 'Organization policy unavailable',
    body: 'Your organization requires its policy limits and managed settings before a session starts, and they could not be loaded (network, proxy or a service error). Retrying may succeed.',
  },
  org_config_refused: {
    title: 'Organization refused this sign-in',
    body: 'Your organization requires its policy and managed settings, and they were refused for this sign-in (expired or revoked session, or Claude Code is not allowed for this account). Sign in again or ask your administrator; retrying will not help.',
  },
  sandbox_required_unavailable: {
    title: 'Required sandbox unavailable',
    body: 'A working sandbox is required, but it cannot run here (for example bubblewrap is missing or the platform is not supported). Make the sandbox available or have the requirement changed.',
  },
};

export const startupFailureMessage = (reason: string): StartupFailureMessage => {
  const known = Object.hasOwn(MESSAGES, reason)
    ? MESSAGES[reason as SDKStartupFailureReason]
    : undefined;
  if (known) return { title: known.title, body: known.body, setup: known.setup === true };
  return {
    title: 'Claude Code could not start',
    body: `Claude Code refused to start this session (reason: ${reason}). See the details below, or check Claude Code's documentation for this reason.`,
    setup: false,
  };
};
