/** Fixed address of the mock service and the UI build that connects to it. */
export const MOCK_PORT = Number(process.env.THREADGARDEN_E2E_MOCK_PORT ?? 47357);
export const MOCK_TOKEN = 'threadgarden-e2e-token';
export const UI_PORT = Number(process.env.THREADGARDEN_E2E_UI_PORT ?? 4317);
/**
 * The second, headless mock service (`mock --remote`, machines.spec.ts): where
 * its device listener answers (127.0.0.1, test-only) and the pairing code it
 * keeps live.
 */
export const REMOTE_MOCK_PORT = Number(process.env.THREADGARDEN_E2E_REMOTE_PORT ?? 47358);
export const REMOTE_PAIRING_CODE = 'TEST-TEST-TEST';
/**
 * The fake Tasmota Zigbee bridge the remote mock starts (`--fake-tasmota`,
 * power.spec.ts): its address, web password and the plug it holds.
 */
export const FAKE_SWITCH_PORT = Number(process.env.THREADGARDEN_E2E_SWITCH_PORT ?? 47359);
export const FAKE_SWITCH_PASSWORD = 'mock-switch';
export const FAKE_PLUG = 'MockPlug';
