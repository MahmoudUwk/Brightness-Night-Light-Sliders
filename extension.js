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
  MENU_OPEN_COOLDOWN_MS: 500,
  MAX_MONITOR_RETRIES: 3,
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
      this.visible = true;

      this._destroyed = false;
      this._forceRefreshPending = false;

      this._menuConnectRetryId = null;
      this._menuConnectAttempts = 0;
      this._menuConnectWarningLogged = false;

      this._syncIdleId = null;
      this._syncRequestId = 0;

      this._topologyDebounceId = null;
      this._topologyGeneration = 0;
      this._lastTopologyChange = 0;

      this._menuOpenDebounceId = null;
      this._lastMenuOpen = 0;

      this._monitorCount = safeGetMonitors();

      this._quickSettingsOpenedId = null;
      this.slider.accessible_name = _("Brightness");
      this._sliderChangedId = this.slider.connect(
        "notify::value",
        this._sliderChanged.bind(this),
      );

      this._ensureQuickSettingsMenuConnection();

      this._monitorsChangedId = Main.layoutManager.connect(
        "monitors-changed",
        this._handleMonitorsChanged.bind(this),
      );

      this._queueSync(true);
    }

    _sliderChanged() {
      if (this._destroyed)
        return;

      const level = Math.round(this.slider.value * 100);
      DDCUtil.setBrightness(level);
    }

    _handleMonitorsChanged() {
      if (this._destroyed)
        return;

      const now = Date.now();
      const currentMonitorCount = safeGetMonitors();

      if (currentMonitorCount !== this._monitorCount) {
        debugLog(`Monitor count changed: ${this._monitorCount} -> ${currentMonitorCount}`);
        this._monitorCount = currentMonitorCount;
      }

      if (this._topologyDebounceId) {
        GLib.source_remove(this._topologyDebounceId);
        this._topologyDebounceId = null;
      }

      this._topologyGeneration++;
      this._lastTopologyChange = now;

      this._topologyDebounceId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        CONFIG.TOPOLOGY_DEBOUNCE_MS,
        () => {
          this._topologyDebounceId = null;

          if (this._destroyed)
            return GLib.SOURCE_REMOVE;

          const elapsed = Date.now() - this._lastTopologyChange;
          if (elapsed < CONFIG.TOPOLOGY_DEBOUNCE_MS) {
            debugLog(`Topology still settling, waiting... (${elapsed}ms)`);
            return GLib.SOURCE_REMOVE;
          }

          debugLog("Topology settled, triggering refresh");
          this._queueSync(true);
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    _handleMenuOpenStateChanged(_menu, isOpen) {
      if (this._destroyed || !isOpen)
        return;

      const now = Date.now();
      if (now - this._lastMenuOpen < CONFIG.MENU_OPEN_COOLDOWN_MS) {
        debugLog("Menu open debounced");
        return;
      }
      this._lastMenuOpen = now;

      if (this._menuOpenDebounceId) {
        GLib.source_remove(this._menuOpenDebounceId);
        this._menuOpenDebounceId = null;
      }

      this._menuOpenDebounceId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        CONFIG.SYNC_DEBOUNCE_MS,
        () => {
          this._menuOpenDebounceId = null;
          if (!this._destroyed)
            this._queueSync(false);
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    _ensureQuickSettingsMenuConnection() {
      if (this._destroyed || this._quickSettingsOpenedId)
        return;

      const quickSettings = getQuickSettings();
      if (quickSettings?.menu) {
        this._quickSettingsOpenedId = quickSettings.menu.connect(
          "open-state-changed",
          this._handleMenuOpenStateChanged.bind(this),
        );
        this._menuConnectAttempts = 0;
        this._menuConnectWarningLogged = false;
        return;
      }

      if (this._menuConnectAttempts >= QUICK_SETTINGS_MAX_RETRIES) {
        if (!this._menuConnectWarningLogged) {
          extLog("Quick Settings menu was not ready; menu-open refresh hook is disabled");
          this._menuConnectWarningLogged = true;
        }
        return;
      }

      if (this._menuConnectRetryId)
        return;

      this._menuConnectRetryId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        QUICK_SETTINGS_RETRY_MS,
        () => {
          this._menuConnectRetryId = null;
          this._menuConnectAttempts += 1;
          this._ensureQuickSettingsMenuConnection();
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    _queueSync(forceRefresh = false) {
      if (this._destroyed)
        return;

      this._forceRefreshPending = this._forceRefreshPending || forceRefresh;

      if (this._syncIdleId)
        return;

      this._syncIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._syncIdleId = null;

        if (this._destroyed)
          return GLib.SOURCE_REMOVE;

        const shouldForceRefresh = this._forceRefreshPending;
        this._forceRefreshPending = false;
        void this._syncBrightness(shouldForceRefresh);

        return GLib.SOURCE_REMOVE;
      });
    }

    async _syncBrightness(forceRefresh = false) {
      const requestId = ++this._syncRequestId;
      const topologyGen = this._topologyGeneration;

      if (forceRefresh) {
        debugLog(`Forcing topology refresh (request ${requestId}, gen ${topologyGen})`);
        DDCUtil.handleMonitorTopologyChange();
      }

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

        if (topologyGen !== this._topologyGeneration) {
          debugLog(`Topology changed during sync (gen ${topologyGen} != current ${this._topologyGeneration}), discarding`);
          return;
        }

        if (!this._sliderChangedId) {
          debugLog("Slider already destroyed");
          return;
        }

        const newMonitorCount = safeGetMonitors();
        if (newMonitorCount !== currentMonitors) {
          debugLog(`Monitor count changed during sync (${currentMonitors} -> ${newMonitorCount}), discarding`);
          return;
        }

        this.slider.block_signal_handler(this._sliderChangedId);
        this.slider.value = level / 100;
        this.slider.unblock_signal_handler(this._sliderChangedId);
        this.visible = true;

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

        if (topologyGen !== this._topologyGeneration) {
          debugLog(`Topology changed during error (gen ${topologyGen}), ignoring`);
          return;
        }

        debugLog(`Sync error: ${error.message}`);
        extLog(`Could not sync brightness: ${error.message}`);
        this.visible = true;
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

      if (this._menuConnectRetryId) {
        GLib.source_remove(this._menuConnectRetryId);
        this._menuConnectRetryId = null;
      }

      if (this._topologyDebounceId) {
        GLib.source_remove(this._topologyDebounceId);
        this._topologyDebounceId = null;
      }

      if (this._menuOpenDebounceId) {
        GLib.source_remove(this._menuOpenDebounceId);
        this._menuOpenDebounceId = null;
      }

      if (this._monitorsChangedId) {
        try {
          Main.layoutManager.disconnect(this._monitorsChangedId);
        } catch (e) {
          debugLog(`Error disconnecting monitors-changed: ${e.message}`);
        }
        this._monitorsChangedId = null;
      }

      if (this._quickSettingsOpenedId) {
        const quickSettings = getQuickSettings();
        if (quickSettings?.menu) {
          try {
            quickSettings.menu.disconnect(this._quickSettingsOpenedId);
          } catch (e) {
            debugLog(`Error disconnecting menu: ${e.message}`);
          }
        }
        this._quickSettingsOpenedId = null;
      }

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
const SCHEDULE_AUTOMATIC_KEY = "night-light-schedule-automatic";
const SCHEDULE_FROM_KEY = "night-light-schedule-from";
const SCHEDULE_TO_KEY = "night-light-schedule-to";

class TemperatureUtils {
  static MIN_TEMP = 1700;
  static MAX_TEMP = 4700;

  static normalize(temp) {
    return 1 - (temp - this.MIN_TEMP) / (this.MAX_TEMP - this.MIN_TEMP);
  }

  static denormalize(value) {
    return Math.round(
      (1 - value) * (this.MAX_TEMP - this.MIN_TEMP) + this.MIN_TEMP,
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

      if (this._settings.get_boolean(SCHEDULE_AUTOMATIC_KEY)) {
        this._settings.set_boolean(SCHEDULE_AUTOMATIC_KEY, false);
        this._settings.set_double(SCHEDULE_FROM_KEY, 0.0);
        this._settings.set_double(SCHEDULE_TO_KEY, 23.99);
      }

      this._settings.set_uint(TEMPERATURE_KEY, temperature);
    }

    _sync() {
      const temperature = this._settings.get_uint(TEMPERATURE_KEY);
      const value = TemperatureUtils.normalize(temperature);
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
          brightnessSlider._ensureQuickSettingsMenuConnection();
          this._quickSettingsAttached = true;
          this._quickSettingsAttachAttempts = 0;
          this._quickSettingsWarningLogged = false;
        } catch (e) {
          extLog(`Error attaching to Quick Settings: ${e.message}`);
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
