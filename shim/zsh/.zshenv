# laex runs zsh with ZDOTDIR pointing here so it can put its `claude` wrapper
# first on PATH *after* your own startup files have run. Hand ZDOTDIR back
# straight away so zsh reads your real .zprofile/.zshrc as usual.
if [[ -n "$LAEX_ORIG_ZDOTDIR" ]]; then ZDOTDIR="$LAEX_ORIG_ZDOTDIR"; else ZDOTDIR="$HOME"; fi
unset LAEX_ORIG_ZDOTDIR
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"

_laex_path() {
  path=("$LAEX_SHIM" ${path:#$LAEX_SHIM})
  precmd_functions=(${precmd_functions:#_laex_path})
}
precmd_functions+=(_laex_path)
