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

const quickSettings = Main.panel.statusArea.quickSettings;

const EXT_LOG_NAME = "[NightLightSlider]";
const extLog = (msg) => console.log(EXT_LOG_NAME, msg);

const BrightnessSlider = GObject.registerClass(
  class BrightnessSlider extends QuickSlider {
    _init() {
      super._init({
        iconName: "display-brightness-symbolic",
      });

      this.add_style_class_name("bnl-slider");
      this.visible = true;
      this.slider.accessible_name = _("Brightness");
      this._sliderChangedId = this.slider.connect(
        "notify::value",
        this._sliderChanged.bind(this),
      );

      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._syncBrightness();
        return GLib.SOURCE_REMOVE;
      });
    }

    _sliderChanged() {
      const level = Math.round(this.slider.value * 100);
      DDCUtil.setBrightness(level);
    }

    _syncBrightness() {
      DDCUtil.getBrightness()
        .then((level) => {
          this.slider.block_signal_handler(this._sliderChangedId);
          this.slider.value = level / 100;
          this.slider.unblock_signal_handler(this._sliderChangedId);
          this.visible = true;
        })
        .catch((e) => {
          extLog(`Could not sync brightness: ${e.message}`);
          this.visible = true;
        });
    }

    destroy() {
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
  // Temperature limits - experimentally determined values
  // These can be adjusted if needed for different displays
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

      this._connections = [];

      this._settings = new Gio.Settings({ schema_id: COLOR_SCHEMA });

      this._updateVisibility();

      this._connections.push(
        this._settings.connect(`changed::${ENABLE_KEY}`, () =>
          this._updateVisibility(),
        ),
      );

      this._connections.push(
        this._settings.connect(`changed::${TEMPERATURE_KEY}`, () =>
          this._sync(),
        ),
      );

      this._sliderChangedId = this.slider.connect(
        "notify::value",
        this._sliderChanged.bind(this),
      );
      this._connections.push(this._sliderChangedId);

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
      this._connections.forEach((id) => {
        try {
          this._settings.disconnect(id);
        } catch (e) {
          // Signal may already be disconnected
        }
      });
      this._connections = [];
      super.destroy();
    }
  },
);

const Indicator = GObject.registerClass(
  class Indicator extends SystemIndicator {
    _init() {
      super._init();

      this.quickSettingsItems.push(new BrightnessSlider());
      this.quickSettingsItems.push(new NightLightItem());

      quickSettings.addExternalIndicator(this, 2);
    }

    destroy() {
      this.quickSettingsItems.forEach((item) => item.destroy());
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
      this._indicator.destroy();
      this._indicator = null;
    }
  }
}
