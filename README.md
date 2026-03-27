# Brightness & Night Light Sliders

GNOME Shell extension that adds brightness and Night Light sliders to Quick Settings.

<p align="center">
  <img src="demo.png" alt="Demo" width="450">
</p>

## Requirements

- GNOME 45, 46, or 47
- `ddcutil` installed and available in `PATH`
- External monitor with DDC/CI support (brightness slider won't work on laptop displays)

## Install

One command install/update:

```bash
rm -rf /tmp/brightness-night-light-sliders && git clone https://github.com/MahmoudUwk/Brightness-Night-Light-Sliders.git /tmp/brightness-night-light-sliders && cd /tmp/brightness-night-light-sliders && ./install.sh
```

If you rerun it, it replaces the tmp clone with a fresh copy first.

## Known Issues

### Brightness slider not working

- **Laptop displays**: Internal panels (eDP/LVDS/DSI) don't support DDC/CI. Only external monitors work.
- **No displays detected**: Run `ddcutil detect` to check if your monitor/dock/adapter supports DDC/CI.
- **ddcutil missing**: Install `ddcutil` first, then reinstall the extension.

### GNOME Shell crashes

This extension uses defensive programming to avoid crashes during monitor topology changes:
- Debounced monitor change handling (1 second settle time)
- Generation tokens to cancel stale async operations
- Monitor validity guards before applying changes

Version 2 also fixes a teardown bug in the brightness slider where a lingering timeout could run after the actor was destroyed.

The extension now avoids aggressive DDC/CI refreshes during monitor topology changes, which can reduce brief flicker on some external displays.
Topology changes now only refresh when Quick Settings is opened, instead of probing the monitor in the background.
It also skips the initial brightness probe at shell startup, which further reduces early display resets on some monitors.
Brightness syncing is now intentionally minimized; the slider writes brightness without probing the display unless GNOME explicitly asks for a refresh.

If you experience crashes:
1. Update your system: `sudo apt update && sudo apt full-upgrade -y && reboot`
2. Check logs: `journalctl -b | grep -iE "gnome-shell|mutter"`
3. Try X11 instead of Wayland (login screen -> gear icon -> "Ubuntu on Xorg")
4. Report an issue with the info below

## Troubleshooting

```bash
# Check if monitor supports DDC/CI
ddcutil detect

# Check extension logs
journalctl -b | grep -i BrightnessNightLightSliders

# Check installation status
./install.sh status
```

**Night Light slider not showing**

Enable Night Light in Settings > Displays > Night Light.

## Reporting Issues

When reporting issues, include:

1. **System info**:
   ```bash
   gnome-shell --version
   echo $XDG_SESSION_TYPE
   ./install.sh status
   ```

2. **Monitor setup**: Laptop? External monitor? Dock? Connection type (HDMI/DP/USB-C)?

3. **Logs**:
   ```bash
   journalctl -b | grep -iE "gnome-shell|mutter|BrightnessNightLightSliders" | tail -50
   ```

4. **Crash report** (if applicable):
   ```bash
   ls -la /var/crash/
   ```

## License

MIT
