import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class DDCUtil {
  static DEFAULT_QUEUE_MS = 130;
  static DEFAULT_SLEEP_MULTIPLIER = 1.0;
  static MIN_BRIGHTNESS = 1;

  static _debounceTimeout = null;
  static _commandQueue = Promise.resolve();
  static _resolvedPath = null;
  static _detectedDisplays = null;
  static _settings = {
    queueMs: DDCUtil.DEFAULT_QUEUE_MS,
    sleepMultiplier: DDCUtil.DEFAULT_SLEEP_MULTIPLIER,
    allowZeroBrightness: false,
    ddcutilPath: '',
    additionalArgs: '',
  };

  static _enqueue(task) {
    const run = this._commandQueue.then(task, task);
    this._commandQueue = run.catch(() => {});
    return run;
  }

  static _getCommandPath() {
    if (this._resolvedPath)
      return this._resolvedPath;

    const configuredPath = this._settings.ddcutilPath?.trim();
    if (configuredPath) {
      const file = Gio.File.new_for_path(configuredPath);
      if (file.query_exists(null)) {
        this._resolvedPath = configuredPath;
        return this._resolvedPath;
      }
    }

    this._resolvedPath = GLib.find_program_in_path('ddcutil');
    return this._resolvedPath;
  }

  static isAvailable() {
    const path = this._getCommandPath();

    if (!path)
      console.log('[DDCUtil] Warning: ddcutil not found in PATH');

    return Boolean(path);
  }

  static _parseAdditionalArgs(argsString) {
    if (!argsString || argsString.trim() === '')
      return [];

    const args = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i];

      if ((char === '"' || char === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuotes) {
        inQuotes = false;
        quoteChar = '';
      } else if (char === ' ' && !inQuotes) {
        if (current.trim() !== '')
          args.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim() !== '')
      args.push(current.trim());

    return args;
  }

  static _spawn(argv) {
    return new Promise((resolve, reject) => {
      try {
        const proc = Gio.Subprocess.new(
          argv,
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );

        proc.communicate_utf8_async(null, null, (subprocess, res) => {
          try {
            const [, stdout, stderr] = subprocess.communicate_utf8_finish(res);
            if (!subprocess.get_successful()) {
              reject(new Error((stderr || stdout || 'Unknown error').trim()));
              return;
            }

            resolve((stdout || '').trim());
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  static async _runCommand(args, { includeAdditionalArgs = true } = {}) {
    const commandPath = this._getCommandPath();
    if (!commandPath)
      throw new Error('ddcutil not found in PATH');

    const extraArgs = includeAdditionalArgs
      ? this._parseAdditionalArgs(this._settings.additionalArgs)
      : [];

    return this._spawn([commandPath, ...args, ...extraArgs]);
  }

  static async detectDisplays(forceRefresh = false) {
    if (!forceRefresh && this._detectedDisplays)
      return this._detectedDisplays;

    const detect = async args => {
      try {
        return await this._runCommand(args, { includeAdditionalArgs: false });
      } catch (error) {
        return '';
      }
    };

    const output = await this._enqueue(async () => {
      const briefOutput = await detect(['detect', '--brief']);
      if (briefOutput)
        return briefOutput;

      return detect(['detect']);
    });

    const matches = [...output.matchAll(/Display\s+(\d+)/g)];
    this._detectedDisplays = matches.map(match => Number.parseInt(match[1], 10));
    return this._detectedDisplays;
  }

  static async getDefaultDisplay(forceRefresh = false) {
    const displays = await this.detectDisplays(forceRefresh);

    if (!displays.length)
      throw new Error('No DDC/CI display detected');

    return displays[0];
  }

  static async getBrightness(display = null) {
    const resolvedDisplay = display ?? await this.getDefaultDisplay();

    try {
      const output = await this._enqueue(() => this._runCommand([
        'getvcp',
        '--brief',
        '10',
        '--display',
        String(resolvedDisplay),
        '--sleep-multiplier',
        String(this._settings.sleepMultiplier),
      ]));

      if (!output)
        throw new Error('No output from ddcutil');

      const vcpMatch = output.match(/^VCP.*$/gm);
      if (vcpMatch !== null) {
        const parts = vcpMatch.join('\n').split(/\s+/);
        if (parts.length >= 5 && parts[2] !== 'ERR') {
          const value = Number.parseInt(parts[3], 10);
          if (!Number.isNaN(value))
            return value;
        }
      }

      const match = /current value =\s*(\d+)/i.exec(output);
      if (match?.[1]) {
        const value = Number.parseInt(match[1], 10);
        if (!Number.isNaN(value))
          return value;
      }

      throw new Error('Could not parse brightness from ddcutil output');
    } catch (error) {
      console.log(`[DDCUtil] Error getting brightness: ${error.message}`);
      throw error;
    }
  }

  static setBrightness(value, display = null) {
    if (this._debounceTimeout) {
      GLib.source_remove(this._debounceTimeout);
      this._debounceTimeout = null;
    }

    let newBrightness = Math.round(Math.max(0, Math.min(100, value)));
    if (newBrightness === 0 && !this._settings.allowZeroBrightness)
      newBrightness = this.MIN_BRIGHTNESS;

    this._debounceTimeout = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._settings.queueMs,
      () => {
        this._debounceTimeout = null;

        void this._enqueue(async () => {
          try {
            const resolvedDisplay = display ?? await this.getDefaultDisplay();
            await this._runCommand([
              'setvcp',
              '10',
              String(newBrightness),
              '--display',
              String(resolvedDisplay),
              '--sleep-multiplier',
              String(this._settings.sleepMultiplier),
            ]);

            console.log(
              `[DDCUtil] Set brightness to ${newBrightness}% on display ${resolvedDisplay}`,
            );
          } catch (error) {
            console.log(`[DDCUtil] Error setting brightness: ${error.message}`);
            this._detectedDisplays = null;
          }
        });

        return GLib.SOURCE_REMOVE;
      },
    );
  }

  static configure(options = {}) {
    this._settings = {
      ...this._settings,
      ...options,
    };
    this._resolvedPath = null;
    this._detectedDisplays = null;
  }

  static cleanup() {
    if (this._debounceTimeout) {
      GLib.source_remove(this._debounceTimeout);
      this._debounceTimeout = null;
    }
  }
}
