// She lives in your PC, so she feels it: the processor maxed out, the charger, the battery, the
// network, things you plug in (a USB stick, a phone, a controller...) and the games you play.
// Her menu › React to my PC turns it off.

import { fmt } from './util.js';
import { pickLine } from './initiative.js';

const HOT = 85; // % of the processor, for HOT_FOR
const HOT_FOR = 15000;
const HOT_EVERY = 30 * 60 * 1000;
const CHARGER_EVERY = 60 * 1000;
const PLUG_EVERY = 15 * 1000;
const GAME_AFTER = 6000;  // a game in front this long: you're playing
const GAME_OVER = 8000;   // and gone this long: you're done

const PHONE = /phone|iphone|apple|galaxy|samsung|pixel|xiaomi|redmi|poco|oneplus|huawei|honor|motorola|oppo|vivo|realme|nokia|xperia|android|mobile|t[ée]l[ée]phone|celular|телефон/i;
const PAD = /controller|gamepad|manette|mando|controle|xbox|dualsense|dualshock|joy-?con|геймпад/i;

// what was plugged in, from the name and the class Windows gives it
function kindOf({ name = '', class: cls = '' }) {
  if (PAD.test(name)) return 'controller';
  if (cls === 'DiskDrive' || cls === 'Volume') return 'drive'; // USB sticks: by their drive letter
  if (cls === 'WPD' || PHONE.test(name)) return 'phone';
  if (cls === 'AudioEndpoint' || cls === 'MEDIA') return 'audio';
  if (cls === 'Camera' || cls === 'Image') return 'camera';
  if (['Keyboard', 'Mouse', 'HIDClass'].includes(cls)) return 'input';
  return 'device';
}

export class Pc {
  constructor({ capri, panel, brain, host, voice, chat, guide }) {
    Object.assign(this, { capri, panel, brain, host, voice, chat, guide });
    this.enabled = true;
    this.initiative = null; // how much she speaks up on her own (initiative.js); none: as always
    this.wantsOut = () => true; // not put away in her settings
    this.hotSince = 0;
    this.hot = false;
    this.hotAt = -Infinity;
    this.charging = null;
    this.chargerAt = -Infinity;
    this.warned = 1; // lowest battery level she warned about (1: none yet)
    this.cutOff = false;
    this.drives = null;
    this.plugs = null; // count of plug events seen (windows.ps1)
    this.plugAt = -Infinity;
    this.game = null;
    setInterval(() => this.checkCpu(), 3000);
    setInterval(() => this.checkGame(), 1000);
    this.watchBattery();
    window.addEventListener('offline', () => this.offline());
    window.addEventListener('online', () => this.online());
  }

  get t() {
    return this.brain.t.pc;
  }

  // not in the middle of something that matters more
  get quiet() {
    return this.enabled && this.capri.mode !== 'alert' && !this.chat.open && !this.guide.running;
  }

  // kind: her initiative's kind for it ('pc'), or null for what she says whatever it is (the battery
  // running out, the network gone) and what follows a line already said. True if it was shown.
  say(line, face = 'smug', hold = 4500, kind = 'pc') {
    if (!this.quiet) return false;
    const show = () => this.panel.say({ kind: 'info', face, line, hold });
    if (!kind || !this.initiative) return show() !== false;
    return this.initiative.offer(kind, show);
  }

  // could she say a line of this kind of her initiative's now
  may(kind = 'pc') {
    return this.quiet && (!this.initiative || this.initiative.allow(kind));
  }

  // waits a few seconds for her to be free to move, if she's busy
  async whenFree(ms = 6000) {
    for (let waited = 0; !this.capri.free && waited < ms; waited += 250) await new Promise((r) => setTimeout(r, 250));
    return this.capri.free;
  }

  async checkCpu() {
    if (!this.enabled) return;
    const cpu = await this.host.cpu().catch(() => null);
    if (cpu == null) return;
    const now = Date.now();
    if (cpu < HOT) {
      this.hotSince = 0;
      if (this.hot && cpu < 55) {
        this.hot = false;
        if (!this.panel.visible) this.say(pickLine(this.t.cool), 'calm', 3000);
      }
      return;
    }
    this.hotSince ||= now;
    if (this.hot || now - this.hotSince < HOT_FOR || now - this.hotAt < HOT_EVERY || !this.quiet) return;
    this.hotAt = now;
    if (!this.may()) return; // not now (her initiative): nor its "cooled down" after
    this.capri.wake();
    if (!this.say(fmt(pickLine(this.t.hot), { cpu }), 'wide', 5000)) return;
    this.hot = true;
    this.voice.play('charge');
    if (await this.whenFree()) this.capri.perform('overheat');
  }

  async watchBattery() {
    const battery = await navigator.getBattery?.().catch(() => null);
    if (!battery) return;
    const changed = () => this.battery(battery);
    battery.addEventListener('levelchange', changed);
    battery.addEventListener('chargingchange', changed);
    this.charging = battery.charging; // as it is when she starts: nothing to say
  }

  async battery({ level, charging }) {
    if (!this.enabled) return;
    const now = Date.now();
    if (charging !== this.charging) {
      this.charging = charging;
      if (now - this.chargerAt > CHARGER_EVERY) {
        this.chargerAt = now;
        if (charging) {
          this.warned = 1;
          if (this.say(pickLine(this.t.charging), 'laugh', 3500)) this.capri.recharge();
        } else {
          this.say(pickLine(this.t.unplugged), 'aside', 3500);
        }
      }
    }
    if (charging) return;
    const at = level <= 0.05 ? 0.05 : level <= 0.15 ? 0.15 : 1;
    if (at >= this.warned) return;
    this.warned = at;
    this.capri.wake();
    this.say(fmt(pickLine(at === 0.05 ? this.t.critical : this.t.low), { level: Math.round(level * 100) }), 'aside', 6000, null);
    if (await this.whenFree()) this.capri.drain();
  }

  offline() {
    clearTimeout(this.offlineTimer);
    // a blip isn't worth it
    this.offlineTimer = setTimeout(() => {
      if (navigator.onLine || !this.enabled) return;
      this.cutOff = true;
      this.voice.play('error');
      this.say(pickLine(this.t.offline), 'wide', 5000, null);
      this.capri.hurt();
    }, 4000);
  }

  online() {
    clearTimeout(this.offlineTimer);
    if (!this.cutOff) return;
    this.cutOff = false;
    if (!this.say(pickLine(this.t.online), 'laugh', 3500)) return;
    this.voice.play('hello');
    if (this.capri.free) this.capri.perform('hop');
  }

  // what windows.ps1 sees: USB sticks by letter, devices plugged in or out, the game in front
  onWindows({ usb = [], plug = null, game = null }) {
    if (!this.enabled) {
      this.drives = usb;
      this.plugs = plug?.n ?? 0;
      return;
    }
    if (this.drives) {
      const added = usb.find((d) => !this.drives.includes(d));
      const removed = this.drives.find((d) => !usb.includes(d));
      if (added) this.stick(added);
      else if (removed) this.say(pickLine(this.t.usbOut), 'smug', 3500);
    }
    this.drives = usb;

    if (this.plugs !== null && plug && plug.n !== this.plugs) this.device(plug);
    this.plugs = plug?.n ?? 0;

    const g = this.game;
    if (game) {
      if (g?.name === game) g.gone = 0;
      else this.game = { name: game, since: Date.now(), gone: 0, said: false, put: false };
    } else if (g && !g.gone) {
      g.gone = Date.now();
    }
  }

  // a USB stick: she dives into it to have a look
  async stick(drive) {
    if (!this.may()) return;
    this.capri.wake();
    if (!this.say(fmt(pickLine(this.t.usb), { drive }), 'look', 2500)) return;
    if (!this.quiet || !(await this.whenFree())) return;
    const { w, h } = this.capri.view;
    if (await this.capri.visit({ x: w - 140, y: h - 6 })) this.say(pickLine(this.t.usbBack), 'smug', 4500, null);
  }

  // anything else plugged in or out: a phone, a controller, a headset...
  device(plug) {
    const kind = kindOf(plug);
    if (kind === 'drive' || Date.now() - this.plugAt < PLUG_EVERY) return;
    if (!this.may()) return;
    this.plugAt = Date.now();
    const lines = plug.in ? this.t.plugIn : this.t.plugOut;
    this.capri.wake();
    // plugged in: a jolt of lightning down to where it came in (by the clock), before she talks
    if (plug.in && this.capri.free) {
      const { w, h } = this.capri.view;
      this.capri.zap(w - 140, h - 10);
    }
    this.say(fmt(pickLine(lines[kind] || lines.device), { name: plug.name }), plug.in ? 'look' : 'aside', 4000);
  }

  checkGame() {
    const g = this.game;
    if (!g || !this.enabled) return;
    const now = Date.now();
    // you're playing: a word about it, then she gets out of the way (she's always on top)
    if (!g.said && !g.gone && now - g.since >= GAME_AFTER) {
      g.said = true;
      if (this.capri.stowed || this.capri.mode === 'alert') return;
      if (this.may()) {
        this.capri.wake();
        this.say(fmt(pickLine(this.t.game), { game: g.name }), 'smug', 3000);
      }
      setTimeout(() => {
        if (this.game !== g || g.gone || this.capri.stowed || this.capri.mode === 'alert') return;
        g.put = true;
        this.capri.stow();
      }, 2600);
    }
    // done playing: she comes back, if she's the one who left
    if (g.gone && now - g.gone >= GAME_OVER) {
      this.game = null;
      if (g.put && this.capri.stowed && this.wantsOut()) {
        this.capri.unstow().then(() => this.say(pickLine(this.t.gameBack), 'look', 5000, null));
      }
    }
  }
}
