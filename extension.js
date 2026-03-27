import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import { DDCUtil } from "./ddcutil.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
  QuickSlider,
  SystemIndicator,
} from "resource:///org/gnome/shell/ui/quickSettings.js";
import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";

const getQuickSettings = () => Main.panel?.statusArea?.quickSettings ?? null;
const QUICK_SETTINGS_RETRY_MS = 250;
const QUICK_SETTINGS_MAX_RETRIES = 40;

const CONFIG = {
  DEBUG: false,
  TOPOLOGY_DEBOUNCE_MS: 1000,
  SYNC_DEBOUNCE_MS: 100,
};

const debugLog = (msg) => CONFIG.DEBUG && console.log(`[BNLS DEBUG] ${msg}`);
const extLog = (msg) => console.log("[BrightnessNightLightSliders]", msg);

function safeGetMonitors() {
  try {
    const monitorManager = Main.layoutManager?.monitorManager;
    if (monitorManager && typeof monitorManager.get_n_monitors === "function") {
      return monitorManager.get_n_monitors();
    }
    const monitors = Main.layoutManager?.monitors;
    return monitors ? monitors.length : 0;
  } catch {
    return 0;
  }
}

const BrightnessSlider = GObject.registerClass(
  class BrightnessSlider extends QuickSlider {
    _init() {
      super._init({
        iconName: "display-brightness-symbolic",
      });

      this.add_style_class_name("bnl-slider");
      this._supportsBrightness = DDCUtil.isAvailable();
      this.visible = this._supportsBrightness;

      this._destroyed = false;
      this._syncIdleId = null;
      this._syncBusy = false;
      this._syncRerunPending = false;
      this._forceRefreshPending = false;
      this._lastErrorMessage = null;

      this._syncRequestId = 0;

      this._monitorCount = safeGetMonitors();

      this.slider.accessible_name = _("Brightness");
      this._sliderChangedId = this.slider.connect(
        "notify::value",
        this._sliderChanged.bind(this),
      );

      if (this._supportsBrightness) {
        this._monitorsChangedId = null;
      }
    }

    _sliderChanged() {
      if (this._destroyed || !this._supportsBrightness)
        return;

      this._userInteracting = true;

      if (this._interactionTimeoutId) {
        GLib.source_remove(this._interactionTimeoutId);
        this._interactionTimeoutId = null;
      }

      this._interactionTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        500,
        () => {
          this._interactionTimeoutId = null;
          this._userInteracting = false;
          return GLib.SOURCE_REMOVE;
        },
      );

      const level = Math.round(this.slider.value * 100);
      DDCUtil.setBrightness(level);
    }

    _queueSync(forceRefresh = false) {
      if (this._destroyed || !this._supportsBrightness)
        return;

      this._forceRefreshPending = this._forceRefreshPending || forceRefresh;

      if (this._syncBusy) {
        this._syncRerunPending = true;
        return;
      }

      if (this._syncIdleId)
        return;

      this._syncIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._syncIdleId = null;

        if (this._destroyed || !this._supportsBrightness)
          return GLib.SOURCE_REMOVE;

        const shouldForceRefresh = this._forceRefreshPending;
        this._forceRefreshPending = false;
        void this._syncBrightness(shouldForceRefresh);

        return GLib.SOURCE_REMOVE;
      });
    }

    async _syncBrightness(forceRefresh = false) {
      if (this._destroyed || !this._supportsBrightness)
        return;

      if (this._syncBusy) {
        this._syncRerunPending = true;
        this._forceRefreshPending = this._forceRefreshPending || forceRefresh;
        return;
      }

      this._syncBusy = true;
      const requestId = ++this._syncRequestId;
      const topologyGen = this._topologyGeneration;
      const shouldForceRefresh = this._forceRefreshPending || forceRefresh;
      this._forceRefreshPending = false;

      try {
        const currentMonitors = safeGetMonitors();
        if (currentMonitors === 0) {
          debugLog("No monitors detected, skipping sync");
          return;
        }

        const level = await DDCUtil.getBrightness();

        if (this._destroyed) {
          debugLog("Destroyed during getBrightness, aborting");
          return;
        }

        if (requestId !== this._syncRequestId) {
          debugLog(`Stale sync result (request ${requestId} != current ${this._syncRequestId}), discarding`);
          return;
        }

        if (!this._sliderChangedId || !this.slider) {
          debugLog("Slider already destroyed");
          return;
        }

        if (this._userInteracting) {
          debugLog("User interacting, skipping slider update");
          return;
        }

        this.slider.block_signal_handler(this._sliderChangedId);
        this.slider.value = level / 100;
        this.slider.unblock_signal_handler(this._sliderChangedId);
        this.visible = true;
        this._lastErrorMessage = null;

        debugLog(`Brightness synced: ${level}%`);
      } catch (error) {
        if (this._destroyed) {
          debugLog("Destroyed during error handling");
          return;
        }

        if (requestId !== this._syncRequestId) {
          debugLog(`Stale error (request ${requestId}), ignoring`);
          return;
        }

        const message = error?.message ?? String(error);
        debugLog(`Sync error: ${message}`);

        if (message === 'ddcutil not found in PATH' || message === 'No DDC/CI display detected') {
          this.visible = false;
        } else {
          this.visible = true;
        }

        if (message !== this._lastErrorMessage) {
          this._lastErrorMessage = message;
          extLog(`Could not sync brightness: ${message}`);
        }
      } finally {
        this._syncBusy = false;

        if (this._syncRerunPending && !this._destroyed) {
          this._syncRerunPending = false;
          this._queueSync(this._forceRefreshPending);
        }
      }
    }

    destroy() {
      debugLog("Destroying BrightnessSlider");
      this._destroyed = true;
      this._syncRequestId++;

      if (this._syncIdleId) {
        GLib.source_remove(this._syncIdleId);
        this._syncIdleId = null;
      }

      if (this._interactionTimeoutId) {
        GLib.source_remove(this._interactionTimeoutId);
        this._interactionTimeoutId = null;
      }

      this._monitorsChangedId = null;

      if (this._sliderChangedId) {
        try {
          this.slider.disconnect(this._sliderChangedId);
        } catch (e) {
          debugLog(`Error disconnecting slider: ${e.message}`);
        }
        this._sliderChangedId = null;
      }

      super.destroy();
    }
  },
);

const ICON_NAME = "night-light-symbolic";
const COLOR_SCHEMA = "org.gnome.settings-daemon.plugins.color";
const TEMPERATURE_KEY = "night-light-temperature";
const ENABLE_KEY = "night-light-enabled";

class TemperatureUtils {
  static MIN_TEMP = 1700;
  static MAX_TEMP = 4700;

  static clamp(value) {
    if (!Number.isFinite(value))
      return 0;

    return Math.min(1, Math.max(0, value));
  }

  static normalize(temp) {
    const normalized = 1 - (temp - this.MIN_TEMP) / (this.MAX_TEMP - this.MIN_TEMP);
    return this.clamp(normalized);
  }

  static denormalize(value) {
    return Math.round(
      (1 - this.clamp(value)) * (this.MAX_TEMP - this.MIN_TEMP) + this.MIN_TEMP,
    );
  }
}

const NightLightItem = GObject.registerClass(
  class NightLightItem extends QuickSlider {
    _init() {
      super._init({
        iconName: ICON_NAME,
      });

      this.add_style_class_name("bnl-slider");

      this._settingsConnections = [];
      this._sliderChangedId = null;

      this._settings = new Gio.Settings({ schema_id: COLOR_SCHEMA });

      this._updateVisibility();

      this._settingsConnections.push(
        this._settings.connect(`changed::${ENABLE_KEY}`, () =>
          this._updateVisibility(),
        ),
      );

      this._settingsConnections.push(
        this._settings.connect(`changed::${TEMPERATURE_KEY}`, () =>
          this._sync(),
        ),
      );

      this._sliderChangedId = this.slider.connect(
        "notify::value",
        this._sliderChanged.bind(this),
      );

      this.slider.accessible_name = _("Night Light");

      this._sync();
    }

    _updateVisibility() {
      const enable = this._settings.get_boolean(ENABLE_KEY);
      this.visible = enable;
    }

    _sliderChanged() {
      const value = this.slider.value;
      const temperature = TemperatureUtils.denormalize(value);

      this._settings.set_uint(TEMPERATURE_KEY, temperature);
    }

    _sync() {
      const temperature = this._settings.get_uint(TEMPERATURE_KEY);
      const value = TemperatureUtils.normalize(temperature);
      if (!this._sliderChangedId)
        return;

      this.slider.block_signal_handler(this._sliderChangedId);
      this.slider.value = value;
      this.slider.unblock_signal_handler(this._sliderChangedId);
    }

    destroy() {
      this._settingsConnections.forEach((id) => {
        try {
          this._settings.disconnect(id);
        } catch {
          // Signal may already be disconnected
        }
      });

      this._settingsConnections = [];

      if (this._sliderChangedId) {
        try {
          this.slider.disconnect(this._sliderChangedId);
        } catch {
          // Already disconnected
        }
        this._sliderChangedId = null;
      }

      super.destroy();
    }
  },
);

const Indicator = GObject.registerClass(
  class Indicator extends SystemIndicator {
    _init() {
      super._init();
      this._quickSettingsAttachRetryId = null;
      this._quickSettingsAttachAttempts = 0;
      this._quickSettingsAttached = false;
      this._quickSettingsWarningLogged = false;

      const brightnessSlider = new BrightnessSlider();
      const nightLightItem = new NightLightItem();

      this.quickSettingsItems.push(brightnessSlider);
      this.quickSettingsItems.push(nightLightItem);

      this._attachToQuickSettings(brightnessSlider);
    }

    _attachToQuickSettings(brightnessSlider) {
      if (this._quickSettingsAttached)
        return;

      const quickSettings = getQuickSettings();
      if (quickSettings) {
        try {
          quickSettings.addExternalIndicator(this, 2);
          this._quickSettingsAttached = true;
          this._quickSettingsAttachAttempts = 0;
          this._quickSettingsWarningLogged = false;
        } catch (e) {
          extLog(`Error attaching to Quick Settings: ${e.message}`);
          this._quickSettingsAttachAttempts += 1;
          if (!this._quickSettingsAttachRetryId) {
            this._quickSettingsAttachRetryId = GLib.timeout_add(
              GLib.PRIORITY_DEFAULT,
              QUICK_SETTINGS_RETRY_MS,
              () => {
                this._quickSettingsAttachRetryId = null;
                this._attachToQuickSettings(brightnessSlider);
                return GLib.SOURCE_REMOVE;
              },
            );
          }
        }
        return;
      }

      if (this._quickSettingsAttachAttempts >= QUICK_SETTINGS_MAX_RETRIES) {
        if (!this._quickSettingsWarningLogged) {
          extLog("Quick Settings were not ready; the sliders were not attached");
          this._quickSettingsWarningLogged = true;
        }
        return;
      }

      if (this._quickSettingsAttachRetryId)
        return;

      this._quickSettingsAttachRetryId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        QUICK_SETTINGS_RETRY_MS,
        () => {
          this._quickSettingsAttachRetryId = null;
          this._quickSettingsAttachAttempts += 1;
          this._attachToQuickSettings(brightnessSlider);
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    destroy() {
      if (this._quickSettingsAttachRetryId) {
        GLib.source_remove(this._quickSettingsAttachRetryId);
        this._quickSettingsAttachRetryId = null;
      }

      this._quickSettingsAttached = false;
      this.quickSettingsItems.forEach((item) => {
        try {
          item.destroy();
        } catch (e) {
          debugLog(`Error destroying item: ${e.message}`);
        }
      });
      this.quickSettingsItems = [];
      super.destroy();
    }
  },
);

export default class BrightnessAndNightLightSlidersExtension extends Extension {
  constructor(metadata) {
    super(metadata);
    this._indicator = null;
  }

  enable() {
    extLog("Extension enabled");

    DDCUtil.configure({
      queueMs: 130,
      sleepMultiplier: 1.0,
      commandTimeoutMs: 10000,
      allowZeroBrightness: false,
      ddcutilPath: "",
      additionalArgs: "",
    });

    if (!this._indicator) {
      this._indicator = new Indicator();
    }
  }

  disable() {
    extLog("Extension disabled");

    DDCUtil.cleanup();

    if (this._indicator) {
      try {
        this._indicator.destroy();
      } catch (e) {
        extLog(`Error destroying indicator: ${e.message}`);
      }
      this._indicator = null;
    }
  }
}
