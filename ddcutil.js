import Gio from "gi://Gio";
import GLib from "gi://GLib";

export class DDCUtil {
  static DEFAULT_QUEUE_MS = 130;
  static DEFAULT_SLEEP_MULTIPLIER = 1.0;
  static MIN_BRIGHTNESS = 1;

  static _debounceTimeout = null;
  static _settings = {
    queueMs: DDCUtil.DEFAULT_QUEUE_MS,
    sleepMultiplier: DDCUtil.DEFAULT_SLEEP_MULTIPLIER,
    allowZeroBrightness: false,
    ddcutilPath: "/usr/bin/ddcutil",
    additionalArgs: "",
  };
  static _isAvailable = null;

  static isAvailable() {
    if (this._isAvailable !== null) {
      return this._isAvailable;
    }

    const file = Gio.File.new_for_path(this._settings.ddcutilPath);
    this._isAvailable = file.query_exists(null);

    if (!this._isAvailable) {
      console.log(`[DDCUtil] Warning: ${this._settings.ddcutilPath} not found`);
    }

    return this._isAvailable;
  }

  static _parseAdditionalArgs(argsString) {
    if (!argsString || argsString.trim() === "") {
      return [];
    }

    const args = [];
    let current = "";
    let inQuotes = false;
    let quoteChar = "";

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i];

      if ((char === '"' || char === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuotes) {
        inQuotes = false;
        quoteChar = "";
      } else if (char === " " && !inQuotes) {
        if (current.trim() !== "") {
          args.push(current.trim());
        }
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim() !== "") {
      args.push(current.trim());
    }

    return args;
  }

  static _spawnWithCallback(argv, callback) {
    try {
      const proc = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
      );

      proc.communicate_utf8_async(null, null, (proc, res) => {
        try {
          const [, stdout, stderr] = proc.communicate_utf8_finish(res);
          if (proc.get_successful()) {
            callback(null, stdout);
          } else {
            const error = stderr || stdout || "Unknown error";
            callback(new Error(error.trim()), null);
          }
        } catch (e) {
          callback(e, null);
        }
      });
    } catch (e) {
      callback(e, null);
    }
  }

  static async _runCommand(args) {
    return new Promise((resolve, reject) => {
      if (!this.isAvailable()) {
        reject(new Error(`ddcutil not found at ${this._settings.ddcutilPath}`));
        return;
      }

      const additionalArgs = this._parseAdditionalArgs(
        this._settings.additionalArgs,
      );
      const fullArgs = [this._settings.ddcutilPath, ...args, ...additionalArgs];

      this._spawnWithCallback(fullArgs, (error, output) => {
        if (error) {
          reject(error);
        } else if (
          output &&
          (output.includes("DDC communication failed") ||
            output.includes("No monitor detected"))
        ) {
          reject(new Error(output.trim()));
        } else {
          resolve(output ? output.trim() : "");
        }
      });
    });
  }

  static async getBrightness(display = 1) {
    try {
      const sleepMultiplier = (this._settings.sleepMultiplier / 40).toFixed(3);
      const args = [
        "getvcp",
        "--brief",
        "10",
        "--display",
        String(display),
        "--sleep-multiplier",
        sleepMultiplier,
      ];

      const output = await this._runCommand(args);
      if (!output) {
        throw new Error("No output from ddcutil");
      }

      const vcpMatch = output.match(/^VCP.*$/gm);
      if (vcpMatch !== null) {
        const parts = vcpMatch.join("\n").split(/\s+/);
        if (parts.length >= 5 && parts[2] !== "ERR") {
          const value = parseInt(parts[3], 10);
          if (!isNaN(value)) {
            return value;
          }
        }
      }

      const match = /current value =\s*(\d+)/i.exec(output);
      if (match && match[1]) {
        const value = parseInt(match[1], 10);
        if (!isNaN(value)) {
          return value;
        }
      }

      throw new Error("Could not parse brightness from ddcutil output");
    } catch (e) {
      console.log(`[DDCUtil] Error getting brightness: ${e.message}`);
      throw e;
    }
  }

  static setBrightness(value, display = 1) {
    if (this._debounceTimeout) {
      GLib.source_remove(this._debounceTimeout);
      this._debounceTimeout = null;
    }

    let newBrightness = Math.round(Math.max(0, Math.min(100, value)));

    if (newBrightness === 0 && !this._settings.allowZeroBrightness) {
      newBrightness = this.MIN_BRIGHTNESS;
    }

    this._debounceTimeout = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._settings.queueMs,
      () => {
        this._debounceTimeout = null;

        if (!this.isAvailable()) {
          return GLib.SOURCE_REMOVE;
        }

        const sleepMultiplier = (this._settings.sleepMultiplier / 40).toFixed(
          3,
        );
        const additionalArgs = this._parseAdditionalArgs(
          this._settings.additionalArgs,
        );

        const args = [
          "setvcp",
          "10",
          String(newBrightness),
          "--display",
          String(display),
          "--sleep-multiplier",
          sleepMultiplier,
          ...additionalArgs,
        ];

        try {
          Gio.Subprocess.new(
            [this._settings.ddcutilPath, ...args],
            Gio.SubprocessFlags.NONE,
          );
          console.log(`[DDCUtil] Set brightness to ${newBrightness}%`);
        } catch (e) {
          console.log(`[DDCUtil] Error setting brightness: ${e.message}`);
        }

        return GLib.SOURCE_REMOVE;
      },
    );
  }

  static configure(options = {}) {
    this._settings = {
      ...this._settings,
      ...options,
    };
    this._isAvailable = null;
  }

  static cleanup() {
    if (this._debounceTimeout) {
      GLib.source_remove(this._debounceTimeout);
      this._debounceTimeout = null;
    }
  }
}
