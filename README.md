# Brightness & Night Light Sliders

![Demo](demo.png)

GNOME Shell extension that adds sliders to Quick Settings for external monitor brightness (DDC/CI) and Night Light temperature.

## Requirements

- GNOME 45, 46, or 47
- `ddcutil` (`sudo apt install ddcutil`)
- External monitor with DDC/CI support

## Install

One-liner:

```bash
git clone https://github.com/MahmoudUwk/Brightness-Night-Light-Sliders.git /tmp/bnls && cd /tmp/bnls && ./install.sh
```

## DDC/CI Setup

```bash
sudo apt install ddcutil
sudo modprobe i2c-dev
sudo groupadd --system i2c 2>/dev/null || true
sudo usermod -aG i2c $USER
sudo cp /usr/share/ddcutil/data/60-ddcutil-i2c.rules /etc/udev/rules.d/
echo "i2c-dev" | sudo tee /etc/modules-load.d/i2c.conf
sudo reboot
```

Verify: `ddcutil detect`

## Troubleshooting

**Sliders not appearing?**

- Ensure `ddcutil detect` shows your monitor
- Enable Night Light in GNOME Settings first
- Check logs: `journalctl -f | grep NightLightSlider`

**Screen freezes?** Increase delay in `extension.js`:

```js
DDCUtil.configure({ queueMs: 200, sleepMultiplier: 2.0 });
```

## License

MIT
