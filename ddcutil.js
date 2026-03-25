import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class DDCUtil {
  static DEFAULT_QUEUE_MS = 130;
  static DEFAULT_SLEEP_MULTIPLIER = 1.0;
  static DEFAULT_COMMAND_TIMEOUT_MS = 10000;
  static MIN_BRIGHTNESS = 1;

  static _debounceTimeout = null;
  static _commandQueue = Promise.resolve();
  static _resolvedPath = null;
  static _detectedDisplays = null;
  static _preferredDisplayKey = null;
  static _writeSequence = 0;
  static _activeProcesses = new Set();
  static _brightnessMetadata = new Map();
  static _generation = 0;
  static _settings = {
    queueMs: DDCUtil.DEFAULT_QUEUE_MS,
    sleepMultiplier: DDCUtil.DEFAULT_SLEEP_MULTIPLIER,
    commandTimeoutMs: DDCUtil.DEFAULT_COMMAND_TIMEOUT_MS,
    allowZeroBrightness: false,
    ddcutilPath: '',
    additionalArgs: '',
  };

  static _enqueue(task) {
    const run = this._commandQueue.then(task, task);
    this._commandQueue = run.catch(() => {});
    return run;
  }

  static _ensureGeneration(generation) {
    if (generation !== this._generation)
      throw new Error('DDCUtil session expired');
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
        this._activeProcesses.add(proc);

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
          this._activeProcesses.delete(proc);

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

        if (proc)
          this._activeProcesses.delete(proc);

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

  static _parseDetectOutput(output) {
    if (!output)
      return [];

    return output
      .split(/(?=^Display\s+\d+)/m)
      .map(block => block.trim())
      .filter(block => /^Display\s+\d+/m.test(block))
      .map(block => this._parseDisplayBlock(block))
      .filter(Boolean);
  }

  static _parseDisplayBlock(block) {
    const idMatch = /^Display\s+(\d+)/m.exec(block);
    if (!idMatch?.[1])
      return null;

    const readField = regex => regex.exec(block)?.[1]?.trim() ?? null;
    const monitor = readField(/^\s*Monitor:\s*(.+)$/mi);
    const manufacturer = readField(/^\s*Mfg id:\s*([^\n-]+?)(?:\s+-.*)?$/mi);
    let model = readField(/^\s*Model:\s*(.+)$/mi);

    if (!model && monitor) {
      if (manufacturer && monitor.startsWith(`${manufacturer} `))
        model = monitor.slice(manufacturer.length).trim();
      else
        model = monitor;
    }

    const display = {
      id: Number.parseInt(idMatch[1], 10),
      bus: readField(/^\s*I2C bus:\s*(.+)$/mi),
      connector: readField(/^\s*DRM connector:\s*(.+)$/mi),
      displayType: readField(/^\s*Display type:\s*(.+)$/mi),
      manufacturer,
      model,
      monitor,
      serial: readField(/^\s*Serial number:\s*(.+)$/mi),
      maxBrightness: null,
    };

    display.key = this._buildDisplayKey(display);
    return display;
  }

  static _buildDisplayKey(display) {
    if (display.connector)
      return `connector:${display.connector}`;

    if (display.serial)
      return `serial:${display.serial}`;

    if (display.bus)
      return `bus:${display.bus}`;

    if (display.manufacturer || display.model)
      return `model:${[display.manufacturer, display.model].filter(Boolean).join(':')}`;

    return `display:${display.id}`;
  }

  static _isBuiltinDisplay(display) {
    const connector = display.connector ?? '';
    const displayType = display.displayType ?? '';
    return /(^|[-_])(eDP|LVDS|DSI)([-_]|$)/i.test(connector) ||
      /builtin|built-in|internal|embedded|laptop/i.test(displayType);
  }

  static _getDisplayPriority(display) {
    if (this._isBuiltinDisplay(display))
      return -10;

    const connector = (display.connector ?? '').toUpperCase();

    if (/THUNDERBOLT|USB[-_ ]?C|TYPE[-_ ]?C/.test(connector))
      return 50;

    if (/DISPLAYPORT|(^|[-_])DP([-_]|$)/.test(connector))
      return 45;

    if (/HDMI/.test(connector))
      return 40;

    if (/DVI/.test(connector))
      return 30;

    if (/VGA/.test(connector))
      return 20;

    if (connector !== '')
      return 10;

    if (display.bus)
      return 5;

    return 0;
  }

  static _compareDisplays(left, right) {
    const priorityDiff = this._getDisplayPriority(right) - this._getDisplayPriority(left);
    if (priorityDiff !== 0)
      return priorityDiff;

    const connectorCompare = (left.connector ?? '').localeCompare(right.connector ?? '');
    if (connectorCompare !== 0)
      return connectorCompare;

    return left.id - right.id;
  }

  static _cacheBrightnessMetadata(display, maxBrightness) {
    if (!display || !Number.isFinite(maxBrightness) || maxBrightness <= 0)
      return;

    display.maxBrightness = maxBrightness;

    if (display.key)
      this._brightnessMetadata.set(display.key, maxBrightness);

    if (this._detectedDisplays) {
      const cachedDisplay = this._detectedDisplays.find(item => item.key === display.key);
      if (cachedDisplay)
        cachedDisplay.maxBrightness = maxBrightness;
    }
  }

  static _getCachedBrightnessMax(display) {
    if (!display)
      return null;

    if (Number.isFinite(display.maxBrightness) && display.maxBrightness > 0)
      return display.maxBrightness;

    const cachedMax = display.key ? this._brightnessMetadata.get(display.key) : null;
    return Number.isFinite(cachedMax) && cachedMax > 0 ? cachedMax : null;
  }

  static _parseBrightnessOutput(output) {
    if (!output)
      throw new Error('No output from ddcutil');

    const vcpLine = output.match(/^VCP.*$/gm)?.[0] ?? null;
    if (vcpLine) {
      if (/\bERR\b/i.test(vcpLine))
        throw new Error(vcpLine.trim());

      const values = vcpLine.match(/\d+/g)?.map(value => Number.parseInt(value, 10)) ?? [];
      if (values.length >= 3) {
        const [currentValue, maxValue] = values.slice(-2);
        if (Number.isFinite(currentValue) && Number.isFinite(maxValue) && maxValue > 0)
          return { currentValue, maxValue };
      }
    }

    const currentMatch = /current value\s*=\s*(\d+)/i.exec(output);
    const maxMatch = /max value\s*=\s*(\d+)/i.exec(output);

    if (currentMatch?.[1] && maxMatch?.[1]) {
      const currentValue = Number.parseInt(currentMatch[1], 10);
      const maxValue = Number.parseInt(maxMatch[1], 10);

      if (Number.isFinite(currentValue) && Number.isFinite(maxValue) && maxValue > 0)
        return { currentValue, maxValue };
    }

    throw new Error('Could not parse brightness from ddcutil output');
  }

  static async _readBrightnessInfo(display, generation) {
    this._ensureGeneration(generation);

    const output = await this._runCommand([
      'getvcp',
      '--brief',
      '10',
      '--display',
      String(display.id),
      '--sleep-multiplier',
      String(this._settings.sleepMultiplier),
    ]);

    this._ensureGeneration(generation);

    const { currentValue, maxValue } = this._parseBrightnessOutput(output);
    const percentage = Math.round((currentValue / maxValue) * 100);

    this._cacheBrightnessMetadata(display, maxValue);

    return {
      display,
      currentValue,
      maxValue,
      percentage,
    };
  }

  static async _getDisplayMaxBrightness(display, generation) {
    const cachedMax = this._getCachedBrightnessMax(display);
    if (cachedMax !== null)
      return cachedMax;

    const brightnessInfo = await this._readBrightnessInfo(display, generation);
    return brightnessInfo.maxValue;
  }

  static async detectDisplays(forceRefresh = false) {
    const generation = this._generation;

    if (!forceRefresh && this._detectedDisplays)
      return this._detectedDisplays;

    try {
      const output = await this._enqueue(async () => {
        this._ensureGeneration(generation);
        return this._runCommand(['detect'], { includeAdditionalArgs: false });
      });

      this._ensureGeneration(generation);
      this._detectedDisplays = this._parseDetectOutput(output).sort((left, right) =>
        this._compareDisplays(left, right),
      );
    } catch (error) {
      console.log(`[DDCUtil] Error detecting displays: ${error.message}`);
      if (error.message === 'ddcutil not found in PATH')
        throw error;

      this._detectedDisplays = [];
    }

    return this._detectedDisplays;
  }

  static _selectDisplay(displays) {
    if (!displays.length)
      return null;

    if (this._preferredDisplayKey) {
      const preferredDisplay = displays.find(display => display.key === this._preferredDisplayKey);
      if (preferredDisplay)
        return preferredDisplay;
    }

    const selectedDisplay = [...displays].sort((left, right) =>
      this._compareDisplays(left, right),
    )[0];

    if (selectedDisplay?.key)
      this._preferredDisplayKey = selectedDisplay.key;

    return selectedDisplay;
  }

  static async getDefaultDisplayInfo(forceRefresh = false) {
    const displays = await this.detectDisplays(forceRefresh);
    const selectedDisplay = this._selectDisplay(displays);

    if (!selectedDisplay)
      throw new Error('No DDC/CI display detected');

    return selectedDisplay;
  }

  static async getDefaultDisplay(forceRefresh = false) {
    const display = await this.getDefaultDisplayInfo(forceRefresh);
    return display.id;
  }

  static async getBrightness(display = null) {
    const generation = this._generation;

    try {
      const displayInfo = display === null
        ? await this.getDefaultDisplayInfo()
        : { id: display, key: `display:${display}`, maxBrightness: null };

      this._ensureGeneration(generation);

      const brightnessInfo = await this._enqueue(async () => {
        this._ensureGeneration(generation);
        return this._readBrightnessInfo(displayInfo, generation);
      });

      this._ensureGeneration(generation);

      if (displayInfo.key)
        this._preferredDisplayKey = displayInfo.key;

      return brightnessInfo.percentage;
    } catch (error) {
      console.log(`[DDCUtil] Error getting brightness: ${error.message}`);
      this.invalidateDisplayCache();
      throw error;
    }
  }

  static setBrightness(value, display = null) {
    if (this._debounceTimeout) {
      GLib.source_remove(this._debounceTimeout);
      this._debounceTimeout = null;
    }

    const generation = this._generation;
    const requestSequence = ++this._writeSequence;
    const newBrightness = Math.round(Math.max(0, Math.min(100, value)));

    this._debounceTimeout = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      this._settings.queueMs,
      () => {
        this._debounceTimeout = null;

        void (async () => {
          try {
            this._ensureGeneration(generation);

            const displayInfo = display === null
              ? await this.getDefaultDisplayInfo()
              : { id: display, key: `display:${display}`, maxBrightness: null };

            this._ensureGeneration(generation);

            await this._enqueue(async () => {
              this._ensureGeneration(generation);
              if (requestSequence !== this._writeSequence)
                return;

              const maxBrightness = await this._getDisplayMaxBrightness(displayInfo, generation);
              let rawBrightness = Math.round((newBrightness / 100) * maxBrightness);

              if (newBrightness > 0 && rawBrightness === 0)
                rawBrightness = this.MIN_BRIGHTNESS;

              if (rawBrightness === 0 && !this._settings.allowZeroBrightness)
                rawBrightness = Math.min(maxBrightness, this.MIN_BRIGHTNESS);

              if (requestSequence !== this._writeSequence)
                return;

              await this._runCommand([
                'setvcp',
                '10',
                String(rawBrightness),
                '--display',
                String(displayInfo.id),
                '--sleep-multiplier',
                String(this._settings.sleepMultiplier),
              ]);

              if (displayInfo.key)
                this._preferredDisplayKey = displayInfo.key;

              console.log(
                `[DDCUtil] Set brightness to ${newBrightness}% (raw ${rawBrightness}/${maxBrightness}) on display ${displayInfo.id}`,
              );
            });
          } catch (error) {
            if (generation !== this._generation)
              return;

            console.log(`[DDCUtil] Error setting brightness: ${error.message}`);
            this.invalidateDisplayCache();
          }
        })();

        return GLib.SOURCE_REMOVE;
      },
    );
  }

  static invalidateDisplayCache({ preservePreference = true } = {}) {
    this._detectedDisplays = null;
    this._brightnessMetadata.clear();

    if (!preservePreference)
      this._preferredDisplayKey = null;
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
    this._detectedDisplays = null;
    this._preferredDisplayKey = null;
    this._brightnessMetadata.clear();
  }

  static cleanup() {
    this._generation += 1;

    if (this._debounceTimeout) {
      GLib.source_remove(this._debounceTimeout);
      this._debounceTimeout = null;
    }

    for (const proc of this._activeProcesses) {
      try {
        proc.force_exit();
      } catch (error) {
        console.log(`[DDCUtil] Warning: failed to terminate subprocess during cleanup: ${error.message}`);
      }
    }

    this._activeProcesses.clear();
    this._commandQueue = Promise.resolve();
    this._resolvedPath = null;
    this._detectedDisplays = null;
    this._preferredDisplayKey = null;
    this._writeSequence = 0;
    this._brightnessMetadata.clear();
  }
}
