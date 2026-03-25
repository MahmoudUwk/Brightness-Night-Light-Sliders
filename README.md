# Brightness & Night Light Sliders

<p align="center">
  <img src="demo.png" alt="Brightness and Night Light Sliders demo" width="450">
</p>

GNOME Shell extension that adds Quick Settings sliders for external monitor brightness (DDC/CI) and Night Light temperature.

**Note:** Brightness changes may take a few seconds to apply due to DDC/CI communication latency.

## Requirements

- GNOME Shell 45, 46, or 47
- `ddcutil` for brightness slider
- DDC/CI-capable external monitor (internal laptop panels like eDP/LVDS/DSI are not supported)
- Night Light enabled in `Settings > Displays > Night Light` for the Night Light slider

## Install

```bash
git clone https://github.com/MahmoudUwk/Brightness-Night-Light-Sliders.git /tmp/bnls && cd /tmp/bnls && ./install.sh
```

The installer installs `ddcutil` if missing, loads `i2c-dev` if needed, and enables the extension. If it adds your user to the `i2c` group, reboot before testing brightness.

## Troubleshooting

**Brightness slider not working**

```bash
ddcutil detect
journalctl --no-pager -b | grep -i BrightnessNightLightSliders
```

- If `ddcutil detect` shows no displays, your monitor/dock/adapter may not support DDC/CI
- If brightness is stuck after docking/undocking, reconnect the monitor and reopen Quick Settings
- Restart GNOME Shell (X11) or log out/in (Wayland) after upgrading the extension

**Night Light slider not showing**

Enable Night Light in `Settings > Displays > Night Light`. Moving the slider disables automatic scheduling to preserve your selected warmth.

## GNOME Extensions Packaging

For `extensions.gnome.org`, upload only: `extension.js`, `ddcutil.js`, `metadata.json`, `stylesheet.css`.

## License

MIT
