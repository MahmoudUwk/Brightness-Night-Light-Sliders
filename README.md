# Brightness & Night Light Sliders

<p align="center">
  <img src="demo.png" alt="Brightness and Night Light Sliders demo" width="450">
</p>

GNOME Shell extension that adds Quick Settings sliders for external monitor brightness via DDC/CI and for Night Light temperature.

## Requirements

- GNOME Shell 45, 46, or 47
- `ddcutil` for the brightness slider
- A DDC/CI-capable external monitor for brightness control
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
- Brightness control targets the first DDC/CI monitor reported by `ddcutil detect`
- Moving the Night Light slider switches Night Light to manual all-day scheduling so GNOME does not immediately override the chosen temperature

## Troubleshooting

**Brightness slider visible but not working**

```bash
ddcutil detect
journalctl --no-pager -b | grep -i NightLightSlider
```

If `ddcutil detect` shows no displays, your monitor path, dock, adapter, or display may not expose DDC/CI correctly.

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
