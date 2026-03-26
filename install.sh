#!/bin/bash

set -euo pipefail

EXTENSION_NAME="brightness-night-light-sliders@MahmoudUwk.github.com"
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
REQUIRED_FILES=("extension.js" "ddcutil.js" "metadata.json" "stylesheet.css")
OPTIONAL_FILES=("LICENSE")

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
  install     Install or reinstall (default)
  uninstall   Remove the extension
  status      Show installation status

EOF
    exit 0
}

ensure_not_root() {
    if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
        die "Do not run as root or with sudo."
    fi
}

check_gnome_extensions_command() {
    command -v gnome-extensions >/dev/null 2>&1
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

get_session_type() {
    if [[ -n "${XDG_SESSION_TYPE:-}" ]]; then
        echo "$XDG_SESSION_TYPE"
    elif [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
        echo "wayland"
    else
        echo "x11"
    fi
}

remove_old_version() {
    if [[ -d "$INSTALL_DIR/$EXTENSION_NAME" ]]; then
        print_info "Removing old version..."
        if check_gnome_extensions_command; then
            gnome-extensions disable "$EXTENSION_NAME" 2>/dev/null || true
        fi
        rm -rf "$INSTALL_DIR/$EXTENSION_NAME"
        print_success "Old version removed"
    fi
}

install_extension() {
    print_info "Installing extension files..."

    mkdir -p "$INSTALL_DIR/$EXTENSION_NAME"

    for file in "${REQUIRED_FILES[@]}" "${OPTIONAL_FILES[@]}"; do
        if [[ -f "$SOURCE_DIR/$file" ]]; then
            cp "$SOURCE_DIR/$file" "$INSTALL_DIR/$EXTENSION_NAME/"
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

    print_warning "Extension not discovered yet; you may need to log out and back in"
    return 1
}

enable_extension() {
    print_info "Enabling extension..."

    if ! check_gnome_extensions_command; then
        print_warning "gnome-extensions command not found; enable it manually after login"
        return 1
    fi

    wait_for_extension_discovery || true

    gnome-extensions disable "$EXTENSION_NAME" 2>/dev/null || true

    if gnome-extensions enable "$EXTENSION_NAME" 2>/dev/null && \
       gnome-extensions list --enabled 2>/dev/null | grep -qF "$EXTENSION_NAME"; then
        print_success "Extension enabled"
        return 0
    fi

    print_warning "Could not auto-enable; log out and back in, then enable it manually"
    return 1
}

print_final_message() {
    echo
    echo -e "${GREEN}=== Done ===${NC}"
    echo
    echo "Notes:"
    echo "  - Brightness requires DDC/CI-compatible external displays"
    echo "  - Night Light follows the GNOME color settings schema"
}

uninstall() {
    print_info "Uninstalling..."

    if check_gnome_extensions_command; then
        gnome-extensions disable "$EXTENSION_NAME" 2>/dev/null || true
    fi

    if [[ -d "$INSTALL_DIR/$EXTENSION_NAME" ]]; then
        rm -rf "$INSTALL_DIR/$EXTENSION_NAME"
        print_success "Extension removed"
    else
        print_warning "Extension not installed"
    fi
}

status() {
    local installed=false
    local enabled=false
    local version=""
    local gnome_ext_status="missing"
    local ddcutil_status="not installed"

    if [[ -d "$INSTALL_DIR/$EXTENSION_NAME" ]]; then
        installed=true
        if [[ -f "$INSTALL_DIR/$EXTENSION_NAME/metadata.json" ]]; then
            version=$(grep -oE '"version"[[:space:]]*:[[:space:]]*[0-9]+' "$INSTALL_DIR/$EXTENSION_NAME/metadata.json" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
        fi
    fi

    if check_gnome_extensions_command; then
        gnome_ext_status="installed"
    fi

    if check_gnome_extensions_command && gnome-extensions list --enabled 2>/dev/null | grep -qF "$EXTENSION_NAME"; then
        enabled=true
    fi

    if command -v ddcutil >/dev/null 2>&1; then
        ddcutil_status=$(ddcutil --version 2>/dev/null | head -1 || echo "installed")
    fi

    echo
    echo "Extension:"
    echo -e "  Installed:  $( [[ "$installed" == "true" ]] && echo -e "${GREEN}Yes${NC}" || echo -e "${RED}No${NC}" )"
    echo -e "  Enabled:    $( [[ "$enabled" == "true" ]] && echo -e "${GREEN}Yes${NC}" || echo -e "${YELLOW}No${NC}" )"
    echo -e "  Version:    ${version:-N/A}"

    echo
    echo "System:"
    echo -e "  Session:    $(get_session_type)"
    echo -e "  gnome-ext:  ${gnome_ext_status}"
    echo -e "  ddcutil:    ${ddcutil_status}"
}

main() {
    local command="${1:-install}"

    echo -e "${GREEN}=== Brightness & Night Light Sliders ===${NC}"
    echo

    if [[ "$SOURCE_DIR" != "$PWD" ]]; then
        print_warning "Run this from the repository root: cd \"$SOURCE_DIR\" && ./install.sh"
    fi

    ensure_not_root

    case "$command" in
        install)
            verify_source_files
            remove_old_version
            install_extension
            enable_extension || true
            print_final_message
            ;;
        uninstall)
            uninstall
            ;;
        status)
            status
            ;;
        -h|--help|help)
            usage
            ;;
        *)
            die "Unknown command: $command"
            ;;
    esac
}

main "$@"
