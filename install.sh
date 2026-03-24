#!/bin/bash

set -u

EXTENSION_NAME="brightness-night-light-sliders@MahmoudUwk.github.com"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
NEEDS_REBOOT=false

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_header() {
    echo
    echo -e "${GREEN}=== Brightness & Night Light Sliders ===${NC}"
    echo
}

print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1"; }
print_warning() { echo -e "${YELLOW}!${NC} $1"; }

detect_package_manager() {
    if command -v apt >/dev/null 2>&1; then
        PM="apt"
    elif command -v dnf >/dev/null 2>&1; then
        PM="dnf"
    elif command -v pacman >/dev/null 2>&1; then
        PM="pacman"
    else
        PM="unknown"
    fi
}

install_ddcutil() {
    detect_package_manager

    case "$PM" in
        apt)
            sudo apt update && sudo apt install -y ddcutil
            ;;
        dnf)
            sudo dnf install -y ddcutil
            ;;
        pacman)
            sudo pacman -S --noconfirm ddcutil
            ;;
        *)
            print_error "Could not detect a supported package manager. Install ddcutil manually."
            return 1
            ;;
    esac
}

setup_ddcutil() {
    if command -v ddcutil >/dev/null 2>&1; then
        print_success "ddcutil installed: $(ddcutil --version 2>/dev/null | head -1)"
        return 0
    fi

    print_warning "ddcutil not found"
    read -r -p "Install ddcutil now? [Y/n]: " choice
    if [[ "$choice" =~ ^[Nn]$ ]]; then
        print_warning "Skipping ddcutil installation. Brightness control may not work."
        return 1
    fi

    install_ddcutil || return 1

    if command -v ddcutil >/dev/null 2>&1; then
        print_success "ddcutil installed: $(ddcutil --version 2>/dev/null | head -1)"
        return 0
    fi

    print_error "Failed to install ddcutil"
    return 1
}

ensure_i2c_module() {
    if lsmod | grep -q '^i2c_dev'; then
        print_success "i2c-dev kernel module loaded"
        return 0
    fi

    print_warning "i2c-dev module not loaded"
    if sudo modprobe i2c-dev >/dev/null 2>&1; then
        print_success "i2c-dev module loaded"

        if [ ! -f /etc/modules-load.d/i2c.conf ]; then
            echo "i2c-dev" | sudo tee /etc/modules-load.d/i2c.conf >/dev/null
            print_success "i2c-dev set to load on boot"
        fi
        return 0
    fi

    print_error "Failed to load i2c-dev"
    return 1
}

get_ddcutil_output() {
    timeout 15 ddcutil detect 2>&1
}

reload_udev() {
    sudo udevadm control --reload-rules >/dev/null 2>&1 || true
    sudo udevadm trigger >/dev/null 2>&1 || true
}

setup_permissions_if_needed() {
    local output
    output="$(get_ddcutil_output)"

    if echo "$output" | grep -q "Display"; then
        print_success "Monitor detected by ddcutil"
        return 0
    fi

    if ! echo "$output" | grep -Eqi 'permission denied|permission error|operation not permitted'; then
        print_warning "ddcutil did not report a permissions error"
        echo "$output"
        return 0
    fi

    print_warning "ddcutil reported a permissions problem; applying compatibility fixes"

    local shared_rules="/usr/share/ddcutil/data/60-ddcutil-i2c.rules"
    local system_rules="/usr/lib/udev/rules.d/60-ddcutil-i2c.rules"
    local target_rules="/etc/udev/rules.d/60-ddcutil-i2c.rules"

    if [ ! -f "$target_rules" ]; then
        if [ -f "$shared_rules" ]; then
            sudo cp "$shared_rules" "$target_rules"
            print_success "Installed udev rules from $shared_rules"
        elif [ -f "$system_rules" ]; then
            sudo cp "$system_rules" "$target_rules"
            print_success "Copied udev rules from $system_rules"
        else
            print_warning "No packaged ddcutil udev rules were found"
        fi
    else
        print_success "Udev rules already configured"
    fi

    reload_udev

    if ! getent group i2c >/dev/null 2>&1; then
        sudo groupadd --system i2c 2>/dev/null || true
    fi

    if groups | grep -q '\bi2c\b'; then
        print_success "User already in i2c group"
    else
        sudo usermod -aG i2c "$USER"
        print_success "Added $USER to i2c group"
        NEEDS_REBOOT=true
    fi

    output="$(get_ddcutil_output)"
    if echo "$output" | grep -q "Display"; then
        print_success "Monitor detected by ddcutil"
    else
        print_warning "ddcutil still cannot detect a display yet"
        echo "$output"
    fi
}

install_extension() {
    echo
    echo "Installing extension..."

    mkdir -p "$INSTALL_DIR/$EXTENSION_NAME"

    for file in extension.js ddcutil.js metadata.json stylesheet.css; do
        if [ -f "$SOURCE_DIR/$file" ]; then
            cp "$SOURCE_DIR/$file" "$INSTALL_DIR/$EXTENSION_NAME/"
        fi
    done

    if [ -f "$SOURCE_DIR/LICENSE" ]; then
        cp "$SOURCE_DIR/LICENSE" "$INSTALL_DIR/$EXTENSION_NAME/"
    fi

    print_success "Extension files installed"
}

enable_extension() {
    gnome-extensions enable "$EXTENSION_NAME" 2>/dev/null

    if [ $? -eq 0 ]; then
        print_success "Extension enabled"
    else
        print_warning "Could not enable extension automatically"
        echo "  Restart GNOME Shell, then run:"
        echo "  gnome-extensions enable $EXTENSION_NAME"
    fi
}

uninstall() {
    echo "Uninstalling..."
    gnome-extensions disable "$EXTENSION_NAME" 2>/dev/null || true
    rm -rf "$INSTALL_DIR/$EXTENSION_NAME"
    print_success "Extension uninstalled"
}

print_final_message() {
    echo
    echo -e "${GREEN}=== Installation Complete ===${NC}"
    echo

    if [ "$NEEDS_REBOOT" = true ]; then
        echo -e "${YELLOW}Reboot required${NC}"
        echo "You were added to the i2c group. Reboot before testing brightness control."
    else
        echo "If sliders do not appear immediately, restart GNOME Shell:"
        echo "  X11:     Alt+F2, type 'r', press Enter"
        echo "  Wayland: Log out and back in"
    fi

    echo
    echo "Diagnostics:"
    echo "  ddcutil detect"
    echo "  journalctl --no-pager -b | grep -i NightLightSlider"
}

main() {
    print_header

    case "${1:-install}" in
        install)
            setup_ddcutil || true
            ensure_i2c_module || true
            setup_permissions_if_needed || true
            install_extension
            enable_extension
            print_final_message
            ;;
        setup)
            setup_ddcutil || true
            ensure_i2c_module || true
            setup_permissions_if_needed || true
            print_final_message
            ;;
        uninstall)
            uninstall
            ;;
        *)
            echo "Usage: $0 [install|setup|uninstall]"
            exit 1
            ;;
    esac
}

main "$@"
