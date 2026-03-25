#!/bin/bash

set -euo pipefail

EXTENSION_NAME="brightness-night-light-sliders@MahmoudUwk.github.com"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
NEEDS_REBOOT=false
NEEDS_LOGOUT=false

REQUIRED_FILES=("extension.js" "ddcutil.js" "metadata.json" "stylesheet.css")
OPTIONAL_FILES=("LICENSE")

MIN_GNOME_VERSION=45
MAX_GNOME_VERSION=47

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_error() { echo -e "${RED}✗${NC} $1" >&2; }
print_warning() { echo -e "${YELLOW}!${NC} $1"; }
print_info() { echo -e "${BLUE}ℹ${NC} $1"; }

die() {
    print_error "$1"
    exit "${2:-1}"
}

usage() {
    cat << EOF
Usage: $0 [COMMAND]

Commands:
  install     Install the extension (default)
  update      Update to the latest version
  uninstall   Remove the extension
  setup       Run ddcutil/i2c setup without installing
  status      Show installation status

EOF
    exit 0
}

ensure_not_root() {
    if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
        die "Do not run as root or with sudo."
    fi
}

check_gnome_shell_running() {
    if ! pgrep -x "gnome-shell" > /dev/null 2>&1; then
        die "GNOME Shell is not running."
    fi
}

check_gnome_extensions_command() {
    if ! command -v gnome-extensions &> /dev/null; then
        return 1
    fi
    return 0
}

get_gnome_version() {
    local version=""
    
    if command -v gnome-shell &> /dev/null; then
        version=$(gnome-shell --version 2>/dev/null | grep -oP '\d+' | head -1)
    fi
    
    if [[ -z "$version" ]] && command -v busctl &> /dev/null; then
        version=$(busctl get-property org.gnome.Shell /org/gnome/Shell org.gnome.Shell ShellVersion 2>/dev/null | tr -d '"' | cut -d. -f1)
    fi
    
    echo "${version:-0}"
}

check_gnome_version() {
    local current_version
    current_version=$(get_gnome_version)
    
    if [[ "$current_version" -eq 0 ]]; then
        print_warning "Could not detect GNOME version"
        return
    fi
    
    echo "  GNOME Shell: $current_version"
    
    if [[ "$current_version" -lt "$MIN_GNOME_VERSION" ]] || [[ "$current_version" -gt "$MAX_GNOME_VERSION" ]]; then
        print_warning "GNOME $current_version not officially supported (requires ${MIN_GNOME_VERSION}-${MAX_GNOME_VERSION})"
    fi
}

verify_source_files() {
    local missing=()
    
    for file in "${REQUIRED_FILES[@]}"; do
        if [[ ! -f "$SOURCE_DIR/$file" ]]; then
            missing+=("$file")
        fi
    done
    
    if [[ ${#missing[@]} -gt 0 ]]; then
        die "Missing files: ${missing[*]}"
    fi
}

detect_package_manager() {
    if command -v apt &> /dev/null; then
        PM="apt"
    elif command -v dnf &> /dev/null; then
        PM="dnf"
    elif command -v pacman &> /dev/null; then
        PM="pacman"
    elif command -v zypper &> /dev/null; then
        PM="zypper"
    else
        PM="unknown"
    fi
}

install_ddcutil() {
    detect_package_manager
    
    echo "  Installing ddcutil via $PM..."
    
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
        zypper)
            sudo zypper install -y ddcutil
            ;;
        *)
            print_error "Package manager not detected. Install ddcutil manually."
            return 1
            ;;
    esac
}

setup_ddcutil() {
    if command -v ddcutil &> /dev/null; then
        print_success "ddcutil: $(ddcutil --version 2>/dev/null | head -1)"
        return 0
    fi
    
    print_info "Installing ddcutil..."
    install_ddcutil || return 1
    
    if command -v ddcutil &> /dev/null; then
        print_success "ddcutil installed"
        return 0
    fi
    
    print_error "Failed to install ddcutil"
    return 1
}

ensure_i2c_module() {
    if lsmod | grep -q '^i2c_dev'; then
        print_success "i2c-dev module loaded"
        return 0
    fi
    
    print_info "Loading i2c-dev module..."
    
    if sudo modprobe i2c-dev &> /dev/null 2>&1; then
        print_success "i2c-dev module loaded"
        
        if [[ ! -f /etc/modules-load.d/i2c.conf ]]; then
            echo "i2c-dev" | sudo tee /etc/modules-load.d/i2c.conf > /dev/null
            print_success "i2c-dev set to load on boot"
        fi
        return 0
    fi
    
    print_warning "Could not load i2c-dev"
    return 1
}

get_ddcutil_output() {
    timeout 15 ddcutil detect 2>&1 || echo "ddcutil failed"
}

reload_udev() {
    sudo udevadm control --reload-rules 2>/dev/null || true
    sudo udevadm trigger 2>/dev/null || true
}

setup_permissions_if_needed() {
    local output
    output="$(get_ddcutil_output)"
    
    if echo "$output" | grep -q "Display"; then
        print_success "Monitor detected by ddcutil"
        return 0
    fi
    
    if ! echo "$output" | grep -Eqi 'permission denied|permission error|operation not permitted|access denied'; then
        print_warning "No external monitor detected (normal for laptops)"
        return 0
    fi
    
    print_info "Setting up ddcutil permissions..."
    
    local shared_rules="/usr/share/ddcutil/data/60-ddcutil-i2c.rules"
    local system_rules="/usr/lib/udev/rules.d/60-ddcutil-i2c.rules"
    local target_rules="/etc/udev/rules.d/60-ddcutil-i2c.rules"
    
    if [[ ! -f "$target_rules" ]]; then
        if [[ -f "$shared_rules" ]]; then
            sudo cp "$shared_rules" "$target_rules"
            print_success "Installed udev rules"
        elif [[ -f "$system_rules" ]]; then
            sudo cp "$system_rules" "$target_rules"
            print_success "Installed udev rules"
        fi
    else
        print_success "Udev rules already configured"
    fi
    
    reload_udev
    
    if ! getent group i2c &> /dev/null; then
        sudo groupadd --system i2c 2>/dev/null || true
    fi
    
    if groups | grep -q '\bi2c\b'; then
        print_success "User in i2c group"
    else
        sudo usermod -aG i2c "$USER"
        print_success "Added $USER to i2c group"
        NEEDS_REBOOT=true
    fi
    
    output="$(get_ddcutil_output)"
    if echo "$output" | grep -q "Display"; then
        print_success "Monitor detected"
    fi
}

install_extension() {
    print_info "Installing extension files..."
    
    mkdir -p "$INSTALL_DIR/$EXTENSION_NAME"
    
    for file in "${REQUIRED_FILES[@]}" "${OPTIONAL_FILES[@]}"; do
        if [[ -f "$SOURCE_DIR/$file" ]]; then
            cp "$SOURCE_DIR/$file" "$INSTALL_DIR/$EXTENSION_NAME/"
            echo "  Copied: $file"
        fi
    done
    
    print_success "Extension installed to $INSTALL_DIR/$EXTENSION_NAME"
}

wait_for_extension_discovery() {
    local max_attempts=20
    local attempt=0
    
    echo "  Waiting for GNOME Shell to discover extension..."
    
    while [[ $attempt -lt $max_attempts ]]; do
        if gnome-extensions list 2>/dev/null | grep -qF "$EXTENSION_NAME"; then
            print_success "Extension discovered"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 0.25
    done
    
    print_warning "Extension not discovered (may need logout/login)"
    return 1
}

get_session_type() {
    if [[ -n "${XDG_SESSION_TYPE:-}" ]]; then
        echo "$XDG_SESSION_TYPE"
    elif [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
        echo "wayland"
    else
        echo "x11"
    fi
}

enable_extension() {
    print_info "Enabling extension..."
    
    if ! check_gnome_extensions_command; then
        NEEDS_LOGOUT=true
        return 0
    fi
    
    wait_for_extension_discovery || true
    
    gnome-extensions disable "$EXTENSION_NAME" 2>/dev/null || true
    
    if gnome-extensions enable "$EXTENSION_NAME" 2>&1; then
        if gnome-extensions list --enabled 2>/dev/null | grep -qF "$EXTENSION_NAME"; then
            print_success "Extension enabled"
            return 0
        fi
    fi
    
    print_warning "Could not auto-enable (enable manually after restart)"
    NEEDS_LOGOUT=true
}

print_restart_instructions() {
    local session_type
    session_type=$(get_session_type)
    
    echo
    echo -e "${BOLD}Restart required:${NC}"
    
    if [[ "$session_type" == "wayland" ]]; then
        echo "  Log out and log back in"
    else
        echo "  Press Alt+F2, type 'r', press Enter"
        echo "  Or log out and log back in"
    fi
}

print_final_message() {
    echo
    echo -e "${GREEN}=== Done ===${NC}"
    
    if [[ "$NEEDS_REBOOT" == "true" ]]; then
        echo
        echo -e "${YELLOW}Reboot required${NC} (added to i2c group)"
    elif [[ "$NEEDS_LOGOUT" == "true" ]]; then
        print_restart_instructions
    fi
    
    echo
    echo "Notes:"
    echo "  - Brightness works on external monitors only (not laptop displays)"
    echo "  - Night Light slider appears when Night Light is enabled"
    echo
    echo "Diagnostics:"
    echo "  ddcutil detect"
    echo "  journalctl -b | grep -i BrightnessNightLightSliders"
    echo "  $0 status"
}

uninstall() {
    print_info "Uninstalling..."
    
    if command -v gnome-extensions &> /dev/null; then
        gnome-extensions disable "$EXTENSION_NAME" 2>/dev/null || true
    fi
    
    if [[ -d "$INSTALL_DIR/$EXTENSION_NAME" ]]; then
        rm -rf "$INSTALL_DIR/$EXTENSION_NAME"
        print_success "Extension removed"
    else
        print_warning "Extension not installed"
    fi
}

update() {
    print_info "Updating extension..."
    
    if [[ -d "$INSTALL_DIR/$EXTENSION_NAME" ]]; then
        print_info "Removing old version..."
        if command -v gnome-extensions &> /dev/null; then
            gnome-extensions disable "$EXTENSION_NAME" 2>/dev/null || true
        fi
        rm -rf "$INSTALL_DIR/$EXTENSION_NAME"
        print_success "Old version removed"
    fi
    
    verify_source_files
    install_extension
    enable_extension
    print_final_message
}

status() {
    local installed=false
    local enabled=false
    local version=""
    
    if [[ -d "$INSTALL_DIR/$EXTENSION_NAME" ]]; then
        installed=true
        if [[ -f "$INSTALL_DIR/$EXTENSION_NAME/metadata.json" ]]; then
            version=$(grep -oP '"version":\s*\K\d+' "$INSTALL_DIR/$EXTENSION_NAME/metadata.json" 2>/dev/null || echo "")
        fi
    fi
    
    if command -v gnome-extensions &> /dev/null; then
        if gnome-extensions list --enabled 2>/dev/null | grep -qF "$EXTENSION_NAME"; then
            enabled=true
        fi
    fi
    
    echo
    echo "Extension:"
    echo -e "  Installed:  $( [[ "$installed" == "true" ]] && echo -e "${GREEN}Yes${NC}" || echo -e "${RED}No${NC}")"
    echo -e "  Enabled:    $( [[ "$enabled" == "true" ]] && echo -e "${GREEN}Yes${NC}" || echo -e "${YELLOW}No${NC}")"
    echo -e "  Version:    ${version:-N/A}"
    
    echo
    echo "System:"
    echo -e "  GNOME:      $(get_gnome_version)"
    echo -e "  Session:    $(get_session_type)"
    
    if command -v ddcutil &> /dev/null; then
        echo -e "  ddcutil:    $(ddcutil --version 2>/dev/null | head -1 || echo 'installed')"
    else
        echo -e "  ddcutil:    ${YELLOW}Not installed${NC}"
    fi
    
    if lsmod | grep -q '^i2c_dev'; then
        echo -e "  i2c-dev:    ${GREEN}Loaded${NC}"
    else
        echo -e "  i2c-dev:    ${YELLOW}Not loaded${NC}"
    fi
}

main() {
    local command="${1:-install}"
    
    echo -e "${GREEN}=== Brightness & Night Light Sliders ===${NC}"
    echo
    
    ensure_not_root
    
    case "$command" in
        install)
            check_gnome_shell_running
            check_gnome_version
            verify_source_files
            setup_ddcutil || true
            ensure_i2c_module || true
            setup_permissions_if_needed || true
            install_extension
            enable_extension
            print_final_message
            ;;
        update)
            check_gnome_shell_running
            check_gnome_version
            update
            ;;
        uninstall)
            uninstall
            ;;
        setup)
            setup_ddcutil || true
            ensure_i2c_module || true
            setup_permissions_if_needed || true
            ;;
        status)
            status
            ;;
        -h|--help|help)
            usage
            ;;
        *)
            echo "Unknown command: $command"
            usage
            ;;
    esac
}

main "$@"
