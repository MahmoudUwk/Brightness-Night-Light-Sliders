# Brightness & Night Light Sliders

<p align="center">
  <img src="demo.png" alt="Demo" width="450">
</p>

GNOME Shell extension that adds sliders to Quick Settings for external monitor brightness (DDC/CI) and Night Light temperature.

## Requirements

- GNOME 45, 46, or 47
- External monitor with DDC/CI support (for brightness slider)
- Night Light enabled in **Settings > Displays > Night Light** (for night light slider)

## Install

```bash
git clone https://github.com/MahmoudUwk/Brightness-Night-Light-Sliders.git /tmp/bnls && cd /tmp/bnls && ./install.sh
```

## Troubleshooting

**Brightness slider not appearing?**

1. Install ddcutil: `sudo apt install ddcutil`
2. Verify monitor detection: `ddcutil detect`
3. If permission denied, run:
   ```bash
   sudo modprobe i2c-dev
   sudo usermod -aG i2c $USER
   sudo cp /usr/share/ddcutil/data/60-ddcutil-i2c.rules /etc/udev/rules.d/
   ```
   Then reboot.

**Night Light slider not appearing?**

Enable Night Light first: **Settings > Displays > Night Light** > Turn it ON. The slider only shows when Night Light is enabled.

**Screen freezes?** Increase delay in `extension.js`:

```js
DDCUtil.configure({ queueMs: 200, sleepMultiplier: 2.0 });
```

## License

MIT
