// How much she speaks up on her own (her settings › Initiative: quiet, normal, active), and the
// lines she said lately, so she doesn't say the same one twice in a row.
//
// Only her optional lines go through here: a word about the satellite, how Claude's job is going,
// hello and bye to a session, what she feels of your PC, a jealous remark, something to say with
// nothing going on. Errors, permission prompts, reminders, Claude's answers and her answers to you
// (a click on her, her chat) never do: they come whatever the level. And Panel.say() still decides
// what goes over what. No DOM in here, so it can be tested with a clock and dice of its own.

export const LEVELS = ['quiet', 'normal', 'active'];
export const DEFAULT_LEVEL = 'normal';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// The least time between two lines of a kind, by level; null: none at that level. Normal stays close
// to how she always was, minus bursts (her own rules, in brain.js, bond.js, pc.js, still apply on top).
export const COOLDOWNS = {
  ambient: { quiet: null, normal: 2 * MINUTE, active: 40 * SECOND },  // the satellite, a hello from another screen, glad you're back
  progress: { quiet: null, normal: MINUTE, active: 25 * SECOND },     // Claude at work: how it's going, a long think
  session: { quiet: null, normal: 0, active: 0 },                     // hello and bye to a session, a compaction
  pc: { quiet: 15 * MINUTE, normal: 45 * SECOND, active: 15 * SECOND }, // the processor, the charger, a USB stick, a game
  jealous: { quiet: null, normal: 0, active: 0 },                     // another AI in front (bond.js has its own pace)
  idle: { quiet: null, normal: null, active: 5 * MINUTE },            // nothing going on: something of her own
};
// and between any two of her optional lines, whatever their kind
export const GAPS = { quiet: 3 * MINUTE, normal: 15 * SECOND, active: 6 * SECOND };
// the lines that come by chance (a word while she looks at the satellite): their odds, scaled
const CHANCE = { quiet: 0, normal: 1, active: 1.6 };
// "every N tool calls she says how it's going": N, scaled (Infinity: never)
const EVERY = { quiet: Infinity, normal: 1, active: 0.5 };

export const levelOf = (value) => (LEVELS.includes(value) ? value : DEFAULT_LEVEL);

export class Initiative {
  // now: the clock (ms); rng: the dice, 0..1; busy: () => true while something she shouldn't talk
  // over is on (a chat with her, her guide, an answer or a prompt on screen)
  constructor({ level = DEFAULT_LEVEL, now = () => Date.now(), rng = Math.random, busy = null } = {}) {
    this.level = levelOf(level);
    this.now = now;
    this.rng = rng;
    this.busy = busy;
    this.last = {}; // kind -> when her last line of it was shown
    this.lastAny = -Infinity;
  }

  set level(value) {
    this._level = levelOf(value);
  }

  get level() {
    return this._level;
  }

  // Could a line of this kind be said now?
  allow(kind) {
    const cooldown = COOLDOWNS[kind]?.[this.level];
    if (cooldown === null || cooldown === undefined) return false;
    if (this.busy?.()) return false;
    const now = this.now();
    if (now - this.lastAny < GAPS[this.level]) return false;
    return now - (this.last[kind] ?? -Infinity) >= cooldown;
  }

  // A line of this kind was shown: its kind and the others wait their turn.
  mark(kind) {
    const now = this.now();
    this.last[kind] = now;
    this.lastAny = now;
  }

  // Starts this kind's wait now, as if one had just been said (without making the others wait).
  delay(kind) {
    this.last[kind] = this.now();
  }

  // Shows a line of this kind if it may be said: show() puts it up and returns false when the
  // panel didn't take it (then nothing is counted). True if it was shown.
  offer(kind, show) {
    if (!this.allow(kind)) return false;
    const shown = show();
    if (shown === false) return false;
    this.mark(kind);
    return true;
  }

  // A line that comes by chance, at odds p at the normal level.
  chance(p) {
    return this.rng() < Math.min(1, p * CHANCE[this.level]);
  }

  // Every how many (tool calls) she says something, for n at the normal level.
  every(n) {
    const k = EVERY[this.level];
    return k === Infinity ? Infinity : Math.max(1, Math.round(n * k));
  }
}

// Something she shouldn't talk over with an optional line: her chat or guide open, an answer or
// her report card you may be reading, a permission prompt, an error, a reminder.
// Paused too (screen locked, asleep: pause.js): what she'd have said meanwhile isn't kept for
// later, so her lines don't all come at once when you're back.
export function occupied({ panel, chat, guide, capri } = {}) {
  if (panel?.paused) return true;
  if (chat?.open || guide?.running || capri?.mode === 'alert') return true;
  if (!panel?.visible) return false;
  const cur = panel.current;
  if (!cur) return false;
  if (cur.reply || cur.report || cur.chat || cur.guide || cur.actions?.length) return true;
  return !['idle', 'info', 'work'].includes(cur.kind);
}

// The lines she said lately (in this run only): a pick from a list skips them, so the same line
// doesn't come twice in a row. A list of one is said as it is; a list all said lately gives the
// one said the longest ago.
export class Recent {
  constructor({ size = 40, rng = Math.random } = {}) {
    this.size = size;
    this.rng = rng;
    this.said = new Map(); // line -> when (a count), the oldest first
    this.n = 0;
  }

  pick(list) {
    if (!list?.length) return undefined;
    let line;
    if (list.length === 1) {
      line = list[0];
    } else {
      const fresh = list.filter((l) => !this.said.has(l));
      if (fresh.length) line = fresh[Math.floor(this.rng() * fresh.length)];
      else line = list.reduce((a, b) => (this.said.get(b) < this.said.get(a) ? b : a));
    }
    this.note(line);
    return line;
  }

  note(line) {
    this.said.delete(line);
    this.said.set(line, ++this.n);
    while (this.said.size > this.size) this.said.delete(this.said.keys().next().value);
  }
}

// one for the whole overlay: what she said lately, whoever picked it
export const recent = new Recent();
export const pickLine = (list) => recent.pick(list);
