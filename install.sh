#!/bin/bash

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
    if command -v apt &> /dev/null; then
        PM="apt"
        INSTALL_CMD="sudo apt install -y ddcutil"
    elif command -v dnf &> /dev/null; then
        PM="dnf"
        INSTALL_CMD="sudo dnf install -y ddcutil"
    elif command -v pacman &> /dev/null; then
        PM="pacman"
        INSTALL_CMD="sudo pacman -S --noconfirm ddcutil"
    else
        PM="unknown"
        INSTALL_CMD=""
    fi
}

setup_ddcutil() {
    if command -v ddcutil &> /dev/null; then
        print_success "ddcutil installed: $(ddcutil --version 2>/dev/null | head -1)"
        return 0
    fi

    print_warning "ddcutil not found"
    detect_package_manager
    
    if [ "$PM" = "unknown" ]; then
        print_error "Could not detect package manager. Please install ddcutil manually."
        return 1
    fi

    read -p "Install ddcutil? [Y/n]: " choice
    if [[ "$choice" =~ ^[Nn]$ ]]; then
        print_warning "Skipping ddcutil. Brightness control will not work."
        return 1
    fi

    echo "Installing ddcutil..."
    eval "$INSTALL_CMD"
    
    if command -v ddcutil &> /dev/null; then
        print_success "ddcutil installed"
        return 0
    else
        print_error "Failed to install ddcutil"
        return 1
    fi
}

setup_i2c_module() {
    if lsmod | grep -q "^i2c_dev"; then
        print_success "i2c-dev kernel module loaded"
        return 0
    fi

    print_warning "i2c-dev module not loaded"
    
    if sudo modprobe i2c-dev 2>/dev/null; then
        print_success "i2c-dev module loaded"
        
        if [ ! -f /etc/modules-load.d/i2c.conf ]; then
            echo "i2c-dev" | sudo tee /etc/modules-load.d/i2c.conf > /dev/null
            print_success "i2c-dev set to load on boot"
        fi
        return 0
    else
        print_error "Failed to load i2c-dev module"
        return 1
    fi
}

setup_i2c_group() {
    if groups | grep -q '\bi2c\b'; then
        print_success "User in i2c group"
        return 0
    fi

    print_warning "User not in i2c group"

    if ! getent group i2c > /dev/null; then
        sudo groupadd --system i2c 2>/dev/null
        print_success "Created i2c group"
    fi

    sudo usermod -aG i2c "$USER"
    print_success "Added $USER to i2c group"
    NEEDS_REBOOT=true
    print_warning "Reboot required for group changes to take effect"
    return 0
}

setup_udev_rules() {
    local rules_file="/etc/udev/rules.d/60-ddcutil-i2c.rules"
    local source_rules="/usr/share/ddcutil/data/60-ddcutil-i2c.rules"
    
    if [ -f "$rules_file" ]; then
        print_success "Udev rules already configured"
        return 0
    fi

    if [ -f "$source_rules" ]; then
        sudo cp "$source_rules" "$rules_file"
        sudo udevadm control --reload-rules 2>/dev/null
        sudo udevadm trigger 2>/dev/null
        print_success "Udev rules installed"
        return 0
    fi

    print_warning "Udev rules source not found at $source_rules"
    return 0
}

test_ddcutil() {
    print_warning "Testing ddcutil..."
    
    if timeout 10 ddcutil detect 2>/dev/null | grep -q "Display"; then
        print_success "Monitor detected by ddcutil"
        return 0
    else
        local output
        output=$(ddcutil detect 2>&1)
        
        if echo "$output" | grep -qi "permission denied"; then
            print_warning "Permission denied - try rebooting first"
            return 1
        elif echo "$output" | grep -qi "no monitor"; then
            print_warning "No DDC/CI monitor detected"
            return 1
        else
            print_warning "ddcutil test inconclusive"
            return 0
        fi
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
    
    [ -f "$SOURCE_DIR/LICENSE" ] && cp "$SOURCE_DIR/LICENSE" "$INSTALL_DIR/$EXTENSION_NAME/"
    
    print_success "Extension files installed"
}

enable_extension() {
    gnome-extensions enable "$EXTENSION_NAME" 2>/dev/null
    
    if [ $? -eq 0 ]; then
        print_success "Extension enabled"
    else
        print_warning "Could not enable extension"
        echo "  Restart GNOME Shell, then run:"
        echo "  gnome-extensions enable $EXTENSION_NAME"
    fi
}

uninstall() {
    echo "Uninstalling..."
    gnome-extensions disable "$EXTENSION_NAME" 2>/dev/null
    rm -rf "$INSTALL_DIR/$EXTENSION_NAME"
    print_success "Extension uninstalled"
}

print_final_message() {
    echo
    echo -e "${GREEN}=== Installation Complete ===${NC}"
    
    if [ "$NEEDS_REBOOT" = true ]; then
        echo
        echo -e "${YELLOW}⚠ REBOOT REQUIRED${NC}"
        echo "You were added to the i2c group."
        echo "Run: sudo reboot"
    else
        echo
        echo "If sliders don't appear, restart GNOME Shell:"
        echo "  X11:     Alt+F2, type 'r', Enter"
        echo "  Wayland: Log out and back in"
    fi
}

main() {
    print_header
    
    case "${1:-install}" in
        install)
            setup_ddcutil || true
            setup_i2c_module || true
            setup_i2c_group || true
            setup_udev_rules || true
            test_ddcutil || true
            install_extension
            enable_extension
            print_final_message
            ;;
        uninstall)
            uninstall
            ;;
        setup)
            setup_ddcutil || true
            setup_i2c_module || true
            setup_i2c_group || true
            setup_udev_rules || true
            test_ddcutil || true
            print_final_message
            ;;
        *)
            echo "Usage: $0 [install|uninstall|setup]"
            echo "  install  - Install extension and dependencies"
            echo "  uninstall - Remove extension"
            echo "  setup    - Only setup dependencies (no extension install)"
            exit 1
            ;;
    esac
}

main "$@"
