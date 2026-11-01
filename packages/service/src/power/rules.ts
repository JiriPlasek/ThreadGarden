import type { PowerConfig } from '@threadgarden/protocol';

/** What Threadgarden claims on a Tasmota switch. Nothing else is ever touched. */
export const RESOURCES = {
  ruleTimers: [6, 7, 8],
  vars: [14, 15],
  mems: [11, 12, 13, 14],
  timer: 16,
} as const;

type Slot = 1 | 2 | 3;
type Rules = Record<Slot, string>;

export function commandsFor(config: PowerConfig): {
  off: string;
  on: string;
  read: string;
  trigger: string;
} {
  if (config.kind === 'tasmota-zigbee') {
    const d = config.device ?? '';
    return {
      off: `ZbSend {"Device":"${d}","Send":{"Power":0}}`,
      on: `ZbSend {"Device":"${d}","Send":{"Power":1}}`,
      read: `ZbSend {"Device":"${d}","Read":{"ActivePower":true}}`,
      trigger: `ZbReceived#${d}#ActivePower`,
    };
  }
  return { off: 'Power 0', on: 'Power 1', read: 'Status 8', trigger: 'StatusSNS#ENERGY#Power' };
}

export function ruleText(config: PowerConfig): string {
  const t = commandsFor(config).trigger;
  const w = config.offWatts;
  const m = config.minOffSeconds;
  return [
    'on Event#tga do Backlog Var14 0;Var15 1;RuleTimer7 5;RuleTimer8 900 endon',
    'on Event#tgo do Backlog Var15 0;Var14 0;RuleTimer7 0;RuleTimer8 0 endon',
    'on Rules#Timer=7 do Backlog %mem14%;RuleTimer7 5 endon',
    `on ${t}<${w} do Add14 %var15% endon`,
    `on ${t}>=${w} do Var14 0 endon`,
    'on Var14#State>=6 do Backlog %mem12%;Mem11 %utctime%;Event tgo endon',
    'on Rules#Timer=8 do Event tgo endon',
    `on Event#tgw do Backlog %mem12%;RuleTimer6 ${m} endon`,
    'on Rules#Timer=6 do %mem13% endon',
    'on Clock#Timer=16 do Event tgw endon',
  ].join(' ');
}

export function memsFor(config: PowerConfig): Record<11 | 12 | 13 | 14, string> {
  const c = commandsFor(config);
  return { 11: '0', 12: c.off, 13: c.on, 14: c.read };
}

export function isOurs(text: string): boolean {
  return text.includes('Event#tga do');
}

export function chooseSlot(rules: Rules): Slot | null {
  const slots: Slot[] = [1, 2, 3];
  const ours = slots.find((s) => isOurs(rules[s] ?? ''));
  if (ours) return ours;
  return slots.find((s) => (rules[s] ?? '').trim() === '') ?? null;
}

/** Names Tasmota commands are matched by, case-insensitively and as whole words. */
const CLAIMED: string[] = [
  ...RESOURCES.ruleTimers.flatMap((n) => [`RuleTimer${n}`, `Rules#Timer=${n}`]),
  ...RESOURCES.vars.map((n) => `Var${n}`),
  ...RESOURCES.mems.map((n) => `Mem${n}`),
  `Clock#Timer=${RESOURCES.timer}`,
];

function mentions(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'i').test(text);
}

export function conflicts(
  rules: Rules,
  slot: Slot,
  timers: Record<number, { Enable: number }>,
  mems: Record<number, string>,
  ourMems: Record<number, string>,
): string[] {
  const problems: string[] = [];
  for (const s of [1, 2, 3] as Slot[]) {
    if (s === slot) continue;
    const text = rules[s] ?? '';
    for (const name of CLAIMED) {
      if (mentions(text, name)) problems.push(`Rule ${s} uses ${name}, which Threadgarden needs.`);
    }
  }
  const slotText = rules[slot] ?? '';
  const slotIsOurs = isOurs(slotText);
  if (slotText.trim() === '' && timers[RESOURCES.timer]?.Enable === 1) {
    problems.push(`Timer ${RESOURCES.timer} is in use by another rule.`);
  }
  for (const n of RESOURCES.mems) {
    const v = mems[n] ?? '';
    if (v === '' || v === ourMems[n]) continue;
    // Our own rule writes the time of the last cut into Mem11.
    if (n === 11 && (v === '0' || slotIsOurs)) continue;
    problems.push(`Mem${n} holds a value Threadgarden didn't write.`);
  }
  return problems;
}
