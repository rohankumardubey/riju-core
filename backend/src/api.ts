import * as fs from "fs";
import * as pty from "node-pty";
import { IPty } from "node-pty";
import * as path from "path";
import * as tmp from "tmp";
import * as WebSocket from "ws";

import { LangConfig, langs } from "./langs";

export class Session {
  code: string;
  config: LangConfig;
  term: { pty: IPty; live: boolean };
  ws: WebSocket;

  constructor(ws: WebSocket, lang: string) {
    this.ws = ws;
    this.config = langs[lang];
    this.term = { pty: null, live: false };
    this.code = "";
    this.ws.send(
      JSON.stringify({
        event: "setMonacoLanguage",
        monacoLanguage: this.config.monacoLang,
      })
    );
    if (this.config.template) {
      this.ws.send(
        JSON.stringify({
          event: "insertTemplate",
          template: this.config.template,
        })
      );
    }
    this.run().catch(console.error);
    ws.on("message", this.handleClientMessage);
  }
  handleClientMessage = (event: string) => {
    let msg: any;
    try {
      msg = JSON.parse(event);
    } catch (err) {
      console.error(`failed to parse client message: ${msg}`);
      return;
    }
    switch (msg?.event) {
      case "terminalInput":
        if (!this.term) {
          console.error(`terminalInput: no terminal`);
        } else if (typeof msg.input !== "string") {
          console.error(`terminalInput: missing or malformed input field`);
        } else {
          this.term.pty.write(msg.input);
        }
        break;
      case "runCode":
        if (typeof msg.code !== "string") {
          console.error(`runCode: missing or malformed code field`);
        } else {
          this.code = msg.code;
          this.run();
        }
        break;
      default:
        console.error(`unknown client message type: ${msg.event}`);
        break;
    }
  };
  run = async () => {
    const { repl, file, suffix, compile, run } = this.config;
    if (this.term.pty) {
      this.term.pty.kill();
      this.term.live = false;
    }
    this.ws.send(JSON.stringify({ event: "terminalClear" }));
    const tmpdir: string = await new Promise((resolve, reject) =>
      tmp.dir({ unsafeCleanup: true }, (err, path) => {
        if (err) {
          reject(err);
        } else {
          resolve(path);
        }
      })
    );
    let cmdline: string;
    if (!run) {
      cmdline = `echo 'Support for ${this.config.name} is not yet implemented.`;
    } else if (this.code) {
      let code = this.code;
      if (suffix) {
        code += suffix;
      }
      await new Promise((resolve, reject) =>
        fs.writeFile(path.resolve(tmpdir, file), code, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        })
      );
      cmdline = run;
      if (compile) {
        cmdline = compile + " && " + run;
      }
    } else if (repl) {
      cmdline = repl;
    } else {
      return;
    }
    const term = {
      pty: pty.spawn("bash", ["-c", cmdline], {
        name: "xterm-color",
        cwd: tmpdir,
        env: process.env,
      }),
      live: true,
    };
    this.term = term;
    term.pty.on("data", (data) => {
      // Capture term in closure so that we don't keep sending output
      // from the old pty even after it's been killed (see ghci).
      if (term.live) {
        this.ws.send(JSON.stringify({ event: "terminalOutput", output: data }));
      }
    });
  };
}