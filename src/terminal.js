import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";

function xtermTheme(k) {
  return {
    foreground: k.foreground, background: k.background,
    cursor: k.cursor, cursorAccent: k.cursor_text_color,
    selectionBackground: k.selection_background, selectionForeground: k.selection_foreground,
    black: k.color0, red: k.color1, green: k.color2, yellow: k.color3,
    blue: k.color4, magenta: k.color5, cyan: k.color6, white: k.color7,
    brightBlack: k.color8, brightRed: k.color9, brightGreen: k.color10, brightYellow: k.color11,
    brightBlue: k.color12, brightMagenta: k.color13, brightCyan: k.color14, brightWhite: k.color15,
  };
}

// xterm.js wired to the server's persistent shell, dressed in your kitty
// font and colours.
export class Term {
  constructor(parent, kitty, { fontSize, onStatus }) {
    this.onStatus = onStatus;
    parent.style.background = kitty.background;
    this.term = new Terminal({
      fontFamily: `"${kitty.font_family}", Menlo, monospace`,
      fontSize,
      lineHeight: 1.1,
      theme: xtermTheme(kitty),
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
      drawBoldTextInBrightColors: false,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = "11";
    this.term.open(parent);
    // WebGL is flaky on phones (blank at narrow sizes, lost when the tab is
    // backgrounded); the DOM renderer is plenty fast there.
    if (!matchMedia("(pointer: coarse)").matches) try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      this.term.loadAddon(gl);
    } catch {}

    // Shift+Enter inserts a newline in Claude Code (it sends Esc+CR, which
    // is what kitty's own mapping for Claude does).
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey) {
        this.send({ t: "in", d: "\x1b\r" });
        return false;
      }
      return true;
    });

    this.term.onData((d) => this.send({ t: "in", d }));
    new ResizeObserver(() => this.resize()).observe(parent);
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/pty`);
    this.ws.onopen = () => {
      this.onStatus("connected");
      this.term.reset();
      this.resize(true);
    };
    this.ws.onmessage = (e) => this.term.write(e.data);
    this.ws.onclose = () => {
      this.onStatus("disconnected");
      setTimeout(() => this.connect(), 1000);
    };
  }

  send(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  resize(force = false) {
    const before = `${this.term.cols}x${this.term.rows}`;
    try { this.fit.fit(); } catch { return; }
    if (force || before !== `${this.term.cols}x${this.term.rows}`) {
      this.send({ t: "resize", cols: this.term.cols, rows: this.term.rows });
    }
  }

  setFontSize(px) {
    this.term.options.fontSize = px;
    this.resize(true);
  }

  // Keys a phone keyboard lacks, for the on-screen key row.
  key(name) {
    const app = this.term.modes.applicationCursorKeysMode;
    const arrow = (c) => (app ? `\x1bO${c}` : `\x1b[${c}`);
    const seq = {
      esc: "\x1b", tab: "\t", stab: "\x1b[Z", ctrlc: "\x03", enter: "\r", newline: "\x1b\r",
      up: arrow("A"), down: arrow("B"), right: arrow("C"), left: arrow("D"),
    }[name];
    if (seq) this.send({ t: "in", d: seq });
  }

  run(cmd) {
    this.send({ t: "in", d: cmd + "\r" });
    this.term.focus();
  }

  restart() {
    this.send({ t: "restart" });
    this.term.reset();
    this.term.focus();
  }
}
