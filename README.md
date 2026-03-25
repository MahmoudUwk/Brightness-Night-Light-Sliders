# Brightness & Night Light Sliders

GNOME Shell extension that adds brightness and Night Light sliders to Quick Settings.

<p align="center">
  <img src="demo.png" alt="Demo" width="450">
</p>

## Requirements

- GNOME 45, 46, or 47
- External monitor with DDC/CI support (brightness slider won't work on laptop displays)

## Install

```bash
git clone https://github.com/MahmoudUwk/Brightness-Night-Light-Sliders.git && cd Brightness-Night-Light-Sliders && ./install.sh
```

## Update

```bash
cd Brightness-Night-Light-Sliders && git pull && ./install.sh update
```

Or if you deleted the cloned directory:

```bash
git clone https://github.com/MahmoudUwk/Brightness-Night-Light-Sliders.git && cd Brightness-Night-Light-Sliders && ./install.sh update
```

## Commands

```bash
./install.sh          # Install
./install.sh update   # Update to latest version
./install.sh status   # Check installation status
./install.sh uninstall # Remove
```

## Troubleshooting

**Brightness slider not working**

```bash
ddcutil detect
```

- If no displays found, your monitor/dock/adapter may not support DDC/CI
- Brightness only works on external monitors, not laptop internal displays

**Night Light slider not showing**

Enable Night Light in Settings > Displays > Night Light.

## License

MIT
