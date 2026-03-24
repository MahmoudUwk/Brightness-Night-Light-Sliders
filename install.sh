#!/bin/bash

EXTENSION_NAME="brightness-night-light-sliders@MahmoudUwk.github.com"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Brightness & Night Light Sliders Installer ==="
echo

check_ddcutil() {
    if ! command -v ddcutil &> /dev/null; then
        echo "Warning: ddcutil is not installed."
        echo "Monitor brightness control will not work without it."
        echo
        echo "Install with:"
        echo "  Debian/Ubuntu: sudo apt install ddcutil"
        echo "  Fedora:        sudo dnf install ddcutil"
        echo "  Arch Linux:    sudo pacman -S ddcutil"
        echo
        read -p "Continue anyway? (y/N): " choice
        case "$choice" in
            y|Y ) echo "Continuing...";;
            * ) echo "Aborted."; exit 1;;
        esac
    else
        echo "Found ddcutil: $(ddcutil --version | head -1)"
    fi
}

check_i2c_group() {
    if ! groups | grep -q '\bi2c\b'; then
        echo "Warning: Your user is not in the 'i2c' group."
        echo "Monitor brightness control may require elevated permissions."
        echo
        echo "To add yourself to the i2c group, run:"
        echo "  sudo usermod -aG i2c \$USER"
        echo "Then log out and back in."
        echo
    fi
}

install_extension() {
    echo "Installing extension to: $INSTALL_DIR/$EXTENSION_NAME"
    
    mkdir -p "$INSTALL_DIR/$EXTENSION_NAME"
    
    cp "$SOURCE_DIR/extension.js" "$INSTALL_DIR/$EXTENSION_NAME/"
    cp "$SOURCE_DIR/ddcutil.js" "$INSTALL_DIR/$EXTENSION_NAME/"
    cp "$SOURCE_DIR/metadata.json" "$INSTALL_DIR/$EXTENSION_NAME/"
    cp "$SOURCE_DIR/stylesheet.css" "$INSTALL_DIR/$EXTENSION_NAME/"
    
    if [ -f "$SOURCE_DIR/LICENSE" ]; then
        cp "$SOURCE_DIR/LICENSE" "$INSTALL_DIR/$EXTENSION_NAME/"
    fi
    
    echo "Files copied successfully."
}

enable_extension() {
    echo
    echo "Enabling extension..."
    gnome-extensions enable "$EXTENSION_NAME" 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "Extension enabled successfully."
    else
        echo "Note: You may need to restart GNOME Shell first:"
        echo "  X11:     Press Alt+F2, type 'r', press Enter"
        echo "  Wayland: Log out and log back in"
        echo
        echo "Then enable with:"
        echo "  gnome-extensions enable $EXTENSION_NAME"
    fi
}

uninstall() {
    echo "Uninstalling extension..."
    gnome-extensions disable "$EXTENSION_NAME" 2>/dev/null
    rm -rf "$INSTALL_DIR/$EXTENSION_NAME"
    echo "Extension uninstalled."
}

case "${1:-install}" in
    install)
        check_ddcutil
        check_i2c_group
        install_extension
        enable_extension
        echo
        echo "=== Installation Complete ==="
        echo "If the sliders don't appear, restart GNOME Shell and re-enable the extension."
        ;;
    uninstall)
        uninstall
        ;;
    *)
        echo "Usage: $0 [install|uninstall]"
        exit 1
        ;;
esac
