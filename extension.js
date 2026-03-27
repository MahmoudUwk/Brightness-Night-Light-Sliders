import Gio from "gi://Gio";
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
const extLog = (msg) => console.log("[BrightnessNightLightSliders]", msg);

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

      this.slider.accessible_name = _("Brightness");
      this._sliderChangedId = this.slider.connect(
        "notify::value",
        this._sliderChanged.bind(this),
      );
    }

    _sliderChanged() {
      if (this._destroyed || !this._supportsBrightness)
        return;

      const level = Math.round(this.slider.value * 100);
      DDCUtil.setBrightness(level);
    }

    destroy() {
      this._destroyed = true;

      if (this._sliderChangedId) {
        try {
          this.slider.disconnect(this._sliderChangedId);
        } catch (e) {
          extLog(`Error disconnecting slider: ${e.message}`);
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
      this._quickSettingsAttached = false;

      const nightLightItem = new NightLightItem();
      const brightnessSlider = new BrightnessSlider();

      this.quickSettingsItems.push(brightnessSlider);
      this.quickSettingsItems.push(nightLightItem);

      this._attachToQuickSettings();
    }

    _attachToQuickSettings() {
      if (this._quickSettingsAttached)
        return;

      const quickSettings = getQuickSettings();
      if (!quickSettings) {
        extLog("Quick Settings not ready; sliders were not attached");
        return;
      }

      try {
        quickSettings.addExternalIndicator(this, 2);
        this._quickSettingsAttached = true;
      } catch (e) {
        extLog(`Error attaching to Quick Settings: ${e.message}`);
      }
    }

    destroy() {
      this._quickSettingsAttached = false;
      this.quickSettingsItems.forEach((item) => {
        try {
          item.destroy();
        } catch (e) {
          extLog(`Error destroying item: ${e.message}`);
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
