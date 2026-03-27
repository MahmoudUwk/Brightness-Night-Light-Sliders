import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class DDCUtil {
  static DEFAULT_QUEUE_MS = 130;
  static DEFAULT_SLEEP_MULTIPLIER = 1.0;
  static DEFAULT_COMMAND_TIMEOUT_MS = 10000;
  static MIN_BRIGHTNESS = 1;

  static _debounceTimeout = null;
  static _resolvedPath = null;
  static _defaultDisplayId = null;
  static _activeProcess = null;
  static _settings = {
    queueMs: DDCUtil.DEFAULT_QUEUE_MS,
    sleepMultiplier: DDCUtil.DEFAULT_SLEEP_MULTIPLIER,
    commandTimeoutMs: DDCUtil.DEFAULT_COMMAND_TIMEOUT_MS,
    ddcutilPath: '',
    additionalArgs: '',
  };

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

    try {
      const [, args] = GLib.shell_parse_argv(argsString);
      return args;
    } catch (error) {
      console.log(`[DDCUtil] Warning: could not parse additionalArgs: ${error.message}`);
      return [];
    }
  }

  static _spawn(argv) {
    return new Promise((resolve, reject) => {
      let timeoutId = null;
      let timedOut = false;
      const timeoutMs = Math.max(0, this._settings.commandTimeoutMs ?? 0);
      let proc = null;

      try {
        proc = Gio.Subprocess.new(
          argv,
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );
        this._activeProcess = proc;

        if (timeoutMs > 0) {
          timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timeoutId = null;
            timedOut = true;

            try {
              proc.force_exit();
            } catch (error) {
              console.log(`[DDCUtil] Warning: failed to terminate timed out command: ${error.message}`);
            }

            return GLib.SOURCE_REMOVE;
          });
        }

        proc.communicate_utf8_async(null, null, (subprocess, res) => {
          if (this._activeProcess === proc)
            this._activeProcess = null;

          if (timeoutId !== null) {
            GLib.source_remove(timeoutId);
            timeoutId = null;
          }

          try {
            const [, stdout, stderr] = subprocess.communicate_utf8_finish(res);
            if (timedOut) {
              reject(new Error(`ddcutil command timed out after ${timeoutMs}ms`));
              return;
            }

            if (!subprocess.get_successful()) {
              reject(new Error((stderr || stdout || 'Unknown error').trim()));
              return;
            }

            resolve((stdout || '').trim());
          } catch (error) {
            if (timedOut) {
              reject(new Error(`ddcutil command timed out after ${timeoutMs}ms`));
              return;
            }

            reject(error);
          }
        });
      } catch (error) {
        if (timeoutId !== null)
          GLib.source_remove(timeoutId);

        if (proc && this._activeProcess === proc)
          this._activeProcess = null;

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

  static _parseDefaultDisplayId(output) {
    const match = /^Display\s+(\d+)/m.exec(output);
    return match?.[1] ? Number.parseInt(match[1], 10) : null;
  }

  static async _getDefaultDisplayId(forceRefresh = false) {
    if (!forceRefresh && Number.isInteger(this._defaultDisplayId))
      return this._defaultDisplayId;

    const output = await this._runCommand(['detect'], { includeAdditionalArgs: false });
    const displayId = this._parseDefaultDisplayId(output);

    if (!Number.isInteger(displayId))
      throw new Error('No DDC/CI display detected');

    this._defaultDisplayId = displayId;
    return displayId;
  }

  static _clampBrightness(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  static async _writeBrightness(value, display = null, forceRefresh = false) {
    const displayId = display === null
      ? await this._getDefaultDisplayId(forceRefresh)
      : display;

    const brightness = this._clampBrightness(value);
    let rawBrightness = brightness;

    if (brightness > 0 && rawBrightness === 0)
      rawBrightness = this.MIN_BRIGHTNESS;

    if (brightness === 0)
      rawBrightness = 0;

    await this._runCommand([
      'setvcp',
      '10',
      String(rawBrightness),
      '--display',
      String(displayId),
      '--sleep-multiplier',
      String(this._settings.sleepMultiplier),
    ]);

    console.log(`[DDCUtil] Set brightness to ${brightness}% on display ${displayId}`);
  }

  static setBrightness(value, display = null) {
    if (this._debounceTimeout) {
      GLib.source_remove(this._debounceTimeout);
      this._debounceTimeout = null;
    }

    this._debounceTimeout = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._settings.queueMs,
      () => {
        this._debounceTimeout = null;

        void this._writeBrightness(value, display).catch((error) => {
          console.log(`[DDCUtil] Error setting brightness: ${error.message}`);
          this.invalidateDisplayCache();
        });

        return GLib.SOURCE_REMOVE;
      },
    );
  }

  static invalidateDisplayCache() {
    this._defaultDisplayId = null;
  }

  static handleMonitorTopologyChange() {
    this.invalidateDisplayCache();
  }

  static configure(options = {}) {
    this._settings = {
      ...this._settings,
      ...options,
    };
    this._resolvedPath = null;
    this._defaultDisplayId = null;
  }

  static cleanup() {
    if (this._debounceTimeout) {
      GLib.source_remove(this._debounceTimeout);
      this._debounceTimeout = null;
    }

    if (this._activeProcess) {
      try {
        this._activeProcess.force_exit();
      } catch (error) {
        console.log(`[DDCUtil] Warning: failed to terminate subprocess during cleanup: ${error.message}`);
      }
      this._activeProcess = null;
    }

    this._resolvedPath = null;
    this._defaultDisplayId = null;
  }
}
