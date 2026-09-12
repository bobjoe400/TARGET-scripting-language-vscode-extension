#!/usr/bin/env bash
# Installs the packaged .vsix into Windows VS Code from WSL.
#
# The copy onto a Windows drive is the point. VS Code on Windows refuses to read the
# package over a \\wsl.localhost\ UNC path - "UNC host 'wsl.localhost' access is not
# allowed" - which is the same restriction TARGET itself has with scripts, and the
# reason the Run command stages a copy.
set -euo pipefail
CMD=/mnt/c/Windows/System32/cmd.exe
[ -x "$CMD" ] || { echo "Not running under WSL with Windows interop."; exit 1; }

vsix=$(ls -t ./*.vsix 2>/dev/null | head -1)
[ -n "$vsix" ] || { echo "No .vsix here. Run: npm run package"; exit 1; }
name=$(basename "$vsix")

win_user=${WIN_USER:-$("$CMD" /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r\n')}
dest="/mnt/c/Users/$win_user"
[ -d "$dest" ] || { echo "No Windows user folder at $dest. Set WIN_USER=<name>."; exit 1; }

cp "$vsix" "$dest/$name"
bat="$dest/__install_vsix.bat"
printf '@echo off\r\n"%%LOCALAPPDATA%%\\Programs\\Microsoft VS Code\\bin\\code.cmd" --install-extension "C:\\Users\\%s\\%s" --force\r\n' \
  "$win_user" "$name" > "$bat"
out=$("$CMD" /c "C:\\Users\\$win_user\\__install_vsix.bat" 2>&1 | tr -d '\r' || true)
rm -f "$bat" "$dest/$name"

echo "$out" | grep -iE 'successfully|error|unable' || { echo "$out" | tail -3; echo "(unrecognised output)"; }

# A copy left in the WSL remote loads alongside the Windows one whenever a window is
# connected to WSL, and VS Code merges both providers' results - every completion item
# twice, every hover twice. It is invisible to `code --list-extensions` on Windows,
# which only lists the local side.
server=~/.vscode-server/extensions
if ls -d "$server"/*target-script* >/dev/null 2>&1; then
  echo
  echo "WARNING: a copy is also installed in the WSL remote:"
  ls -d "$server"/*target-script* | sed 's|.*/|    |'
  echo "  Both load when the window is connected to WSL, and everything appears twice."
  echo "  Remove it, or install there instead of here - not both."
fi
echo
echo "Installed $name. Reload the VS Code window to pick it up:"
echo "  Ctrl+Shift+P -> Developer: Reload Window"
