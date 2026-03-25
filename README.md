# Brightness & Night Light Sliders

<p align="center">
  <img src="demo.png" alt="Brightness and Night Light Sliders demo" width="450">
</p>

GNOME Shell extension that adds Quick Settings sliders for external monitor brightness via DDC/CI and for Night Light temperature.

## Requirements

- GNOME Shell 45, 46, or 47
- `ddcutil` for the brightness slider
- A DDC/CI-capable external monitor for brightness control
- Internal laptop panels such as `eDP`, `LVDS`, and `DSI` do not support DDC/CI brightness control through this extension
- Night Light enabled in `Settings > Displays > Night Light` for the Night Light slider

## Install

```bash
git clone https://github.com/MahmoudUwk/Brightness-Night-Light-Sliders.git /tmp/bnls && cd /tmp/bnls && ./install.sh
```

The installer:

- installs `ddcutil` if it is missing
- loads `i2c-dev` if needed
- checks whether `ddcutil detect` works
- only applies extra permission fixes when the system reports a real permission problem
- installs and enables the extension

If the installer adds your user to the `i2c` group, reboot before testing brightness control.

## Behavior

- The brightness slider stays visible even if no DDC display is currently detected
- Brightness control keeps using the last successful DDC/CI display when it is still present; otherwise it reselects a monitor from fresh `ddcutil detect` data with a deterministic external-first fallback
- Brightness refresh is event-driven: it syncs on extension startup, when Quick Settings opens, and on GNOME monitor topology changes, with no periodic polling loop
- Moving the Night Light slider switches Night Light to manual all-day scheduling so GNOME does not immediately override the chosen temperature

## Troubleshooting

**Brightness slider visible but not working**

```bash
ddcutil detect
journalctl --no-pager -b | grep -i BrightnessNightLightSliders
```

If `ddcutil detect` shows no displays, your monitor path, dock, adapter, or display may not expose DDC/CI correctly.

If `ddcutil detect` only reports an internal laptop panel like `eDP-1`, that is expected: internal panels do not expose DDC/CI brightness control.

If brightness feels stuck after docking or unplugging displays, reconnect the monitor and reopen Quick Settings once; the extension refreshes its DDC selection on GNOME monitor topology changes instead of polling continuously.

If you upgrade the extension while logged in and GNOME Shell keeps the old extension state, restart GNOME Shell on X11 or log out and back in on Wayland.

**Night Light slider not showing**

Enable Night Light in `Settings > Displays > Night Light`.

**Night Light slider changes schedule behavior**

Moving the slider disables automatic sunrise/sunset scheduling and switches Night Light to a manual all-day schedule so your selected warmth is preserved.

**Inspect Night Light temperature changes**

```bash
gsettings monitor org.gnome.settings-daemon.plugins.color night-light-temperature
```

**Need to reinstall**

```bash
rm -rf /tmp/bnls && git clone https://github.com/MahmoudUwk/Brightness-Night-Light-Sliders.git /tmp/bnls && cd /tmp/bnls && ./install.sh
```

## GNOME Extensions Packaging

For `extensions.gnome.org`, submit only the runtime files:

- `extension.js`
- `ddcutil.js`
- `metadata.json`
- `stylesheet.css`

Do not include `install.sh`, screenshots, or other repository-only files in the upload zip.

## License

MIT
